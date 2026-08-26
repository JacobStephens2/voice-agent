import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

/**
 * The Keeplore programs the attended upgrade installs as root authority. The
 * publisher's journal writers and the promoter that reads the registration's
 * appearance-verification setting all have to move together; a host holding a
 * mixed set refuses or skips work with no obvious cause.
 */
const keeploreAuthorityTools = [
  "collect-keeplore-repository-policy.sh",
  "keeplore-config.sh",
  "promote-keeplore-release.sh",
  "record-keeplore-bypass-attestation.sh",
  "repromote-keeplore-merge.sh",
  "resolve-keeplore-worktree.sh",
] as const;

test("release immutability accepts internal package symlinks but rejects mutable content and escaping links", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-agent-immutable-release-"));
  temporaryDirectories.push(root);
  const release = join(root, "release");
  const packageDirectory = join(
    release,
    "node_modules/.pnpm/example@1.0.0/node_modules/example",
  );
  const applicationModules = join(release, "apps/api/node_modules");
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(applicationModules, { recursive: true }),
  ]);
  const packageFile = join(packageDirectory, "index.js");
  await writeFile(packageFile, "export {};\n");
  await symlink(
    "../../../node_modules/.pnpm/example@1.0.0/node_modules/example",
    join(applicationModules, "example"),
  );
  const verifier = join(
    repositoryRoot,
    "ops/release/release-immutability.sh",
  );
  const verify = () =>
    execFileAsync("bash", [
      "-c",
      'source "$1"; voice_agent_release_tree_is_immutable "$2"',
      "release-immutability-test",
      verifier,
      release,
    ]);

  await expect(verify()).resolves.toBeDefined();

  await chmod(packageFile, 0o664);
  await expect(verify()).rejects.toBeDefined();
  await chmod(packageFile, 0o644);

  await symlink(root, join(applicationModules, "escaping"));
  await expect(verify()).rejects.toBeDefined();

  const [wizard, helper] = await Promise.all([
    readFile(
      join(repositoryRoot, "ops/upgrade-agent-host-deployment-authority.sh"),
      "utf8",
    ),
    readFile(
      join(repositoryRoot, "ops/release/upgrade-deployment-authority.sh"),
      "utf8",
    ),
  ]);
  expect(wizard).toContain(
    'voice_agent_release_tree_is_immutable "$REPOSITORY_ROOT"',
  );
  expect(helper).toContain('voice_agent_release_tree_is_immutable "$release"');
});

test("an attended upgrade installs the Keeplore policy tools the pinned publisher reads", async () => {
  const fixture = await deploymentAuthorityFixture();

  await execFileAsync(fixture.upgrader, ["--activate", fixture.commit], {
    env: {
      ...process.env,
      VOICE_AGENT_AUTHORITY_TEST_ROOT: fixture.root,
    },
  });

  // The publisher re-derives its authority from the journal these two write.
  // A host that upgraded the publisher while leaving them behind refused every
  // publication with an unlogged 422 for three days.
  for (const tool of keeploreAuthorityTools) {
    await expect(
      readFile(join(fixture.keeploreTools, tool), "utf8"),
    ).resolves.toContain(`reviewed ${tool}`);
  }
});

test("a failed attended upgrade restores the previous Keeplore policy tools", async () => {
  const fixture = await deploymentAuthorityFixture();
  const collector = join(
    fixture.keeploreTools,
    "collect-keeplore-repository-policy.sh",
  );
  await mkdir(fixture.keeploreTools, { recursive: true });
  await writeFile(collector, "#!/usr/bin/env bash\nprintf 'pinned\\n'\n");
  // The reviewed promoter runs after the tools are installed; failing it is how
  // this fixture reaches the rollback path with everything already swapped.
  await writeFile(
    join(fixture.root, "opt/voice-agent/releases", fixture.commit, "ops/release/promote-release.sh"),
    "#!/usr/bin/env bash\nexit 1\n",
  );

  await expect(
    execFileAsync(fixture.upgrader, ["--activate", fixture.commit], {
      env: {
        ...process.env,
        VOICE_AGENT_AUTHORITY_TEST_ROOT: fixture.root,
      },
    }),
  ).rejects.toThrow();

  await expect(readFile(collector, "utf8")).resolves.toContain("pinned");
});

