#!/usr/bin/env node
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const rpId = "voice.stephens.page";
const origin = "https://voice.stephens.page";
const lifetimeMilliseconds = 5 * 60 * 1_000;
const commitPattern = /^[0-9a-f]{40}$/u;
const challengePattern = /^[A-Za-z0-9_-]{43}$/u;
const transports = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

const [command, ...args] = process.argv.slice(2);
if (command === "prepare" && args.length === 5) {
  await prepare(args[0], args[1], args[2], args[3], args[4]);
} else if (
  ["verify-authentication", "verify-enrollment"].includes(command) &&
  args.length === 5
) {
  await verifyAuthorization(
    command === "verify-enrollment" ? "enrollment" : "authentication",
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
  );
} else {
  fail(
    "Usage: deployment-authority-authorization-verifier.mjs prepare <commit> <challenge> <registry> <authentication-database> <pending-registry> | verify-enrollment|verify-authentication <commit> <challenge> <registry-or-pending-registry> <request> <next-registry>",
  );
}

async function prepare(
  commit,
  challengePath,
  registryPath,
  authenticationDatabasePath,
  pendingRegistryPath,
) {
  requireCommit(commit);
  const registry = await readOptionalRegistry(registryPath);
  const challenge = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + lifetimeMilliseconds);
  let kind = "authentication";
  let credentials = registry === undefined ? [] : [registry];
  if (registry === undefined) {
    kind = "enrollment";
    credentials = readAuthenticationCandidates(authenticationDatabasePath);
    await writeJsonAtomically(pendingRegistryPath, {
      credentials,
      version: 1,
    }, 0o600);
    writeCandidateSummary(credentials);
  }
  const record = {
    challenge,
    commit,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    kind,
    options: authenticationOptions(challenge, credentials),
    version: 1,
  };
  await writeFile(challengePath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o640,
  });
  process.stdout.write(`${kind}\t${record.expiresAt}\n`);
}

async function verifyAuthorization(
  expectedKind,
  commit,
  challengePath,
  registryInputPath,
  requestPath,
  registryOutputPath,
) {
  requireCommit(commit);
  const challenge = parseChallenge(await readJson(challengePath));
  const request = parseRequest(await readJson(requestPath));
  const now = Date.now();
  if (
    challenge.commit !== commit ||
    request.commit !== commit ||
    request.challenge !== challenge.challenge ||
    request.createdAt !== challenge.createdAt ||
    request.expiresAt !== challenge.expiresAt ||
    request.kind !== challenge.kind ||
    challenge.kind !== expectedKind ||
    now < Date.parse(challenge.createdAt) ||
    now >= Date.parse(challenge.expiresAt) ||
    Date.parse(challenge.expiresAt) - Date.parse(challenge.createdAt) !==
      lifetimeMilliseconds
  ) {
    fail("Deployment-authority authorization is stale or mismatched");
  }

  if (challenge.kind === "enrollment") {
    if (await pathExists(registryOutputPath)) {
      fail("The next deployment passkey registry already exists");
    }
    const candidateRegistry = await readCandidateRegistry(registryInputPath);
    const registry = selectCredential(
      request.response,
      candidateRegistry.credentials,
    );
    const nextCounter = verifyAuthentication(
      request.response,
      challenge.challenge,
      registry,
    );
    const enrolled = { ...registry, counter: nextCounter };
    await writeJsonAtomically(registryOutputPath, enrolled, 0o600);
    writeAuthorizationDetails(enrolled, {
      approvedCandidates: candidateRegistry.credentials.map(
        ({ credentialId, label, publicKeyFingerprint }) => ({
          credentialId,
          label,
          publicKeyFingerprint,
        }),
      ),
      approvedCandidateSetSha256: candidateRegistry.digest,
    });
    return;
  }

  const registry = await readRequiredRegistry(registryInputPath);
  const nextCounter = verifyAuthentication(
    request.response,
    challenge.challenge,
    registry,
  );
  const updated = {
    ...registry,
    counter: Math.max(nextCounter, registry.counter),
  };
  await writeJsonAtomically(registryOutputPath, updated, 0o600);
  writeAuthorizationDetails(updated);
}

