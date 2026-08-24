import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import {
  readDeploymentAuthorityUpgradeChallenge,
  requestDeploymentAuthorityUpgrade,
} from "@voice-agent/api/deployment-authority-challenge";
import { describeRequestFailure } from "@voice-agent/pwa/request-failure";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

const commit = "e".repeat(40);
const temporaryDirectories: string[] = [];
const restoreStandardError: (() => void)[] = [];

afterEach(async () => {
  for (const restore of restoreStandardError.splice(0)) restore();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

interface ChallengeFixture {
  readonly api: ReturnType<typeof createTaskApi>;
  readonly challengePath: string;
  readonly markerPath: string;
  readonly statePath: string;
  readonly stderr: () => string;
}

async function challengeFixture(): Promise<ChallengeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-challenge-"));
  temporaryDirectories.push(directory);
  const store = createSqliteDurableTaskStore(join(directory, "tasks.sqlite"));
  const runtime = createDurableTaskRuntime({
    applicationRegistry: store,
    nextId: () => "task-challenge",
    now: () => "2026-08-24T22:00:00.000Z",
    store,
  });
  const challengePath = join(directory, "upgrade.challenge");
  const requestPath = join(directory, "upgrade.request");
  const statePath = join(directory, "state.tsv");
  const markerPath = join(directory, ".voice-agent-release");
  const paths = {
    activeReleaseMarkerPath: markerPath,
    challengePath,
    ownerUid: process.getuid?.() ?? 0,
    statePath,
  };
  await writeFile(statePath, `0\tclosed\t-\t${commit}\n`);
  await writeFile(markerPath, `${commit}\n`);
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return (original as (...input: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  restoreStandardError.push(() => {
    process.stderr.write = original;
  });
  const api = createTaskApi({
    authentication: {
      async canChangeState({ csrfToken, sessionToken }) {
        return sessionToken === "trusted-session" && csrfToken === "csrf-token-value";
      },
      async canViewEvidence(sessionToken) {
        return sessionToken === "trusted-session";
      },
      async hasFreshPasskeyAction() {
        return true;
      },
    },
    controls: runtime,
    origin: "https://voice.stephens.page",
    promotionControl: {
      readDeploymentAuthorityUpgradeChallenge: () =>
        readDeploymentAuthorityUpgradeChallenge(paths),
      requestDeploymentAuthorityUpgrade: (authorization) =>
        requestDeploymentAuthorityUpgrade({ ...paths, requestPath }, authorization),
      async requestResume() {
        return commit;
      },
    },
    records: runtime,
  });
  return {
    api,
    challengePath,
    markerPath,
    statePath,
    stderr: () => written.join(""),
  };
}

async function writeChallenge(
  path: string,
  offsetMinutes: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const createdAt = new Date(Date.now() + offsetMinutes * 60 * 1_000);
  const challenge = "c".repeat(43);
  await writeFile(
    path,
    `${JSON.stringify({
      challenge,
      commit,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1_000).toISOString(),
      kind: "authentication",
      options: { challenge },
      version: 1,
      ...overrides,
    })}\n`,
  );
  await chmod(path, 0o640);
}

const headers = {
  cookie: `${trustedSessionCookieName}=trusted-session`,
  origin: "https://voice.stephens.page",
};

async function requestOptions(fixture: ChallengeFixture) {
  return fixture.api.inject({
    headers,
    method: "POST",
    payload: { csrfToken: "csrf-token-value" },
    url: "/api/operations/deployment-authority/upgrade-authorization/options",
  });
}

test("an expired deployment-authority challenge is a logged 4xx that names expiry", async () => {
  const fixture = await challengeFixture();
  await writeChallenge(fixture.challengePath, -6);

  const response = await requestOptions(fixture);

  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: "expired" });
  expect(String((response.json() as { error: string }).error)).toMatch(/expired/iu);
  expect(fixture.stderr()).toMatch(/expired/u);
});

test("routine deployment-authority challenge rejections are distinguishable", async () => {
  const notYetValid = await challengeFixture();
  await writeChallenge(notYetValid.challengePath, 1);
  const early = await requestOptions(notYetValid);
  expect(early.statusCode).toBe(409);
  expect(early.json()).toMatchObject({ reason: "not-yet-valid" });

  const noRelease = await challengeFixture();
  await writeChallenge(noRelease.challengePath, -1);
  await writeFile(noRelease.statePath, `1\topen\t${commit}\t${commit}\n`);
  const stalled = await requestOptions(noRelease);
  expect(stalled.statusCode).toBe(409);
  expect(stalled.json()).toMatchObject({ reason: "no-active-release" });

  const mismatched = await challengeFixture();
  await writeChallenge(mismatched.challengePath, -1);
  await writeFile(mismatched.markerPath, `${"f".repeat(40)}\n`);
  const drifted = await requestOptions(mismatched);
  expect(drifted.statusCode).toBe(409);
  expect(drifted.json()).toMatchObject({ reason: "release-mismatch" });

  expect(
    new Set(
      [early, stalled, drifted].map((response) =>
        (response.json() as { error: string }).error,
      ),
    ).size,
  ).toBe(3);
});

test("an unexpected deployment-authority challenge file stays a logged server fault", async () => {
  const malformed = await challengeFixture();
  await writeChallenge(malformed.challengePath, -1, { challenge: "short" });
  const broken = await requestOptions(malformed);
  expect(broken.statusCode).toBe(500);
  expect(broken.json()).toEqual({ error: "Request failed" });
  expect(malformed.stderr()).toMatch(/malformed/u);

  const exposed = await challengeFixture();
  await writeChallenge(exposed.challengePath, -1);
  await chmod(exposed.challengePath, 0o644);
  const widened = await requestOptions(exposed);
  expect(widened.statusCode).toBe(500);
  expect(exposed.stderr()).toMatch(/not-root-owned/u);
});

test("the PWA reports a routine rejection instead of a generic failure", async () => {
  const fixture = await challengeFixture();
  await writeChallenge(fixture.challengePath, -6);
  const response = await requestOptions(fixture);

  expect(
    describeRequestFailure(
      response.statusCode,
      response.json(),
      "Authentication could not be completed.",
    ),
  ).toMatch(/challenge expired/u);
  expect(
    describeRequestFailure(403, { error: "Invalid request" }, "Authentication could not be completed."),
  ).toBe("The request failed its origin or CSRF check.");
  expect(
    describeRequestFailure(500, { error: "Request failed" }, "Authentication could not be completed."),
  ).toBe("Authentication could not be completed.");
});