test("an attended upgrade activates reviewed Subagent authority from existing pre-Subagent pins", async () => {
  const fixture = await deploymentAuthorityFixture();

  await execFileAsync(fixture.upgrader, ["--activate", fixture.commit], {
    env: {
      ...process.env,
      VOICE_AGENT_AUTHORITY_TEST_ROOT: fixture.root,
    },
  });

  await expect(
    readFile(join(fixture.authority, "promote-release.sh"), "utf8"),
  ).resolves.toBe(fixture.reviewedPromoter);
  await expect(
    readFile(
      join(
        fixture.authority,
        "systemd/voice-agent-subagent.service",
      ),
      "utf8",
    ),
  ).resolves.toBe(fixture.reviewedSubagentUnit);
  await expect(
    readFile(
      join(
        fixture.authority,
        "systemd/voice-agent-keeplore-publisher.service",
      ),
      "utf8",
    ),
  ).resolves.toContain("voice-agent-keeplore-publisher.service");
  await expect(
    readFile(
      join(fixture.authority, "keeplore-github-app-publisher.ts"),
      "utf8",
    ),
  ).resolves.toBe("export {};\n");
  await expect(
    readFile(
      join(
        fixture.authority,
        "apparmor/bwrap-userns-restrict",
      ),
      "utf8",
    ),
  ).resolves.toBe(fixture.reviewedBwrapProfile);
  await expect(
    readFile(
      join(
        fixture.root,
        "etc/apparmor.d/bwrap-userns-restrict",
      ),
      "utf8",
    ),
  ).resolves.toBe(fixture.reviewedBwrapProfile);
  await expect(
    readFile(
      join(
        fixture.root,
        "var/lib/voice-agent-deployment-authority/activated",
      ),
      "utf8",
    ),
  ).resolves.toBe(`${fixture.commit}\n`);
  await expect(
    readFile(join(fixture.authorityState, "current"), "utf8"),
  ).resolves.toBe(`${fixture.commit}\n`);
  await expect(
    readFile(
      join(fixture.authority, "deployment-authority-authorization-verifier.mjs"),
      "utf8",
    ),
  ).resolves.toContain("fixture only verifies");
  await expect(
    readFile(join(fixture.authority, "legacy-authority.sh"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(fixture.authorizationRequest, "utf8")).rejects.toMatchObject(
    { code: "ENOENT" },
  );
  const backups = await readdir(join(fixture.authorityState, "backups"));
  expect(backups).toHaveLength(1);
  await expect(
    readFile(
      join(
        fixture.authorityState,
        "backups",
        backups[0] ?? "missing",
        "legacy-authority.sh",
      ),
      "utf8",
    ),
  ).resolves.toContain("legacy authority");
  const events = (await readFile(join(fixture.authorityState, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly type: string });
  expect(events.map((event) => event.type)).toEqual([
    "deployment-authority-upgrade-authorized",
    "deployment-authority-upgrade-activated",
  ]);
});

test("the attended prepare stage states the remaining challenge lifetime in relative terms", async () => {
  const fixture = await deploymentAuthorityFixture();
  const releaseScripts = join(
    fixture.root,
    "opt/voice-agent/releases",
    fixture.commit,
    "ops/release",
  );
  await copyFile(
    join(repositoryRoot, "ops/release/deployment-authority-authorization-verifier.mjs"),
    join(releaseScripts, "deployment-authority-authorization-verifier.mjs"),
  );
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeFile(
    join(fixture.authorityState, "authorization-credentials.json"),
    `${JSON.stringify(registryForKey(Buffer.from("owner-passkey"), publicKey, "Owner passkey"))}\n`,
  );

  const { stdout } = await execFileAsync(
    fixture.upgrader,
    ["--prepare", fixture.commit],
    { env: { ...process.env, VOICE_AGENT_AUTHORITY_TEST_ROOT: fixture.root } },
  );

  expect(stdout).toMatch(/about 5 minutes from now/u);
  expect(stdout).toMatch(/It expires at \d{2}:\d{2}:\d{2} UTC/u);
  // The machine-shaped instant belongs to the verifier, not to the owner.
  expect(stdout).not.toMatch(/^authentication\t/mu);
});

test("rollback restores the event-derived current projection after publication", async () => {
  const fixture = await deploymentAuthorityFixture({ oldPromoterSucceeds: true });
  const activeProfile = join(
    fixture.root,
    "etc/apparmor.d/bwrap-userns-restrict",
  );
  const previousProfile = "profile previous_bwrap /usr/bin/bwrap {}\n";
  await writeFile(activeProfile, previousProfile);

  await expect(
    execFileAsync(fixture.upgrader, ["--activate", fixture.commit], {
      env: {
        ...process.env,
        VOICE_AGENT_AUTHORITY_TEST_FAIL_AFTER_CURRENT: "1",
        VOICE_AGENT_AUTHORITY_TEST_ROOT: fixture.root,
      },
    }),
  ).rejects.toBeDefined();

  await expect(
    readFile(join(fixture.authorityState, "current"), "utf8"),
  ).resolves.toBe(`${fixture.previousCommit}\n`);
  await expect(readFile(activeProfile, "utf8")).resolves.toBe(previousProfile);
  const events = (await readFile(join(fixture.authorityState, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly type: string });
  expect(events.map((event) => event.type)).toEqual([
    "deployment-authority-upgrade-authorized",
    "deployment-authority-upgrade-activated",
    "deployment-authority-upgrade-rolled-back",
  ]);
});

test("an authority upgrade restores the prior pin when its durable backup cannot be created", async () => {
  const fixture = await deploymentAuthorityFixture({ oldPromoterSucceeds: true });
  await chmod(join(fixture.authorityState, "backups"), 0o500);

  await expect(
    execFileAsync(fixture.upgrader, ["--activate", fixture.commit], {
      env: {
        ...process.env,
        VOICE_AGENT_AUTHORITY_TEST_ROOT: fixture.root,
      },
    }),
  ).rejects.toBeDefined();

  await expect(
    readFile(join(fixture.authority, "promote-release.sh"), "utf8"),
  ).resolves.toBe(fixture.oldPromoter);
  const events = (await readFile(join(fixture.authorityState, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly type: string });
  expect(events.map((event) => event.type)).toEqual([
    "deployment-authority-upgrade-authorized",
    "deployment-authority-upgrade-rolled-back",
  ]);
});

test("first enrollment never publishes a root credential before its evidence event", async () => {
  const fixture = await deploymentAuthorityFixture();
  const credentials = join(
    fixture.authorityState,
    "authorization-credentials.json",
  );
  const candidates = join(
    fixture.authorityState,
    "authorization-credentials.pending.json",
  );
  const challengePath = join(
    fixture.root,
    "var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.challenge",
  );
  const eventsPath = join(fixture.authorityState, "events.jsonl");
  await rm(credentials);
  await writeFile(candidates, `${JSON.stringify({ version: 1 })}\n`);
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 4 * 60 * 1_000).toISOString();
  const challenge = {
    challenge: "c".repeat(43),
    commit: fixture.commit,
    createdAt,
    expiresAt,
    kind: "enrollment",
    options: { challenge: "c".repeat(43) },
    version: 1,
  };
  await writeFile(challengePath, `${JSON.stringify(challenge)}\n`);
  await writeFile(
    fixture.authorizationRequest,
    `${JSON.stringify({
      ...challenge,
      response: { id: "existing-owner-passkey" },
    })}\n`,
  );
  await writeFile(eventsPath, "");
  await chmod(eventsPath, 0o400);

  await expect(
    execFileAsync(fixture.upgrader, ["--enroll", fixture.commit], {
      env: {
        ...process.env,
        VOICE_AGENT_AUTHORITY_TEST_ROOT: fixture.root,
      },
    }),
  ).rejects.toBeDefined();

  await expect(readFile(credentials, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a plaintext Release request cannot replace the root challenge's WebAuthn proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-agent-authority-proof-"));
  temporaryDirectories.push(root);
  const challengePath = join(root, "challenge.json");
  const registryPath = join(root, "credentials.json");
  const nextRegistryPath = join(root, "credentials.next.json");
  const requestPath = join(root, "request.json");
  const commit = "d".repeat(40);
  const cli = join(
    repositoryRoot,
    "ops/release/deployment-authority-authorization-verifier.mjs",
  );
  const verifierSource = await readFile(cli, "utf8");
  expect(verifierSource).not.toMatch(/from ["'](?!node:)/u);
  expect(verifierSource).not.toContain("@voice-agent/");
  const credentialId = Buffer.from("existing-owner-passkey");
  const { publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  await writeFile(
    registryPath,
    `${JSON.stringify(registryForKey(credentialId, publicKey, "Owner passkey"))}\n`,
  );
  await execFileAsync(process.execPath, [
    cli,
    "prepare",
    commit,
    challengePath,
    registryPath,
    join(root, "unused.sqlite"),
    join(root, "unused-pending.json"),
  ]);
  const challenge = JSON.parse(await readFile(challengePath, "utf8")) as {
    readonly challenge: string;
    readonly commit: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly version: number;
  };
  expect(Date.parse(challenge.expiresAt) - Date.parse(challenge.createdAt)).toBe(
    5 * 60 * 1_000,
  );
  await writeFile(
    requestPath,
    `${JSON.stringify({ ...challenge, response: { id: "first" } })}\n`,
  );
  await expect(
    execFileAsync(process.execPath, [
      cli,
      "verify-authentication",
      commit,
      challengePath,
      registryPath,
      requestPath,
      nextRegistryPath,
    ]),
  ).rejects.toBeDefined();
});

test("the root verifier enrolls only a signing credential from completed owner registration candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-agent-root-passkey-"));
  temporaryDirectories.push(root);
  const challengePath = join(root, "challenge.json");
  const registryPath = join(root, "credentials.json");
  const pendingRegistryPath = join(root, "credentials.pending.json");
  const nextRegistryPath = join(root, "credentials.next.json");
  const requestPath = join(root, "request.json");
  const authenticationDatabasePath = join(root, "voice-agent.sqlite");
  const commit = "e".repeat(40);
  const verifier = join(
    repositoryRoot,
    "ops/release/deployment-authority-authorization-verifier.mjs",
  );
  const credentialId = Buffer.from("root-deployment-passkey");
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const secondCredentialId = Buffer.from("backup-owner-passkey");
  const secondKeyPair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const database = new DatabaseSync(authenticationDatabasePath);
  database.exec(`
    CREATE TABLE authentication_state (
      owner INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL
    )
  `);
  database.prepare(`
    INSERT INTO authentication_state (owner, revision, state_json)
    VALUES (1, 7, ?)
  `).run(JSON.stringify({
    bootstrapPermanentlyDisabled: true,
    ownerUserId: "owner",
    passkeys: [
      storedPasskey(credentialId, publicKey, "Laptop passkey"),
      storedPasskey(
        secondCredentialId,
        secondKeyPair.publicKey,
        "Backup passkey",
      ),
    ],
    recoveryCodeVerifiers: ["offline-recovery-verifier"],
  }));
  database.close();

  await execFileAsync(process.execPath, [
    verifier,
    "prepare",
    commit,
    challengePath,
    registryPath,
    authenticationDatabasePath,
    pendingRegistryPath,
  ]);
  const enrollmentChallenge = JSON.parse(
    await readFile(challengePath, "utf8"),
  ) as AuthorityChallenge;
  expect(enrollmentChallenge.kind).toBe("enrollment");
  await writeFile(
    requestPath,
    `${JSON.stringify({
      ...enrollmentChallenge,
      response: authenticationResponse(
        enrollmentChallenge.challenge,
        credentialId,
        privateKey,
      ),
    })}\n`,
  );
  const enrollmentVerification = await execFileAsync(process.execPath, [
    verifier,
    "verify-enrollment",
    commit,
    challengePath,
    pendingRegistryPath,
    requestPath,
    nextRegistryPath,
  ]);
  const enrollmentDetails = JSON.parse(enrollmentVerification.stdout) as {
    readonly approvedCandidates: readonly {
      readonly credentialId: string;
      readonly label: string;
      readonly publicKeyFingerprint: string;
    }[];
    readonly approvedCandidateSetSha256: string;
    readonly registry: { readonly credentialId: string };
    readonly registrySha256: string;
  };
  expect(enrollmentDetails).toMatchObject({
    approvedCandidates: [
      {
        credentialId: credentialId.toString("base64url"),
        label: "Laptop passkey",
      },
      {
        credentialId: secondCredentialId.toString("base64url"),
        label: "Backup passkey",
      },
    ],
    registry: { credentialId: credentialId.toString("base64url") },
  });
  expect(enrollmentDetails.approvedCandidateSetSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(enrollmentDetails.registrySha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    enrollmentDetails.approvedCandidates.every((candidate) =>
      /^[0-9a-f]{64}$/u.test(candidate.publicKeyFingerprint)
    ),
  ).toBe(true);
  await expect(readFile(registryPath, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  const enrolled = JSON.parse(await readFile(nextRegistryPath, "utf8")) as {
    readonly counter: number;
    readonly credentialId: string;
    readonly label: string;
  };
  expect(enrolled).toMatchObject({
    counter: 1,
    credentialId: credentialId.toString("base64url"),
    label: "Laptop passkey",
  });

  await Promise.all([rm(challengePath), rm(requestPath)]);
  await rename(nextRegistryPath, registryPath);
  await execFileAsync(process.execPath, [
    verifier,
    "prepare",
    commit,
    challengePath,
    registryPath,
    authenticationDatabasePath,
    pendingRegistryPath,
  ]);
  const authenticationChallenge = JSON.parse(
    await readFile(challengePath, "utf8"),
  ) as AuthorityChallenge;
  expect(authenticationChallenge.kind).toBe("authentication");
  await writeFile(
    requestPath,
    `${JSON.stringify({
      ...authenticationChallenge,
      response: authenticationResponse(
        authenticationChallenge.challenge,
        credentialId,
        privateKey,
        2,
      ),
    })}\n`,
  );
  await execFileAsync(process.execPath, [
    verifier,
    "verify-authentication",
    commit,
    challengePath,
    registryPath,
    requestPath,
    nextRegistryPath,
  ]);
  await expect(readFile(nextRegistryPath, "utf8")).resolves.toContain(
    '"counter":2',
  );
});

async function deploymentAuthorityFixture(options?: {
  readonly oldPromoterSucceeds?: boolean;
}): Promise<{
  readonly authority: string;
  readonly authorityState: string;
  readonly authorizationRequest: string;
  readonly commit: string;
  readonly keeploreTools: string;
  readonly oldPromoter: string;
  readonly previousCommit: string;
  readonly reviewedBwrapProfile: string;
  readonly reviewedPromoter: string;
  readonly reviewedSubagentUnit: string;
  readonly root: string;
  readonly upgrader: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "voice-agent-authority-upgrade-"));
  temporaryDirectories.push(root);
  const commit = "a".repeat(40);
  const previousCommit = "9".repeat(40);
  const release = join(root, "opt/voice-agent/releases", commit);
  const authority = join(root, "usr/local/libexec/voice-agent");
  const releaseScripts = join(release, "ops/release");
  const releaseUnits = join(release, "ops/systemd");
  const releaseAppArmor = join(release, "ops/apparmor");
  const promotionState = join(root, "var/lib/voice-agent-promotions");
  const authorityState = join(
    root,
    "var/lib/voice-agent-deployment-authority",
  );
  await Promise.all(
    [
      releaseScripts,
      releaseUnits,
      releaseAppArmor,
      join(release, "ops/prometheus"),
      join(release, "ops/grafana"),
      join(release, "ops/keeplore"),
      join(root, "opt/voice-agent"),
      join(root, "etc/voice-agent"),
      join(root, "etc/apparmor.d"),
      join(authority, "systemd"),
      promotionState,
      join(authorityState, "backups"),
      join(root, "var/lib/voice-agent-promotion-resume"),
    ].map((directory) => mkdir(directory, { recursive: true })),
  );

  await writeFile(join(release, ".voice-agent-release"), `${commit}\n`);
  await writeFile(
    join(root, "etc/voice-agent/promotion-repository"),
    "/srv/voice-agent\n",
  );
  const authorizationRequest = join(
    root,
    "var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.request",
  );
  const authorizationChallenge = join(
    root,
    "var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.challenge",
  );
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 4 * 60 * 1_000).toISOString();
  const challenge = "c".repeat(43);
  const authorization = {
    challenge,
    commit,
    createdAt,
    expiresAt,
    kind: "authentication",
    options: { challenge },
    response: { id: "fixture-passkey" },
    version: 1,
  };
  await writeFile(authorizationRequest, `${JSON.stringify(authorization)}\n`);
  await writeFile(
    authorizationChallenge,
    `${JSON.stringify({ challenge, commit, createdAt, expiresAt, kind: "authentication", options: { challenge }, version: 1 })}\n`,
  );
  await writeFile(
    join(authorityState, "authorization-credentials.json"),
    `${JSON.stringify({ passkeys: [{ credentialId: "fixture-passkey" }], version: 1 })}\n`,
  );
  await writeFile(
    join(releaseScripts, "deployment-authority-authorization-verifier.mjs"),
    `import { readFile, writeFile } from "node:fs/promises";
const [command, commit, challengePath, registryPath, requestPath, outputPath] = process.argv.slice(2);
if (!["verify-authentication", "verify-enrollment"].includes(command)) throw new Error("fixture only verifies");
const challenge = JSON.parse(await readFile(challengePath ?? "", "utf8"));
const request = JSON.parse(await readFile(requestPath ?? "", "utf8"));
if (request.commit !== commit || request.challenge !== challenge.challenge || Date.parse(request.expiresAt) <= Date.now()) throw new Error("invalid fixture authorization");
await writeFile(outputPath ?? "", await readFile(registryPath ?? "", "utf8"));
process.stdout.write("{}\\n");
`,
  );
  await writeFile(
    join(releaseScripts, "keeplore-github-app-publisher.ts"),
    "export {};\n",
  );
  for (const tool of keeploreAuthorityTools) {
    await writeExecutable(
      join(release, "ops/keeplore", tool),
      `#!/usr/bin/env bash\nprintf 'reviewed ${tool}\\n'\n`,
    );
  }
  await symlink(release, join(root, "opt/voice-agent/current"));
  await writeFile(
    join(promotionState, "state.tsv"),
    `0\tclosed\t-\t${commit}\n`,
  );
  await writeFile(
    join(promotionState, "verified-human-merges.tsv"),
    `${"b".repeat(40)}\t${commit}\n`,
  );
  await writeFile(join(authorityState, "current"), `${previousCommit}\n`);

  const scripts = [
    "candidate-preflight.sh",
    "deployment-authority-drift.sh",
    "deployment-authority-manifest.sh",
    "deployment-health.sh",
    "git-credential-github-app.sh",
    "github-source-token.sh",
    "install-release.sh",
    "promote-main.sh",
    "promotion-state.sh",
    "record-promotion-failure.sh",
    "release-immutability.sh",
    "resume-promotion.sh",
    "rollback-release.sh",
    "upgrade-deployment-authority.sh",
    "verify-human-merge.sh",
  ];
  for (const script of scripts) {
    await writeExecutable(
      join(releaseScripts, script),
      `#!/usr/bin/env bash\nprintf 'reviewed ${script}\\n'\n`,
    );
  }
  const realReleaseScripts = [
    "deployment-authority-manifest.sh",
    "release-immutability.sh",
    "upgrade-deployment-authority.sh",
  ];
  await Promise.all(
    realReleaseScripts.map((script) =>
      copyFile(
        join(repositoryRoot, "ops/release", script),
        join(releaseScripts, script),
      )
    ),
  );
  await Promise.all(
    realReleaseScripts.map((script) =>
      chmod(join(releaseScripts, script), 0o755)
    ),
  );

  const reviewedPromoter = `#!/usr/bin/env bash
set -euo pipefail
test -f "$VOICE_AGENT_AUTHORITY_TEST_ROOT/var/lib/voice-agent-deployment-authority/provisioned"
test -f "$VOICE_AGENT_AUTHORITY_TEST_ROOT/usr/local/libexec/voice-agent/systemd/voice-agent-subagent.service"
test -f "$VOICE_AGENT_AUTHORITY_TEST_ROOT/usr/local/libexec/voice-agent/apparmor/bwrap-userns-restrict"
test -f "$VOICE_AGENT_AUTHORITY_TEST_ROOT/etc/apparmor.d/bwrap-userns-restrict"
printf '%s\\n' "$1" > "$VOICE_AGENT_AUTHORITY_TEST_ROOT/var/lib/voice-agent-deployment-authority/activated"
`;
  await writeExecutable(
    join(releaseScripts, "promote-release.sh"),
    reviewedPromoter,
  );
  await writeExecutable(
    join(authority, "legacy-authority.sh"),
    "#!/usr/bin/env bash\nprintf 'legacy authority\\n'\n",
  );
  await writeExecutable(
    join(releaseScripts, "install-release.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
test "$1" = /srv/voice-agent
test "$2" = ${commit}
printf 'provisioned\\n' > "$VOICE_AGENT_AUTHORITY_TEST_ROOT/var/lib/voice-agent-deployment-authority/provisioned"
`,
  );
  const oldPromoter = options?.oldPromoterSucceeds === true
    ? `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" > "$VOICE_AGENT_AUTHORITY_TEST_ROOT/var/lib/voice-agent-deployment-authority/rollback-activated"
`
    : "#!/usr/bin/env bash\nprintf 'old promoter must not run\\n' >&2\nexit 1\n";
  await writeExecutable(join(authority, "promote-release.sh"), oldPromoter);

  const units = [
    "voice-agent-api.service",
    "voice-agent-broker.service",
    "voice-agent-probes.service",
    "voice-agent-probes.timer",
    "voice-agent-promotion-resume.path",
    "voice-agent-promotion-resume.service",
    "voice-agent-keeplore-publisher.service",
    "voice-agent-subagent.service",
    "voice-agent-worker.service",
  ];
  const reviewedSubagentUnit = "[Service]\nUser=voice-codex\n";
  const reviewedBwrapProfile = "profile bwrap /usr/bin/bwrap { userns, }\n";
  for (const unit of units) {
    await writeFile(
      join(releaseUnits, unit),
      unit === "voice-agent-subagent.service"
        ? reviewedSubagentUnit
        : `[Unit]\nDescription=reviewed ${unit}\n`,
    );
  }
  await writeFile(
    join(releaseAppArmor, "bwrap-userns-restrict"),
    reviewedBwrapProfile,
  );
  await writeFile(
    join(authority, "systemd/voice-agent-api.service"),
    "[Unit]\nDescription=pre-Subagent API\n",
  );
  await writeExecutable(
    join(release, "ops/prometheus/install-scrape.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  await writeExecutable(
    join(release, "ops/grafana/install-dashboard.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );

  return {
    authority,
    authorityState,
    authorizationRequest,
    commit,
    keeploreTools: join(root, "usr/local/libexec/keeplore"),
    oldPromoter,
    previousCommit,
    reviewedBwrapProfile,
    reviewedPromoter,
    reviewedSubagentUnit,
    root,
    upgrader: join(releaseScripts, "upgrade-deployment-authority.sh"),
  };
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

interface AuthorityChallenge {
  readonly challenge: string;
  readonly commit: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly kind: "authentication" | "enrollment";
  readonly options: unknown;
  readonly version: 1;
}

function storedPasskey(
  credentialId: Buffer,
  publicKey: KeyObject,
  label: string,
) {
  const encodedPublicKey = cosePublicKey(publicKey);
  return {
    counter: 0,
    credentialId: credentialId.toString("base64url"),
    label,
    publicKey: encodedPublicKey.toString("base64url"),
    transports: ["internal"],
  };
}

function registryForKey(
  credentialId: Buffer,
  publicKey: KeyObject,
  label: string,
) {
  const encodedPublicKey = cosePublicKey(publicKey);
  return {
    algorithm: -7,
    counter: 0,
    credentialId: credentialId.toString("base64url"),
    label,
    publicKeyFingerprint: createHash("sha256")
      .update(encodedPublicKey)
      .digest("hex"),
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    transports: ["internal"],
    version: 1,
  };
}

function cosePublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) {
    throw new Error("EC fixture key is incomplete");
  }
  return encodeCbor(new Map<CborValue, CborValue>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]));
}

function authenticationResponse(
  challenge: string,
  credentialId: Buffer,
  privateKey: KeyObject,
  counter = 1,
) {
  const clientDataJson = clientData("webauthn.get", challenge);
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("voice.stephens.page").digest(),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, counter]),
  ]);
  const signed = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJson).digest(),
  ]);
  return {
    id: credentialId.toString("base64url"),
    rawId: credentialId.toString("base64url"),
    response: {
      authenticatorData: authenticatorData.toString("base64url"),
      clientDataJSON: clientDataJson.toString("base64url"),
      signature: sign("sha256", signed, privateKey).toString("base64url"),
      userHandle: null,
    },
    type: "public-key",
  };
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string) {
  return Buffer.from(JSON.stringify({
    challenge,
    crossOrigin: false,
    origin: "https://voice.stephens.page",
    type,
  }));
}

type CborValue = Buffer | Map<CborValue, CborValue> | number | string;

function encodeCbor(value: CborValue): Buffer {
  if (typeof value === "number") {
    return value >= 0
      ? encodeCborLength(0, value)
      : encodeCborLength(1, -1 - value);
  }
  if (typeof value === "string") {
    const encoded = Buffer.from(value);
    return Buffer.concat([encodeCborLength(3, encoded.length), encoded]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([encodeCborLength(2, value.length), value]);
  }
  const entries = [...value.entries()];
  return Buffer.concat([
    encodeCborLength(5, entries.length),
    ...entries.flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)]),
  ]);
}

function encodeCborLength(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const encoded = Buffer.alloc(3);
  encoded[0] = (major << 5) | 25;
  encoded.writeUInt16BE(value, 1);
  return encoded;
}