function authenticationOptions(challenge, credentials) {
  return {
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
      type: "public-key",
    })),
    challenge,
    rpId,
    timeout: lifetimeMilliseconds,
    userVerification: "required",
  };
}

function verifyAuthentication(response, expectedChallenge, registry) {
  const parsed = requireCredentialResponse(response);
  if (parsed.id !== registry.credentialId) {
    fail("Fresh Passkey proof used an unregistered credential");
  }
  const clientDataJson = base64url(parsed.response.clientDataJSON);
  const clientData = verifyClientData(
    parsed.response.clientDataJSON,
    "webauthn.get",
    expectedChallenge,
  );
  if (clientData.crossOrigin === true) fail("Cross-origin WebAuthn is forbidden");
  const authenticatorData = base64url(parsed.response.authenticatorData);
  const parsedAuthData = parseAuthenticatorData(authenticatorData);
  if (
    registry.counter !== 0 &&
    parsedAuthData.counter !== 0 &&
    parsedAuthData.counter <= registry.counter
  ) {
    fail("Passkey counter did not advance");
  }
  const signed = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJson).digest(),
  ]);
  const signature = base64url(parsed.response.signature);
  const key = createPublicKey({ format: "jwk", key: registry.publicKeyJwk });
  const digest = registry.algorithm === -8 ? null : "sha256";
  if (!verifySignature(digest, signed, key, signature)) {
    fail("Fresh Passkey signature is invalid");
  }
  return parsedAuthData.counter;
}

function verifyClientData(encoded, expectedType, expectedChallenge) {
  let value;
  try {
    value = JSON.parse(base64url(encoded).toString("utf8"));
  } catch {
    fail("WebAuthn client data is invalid");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    value.type !== expectedType ||
    value.challenge !== expectedChallenge ||
    value.origin !== origin
  ) {
    fail("WebAuthn client data does not match the root challenge");
  }
  return value;
}

function parseAuthenticatorData(value) {
  if (value.length < 37) fail("Authenticator data is too short");
  const expectedRpHash = createHash("sha256").update(rpId).digest();
  if (!timingSafeEqual(value.subarray(0, 32), expectedRpHash)) {
    fail("Passkey relying-party identity is invalid");
  }
  const flags = value[32];
  if ((flags & 0x05) !== 0x05) {
    fail("Passkey user presence and verification are required");
  }
  if ((flags & 0x10) !== 0 && (flags & 0x08) === 0) {
    fail("Passkey backup flags are inconsistent");
  }
  const counter = value.readUInt32BE(33);
  return { counter };
}

function cosePublicKey(encoded) {
  const decoded = decodeCbor(encoded);
  if (!(decoded.value instanceof Map) || decoded.offset !== encoded.length) {
    fail("Passkey public key is invalid");
  }
  const key = decoded.value;
  const type = key.get(1);
  const algorithm = key.get(3);
  if (type === 2 && algorithm === -7 && key.get(-1) === 1) {
    return {
      algorithm,
      jwk: {
        crv: "P-256",
        kty: "EC",
        x: requireBytes(key.get(-2), "EC x coordinate").toString("base64url"),
        y: requireBytes(key.get(-3), "EC y coordinate").toString("base64url"),
      },
    };
  }
  if (type === 3 && algorithm === -257) {
    return {
      algorithm,
      jwk: {
        e: requireBytes(key.get(-2), "RSA exponent").toString("base64url"),
        kty: "RSA",
        n: requireBytes(key.get(-1), "RSA modulus").toString("base64url"),
      },
    };
  }
  if (type === 1 && algorithm === -8 && key.get(-1) === 6) {
    return {
      algorithm,
      jwk: {
        crv: "Ed25519",
        kty: "OKP",
        x: requireBytes(key.get(-2), "Ed25519 public key").toString("base64url"),
      },
    };
  }
  fail("Passkey public-key algorithm is unsupported");
}

function readAuthenticationCandidates(path) {
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare(`
      SELECT revision, state_json
      FROM authentication_state
      WHERE owner = 1
    `).get();
    if (
      row === undefined ||
      !Number.isInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.state_json !== "string"
    ) {
      fail("The existing owner authentication registration is unavailable");
    }
    const state = JSON.parse(row.state_json);
    if (
      state === null ||
      typeof state !== "object" ||
      state.bootstrapPermanentlyDisabled !== true ||
      typeof state.ownerUserId !== "string" ||
      state.ownerUserId.length === 0 ||
      !Array.isArray(state.passkeys) ||
      state.passkeys.length < 2 ||
      state.passkeys.length > 20 ||
      !Array.isArray(state.recoveryCodeVerifiers) ||
      state.recoveryCodeVerifiers.length === 0
    ) {
      fail("The existing owner authentication registration is incomplete");
    }
    const candidates = state.passkeys.map((passkey) => {
      if (
        passkey === null ||
        typeof passkey !== "object" ||
        typeof passkey.label !== "string" ||
        passkey.label.length === 0 ||
        passkey.label.length > 80 ||
        /[\u0000-\u001f\u007f]/u.test(passkey.label) ||
        typeof passkey.credentialId !== "string" ||
        typeof passkey.publicKey !== "string" ||
        !Number.isInteger(passkey.counter) ||
        passkey.counter < 0 ||
        !Array.isArray(passkey.transports)
      ) {
        fail("An existing owner passkey registration is invalid");
      }
      const encodedPublicKey = base64url(passkey.publicKey);
      const publicKey = cosePublicKey(encodedPublicKey);
      return parseRegistry({
        algorithm: publicKey.algorithm,
        counter: passkey.counter,
        credentialId: base64url(passkey.credentialId).toString("base64url"),
        label: passkey.label,
        publicKeyFingerprint: createHash("sha256")
          .update(encodedPublicKey)
          .digest("hex"),
        publicKeyJwk: publicKey.jwk,
        transports: passkey.transports.filter((value) => transports.has(value)),
        version: 1,
      });
    });
    if (new Set(candidates.map(({ credentialId }) => credentialId)).size !==
      candidates.length) {
      fail("Existing owner passkey registrations contain duplicate credentials");
    }
    return candidates;
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail("The existing owner authentication registration is invalid JSON");
    }
    throw error;
  } finally {
    database?.close();
  }
}

function writeCandidateSummary(credentials) {
  process.stdout.write(
    "Existing owner passkeys awaiting attended root approval:\n",
  );
  credentials.forEach((credential, index) => {
    process.stdout.write(
      `${index + 1}. ${credential.label}  credential=${credential.credentialId}  public-key-sha256=${credential.publicKeyFingerprint}\n`,
    );
  });
}

function selectCredential(response, candidates) {
  const parsed = requireCredentialResponse(response);
  const selected = candidates.find(({ credentialId }) =>
    credentialId === parsed.id
  );
  if (selected === undefined) {
    fail("Fresh Passkey proof did not use an approved enrollment candidate");
  }
  return selected;
}

function writeAuthorizationDetails(registry, additional = {}) {
  const serializedRegistry = `${JSON.stringify(registry)}\n`;
  process.stdout.write(`${JSON.stringify({
    ...additional,
    registry,
    registrySha256: createHash("sha256")
      .update(serializedRegistry)
      .digest("hex"),
  })}\n`);
}

function decodeCbor(input, start = 0) {
  const value = Buffer.from(input);
  const decoded = decodeCborItem(value, start);
  return { ...decoded, length: value.length };
}

function decodeCborItem(input, offset) {
  if (offset >= input.length) fail("CBOR data is truncated");
  const initial = input[offset];
  const major = initial >> 5;
  const additional = initial & 0x1f;
  const length = cborLength(input, offset + 1, additional);
  let cursor = length.offset;
  if (major === 0) return { offset: cursor, value: length.value };
  if (major === 1) return { offset: cursor, value: -1 - length.value };
  if (major === 2 || major === 3) {
    const end = cursor + length.value;
    if (end > input.length) fail("CBOR string is truncated");
    const bytes = input.subarray(cursor, end);
    return { offset: end, value: major === 2 ? bytes : bytes.toString("utf8") };
  }
  if (major === 4) {
    const items = [];
    for (let index = 0; index < length.value; index += 1) {
      const item = decodeCborItem(input, cursor);
      items.push(item.value);
      cursor = item.offset;
    }
    return { offset: cursor, value: items };
  }
  if (major === 5) {
    const map = new Map();
    for (let index = 0; index < length.value; index += 1) {
      const key = decodeCborItem(input, cursor);
      const item = decodeCborItem(input, key.offset);
      map.set(key.value, item.value);
      cursor = item.offset;
    }
    return { offset: cursor, value: map };
  }
  if (major === 6) return decodeCborItem(input, cursor);
  if (major === 7 && additional === 20) return { offset: offset + 1, value: false };
  if (major === 7 && additional === 21) return { offset: offset + 1, value: true };
  if (major === 7 && additional === 22) return { offset: offset + 1, value: null };
  fail("Unsupported CBOR value");
}

function cborLength(input, offset, additional) {
  if (additional < 24) return { offset, value: additional };
  if (additional === 24) return readCborInteger(input, offset, 1);
  if (additional === 25) return readCborInteger(input, offset, 2);
  if (additional === 26) return readCborInteger(input, offset, 4);
  if (additional === 27) return readCborInteger(input, offset, 8);
  fail("Indefinite or reserved CBOR lengths are forbidden");
}

function readCborInteger(input, offset, bytes) {
  if (offset + bytes > input.length) fail("CBOR integer is truncated");
  const value = bytes === 8
    ? Number(input.readBigUInt64BE(offset))
    : input.readUIntBE(offset, bytes);
  if (!Number.isSafeInteger(value)) fail("CBOR integer is too large");
  return { offset: offset + bytes, value };
}

function parseChallenge(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !commitPattern.test(value.commit) ||
    !challengePattern.test(value.challenge) ||
    !["authentication", "enrollment"].includes(value.kind) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.expiresAt) ||
    value.options === null ||
    typeof value.options !== "object" ||
    value.options.challenge !== value.challenge
  ) {
    fail("Deployment-authority challenge is invalid");
  }
  return value;
}

function parseRequest(value) {
  const challenge = parseChallenge(value);
  if (!("response" in value)) fail("Fresh Passkey proof is missing");
  return challenge;
}

function parseRegistry(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    ![-257, -8, -7].includes(value.algorithm) ||
    !Number.isInteger(value.counter) ||
    value.counter < 0 ||
    typeof value.credentialId !== "string" ||
    value.credentialId.length === 0 ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    value.label.length > 80 ||
    typeof value.publicKeyFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.publicKeyFingerprint) ||
    value.publicKeyJwk === null ||
    typeof value.publicKeyJwk !== "object" ||
    !Array.isArray(value.transports) ||
    value.transports.some((transport) => !transports.has(transport))
  ) {
    fail("Root-owned deployment passkey registry is invalid");
  }
  try {
    createPublicKey({ format: "jwk", key: value.publicKeyJwk });
  } catch {
    fail("Root-owned deployment passkey public key is invalid");
  }
  return value;
}

async function readCandidateRegistry(path) {
  const contents = await readFile(path, "utf8");
  const value = JSON.parse(contents);
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !Array.isArray(value.credentials) ||
    value.credentials.length < 2 ||
    value.credentials.length > 20
  ) {
    fail("Pending deployment passkey candidates are invalid");
  }
  const credentials = value.credentials.map(parseRegistry);
  if (new Set(credentials.map(({ credentialId }) => credentialId)).size !==
    credentials.length) {
    fail("Pending deployment passkey candidates contain duplicates");
  }
  return {
    credentials,
    digest: createHash("sha256").update(contents).digest("hex"),
  };
}

function requireCredentialResponse(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    value.type !== "public-key" ||
    value.response === null ||
    typeof value.response !== "object" ||
    typeof value.response.clientDataJSON !== "string"
  ) {
    fail("Fresh Passkey response is invalid");
  }
  return value;
}

async function readOptionalRegistry(path) {
  try {
    return parseRegistry(await readJson(path));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRequiredRegistry(path) {
  return parseRegistry(await readJson(path));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomically(path, value, mode) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode,
  });
  await rename(temporary, path);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function base64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail("WebAuthn base64url value is invalid");
  }
  return Buffer.from(value, "base64url");
}

function requireBytes(value, label) {
  if (!Buffer.isBuffer(value) || value.length === 0) fail(`${label} is missing`);
  return value;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function requireCommit(value) {
  if (!commitPattern.test(value ?? "")) fail("Release commit is invalid");
}

function fail(message) {
  throw new Error(message);
}
