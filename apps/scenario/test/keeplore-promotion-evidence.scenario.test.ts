import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { createSqliteKeeploreOnboardingStore } from "@voice-agent/sqlite-store";
import {
  projectKeeplorePromotionEvidence,
  readPromotionAttempts,
} from "@voice-agent/runtime";
import {
  registeredCodebaseIdSchema,
  type KeeploreDeploymentContract,
  type KeeploreRegistration,
} from "@voice-agent/contracts";

const temporaryDirectories: string[] = [];
const promotedCommit = "82fccd682db9f3ed40f91c56b7577bc6cbcff8ff";
const retainedCommit = "52173a8efacf7bc9c94be75664ef8cb091143516";

/** The shape the Agent Host actually appends, drill line included. */
const hostJournal = [
  JSON.stringify({
    // Historical journal spelling remains readable at the persistence seam.
    application: "keeplore-production",
    attemptedAt: "2026-08-20T08:22:07Z",
    commit: promotedCommit,
    merge: {
      actor: "JacobStephens2",
      mergedAt: "2026-08-20T08:21:40Z",
      source: "webhook",
    },
    previous: retainedCommit,
    release: {
      id: `keeplore-production-${promotedCommit}`,
      path: `/opt/keeplore/releases/${promotedCommit}`,
    },
    result: "succeeded",
    stage: "promotion",
    verification: { actualStatus: 200, expectedStatus: 200 },
  }),
  JSON.stringify({
    registeredCodebaseId: "keeplore-production",
    attemptedAt: "2026-08-20T09:10:29Z",
    commit: retainedCommit,
    previous: promotedCommit,
    restored: promotedCommit,
    result: "failed",
    stage: "verification-drill",
  }),
  "{ truncated line the host is still appending",
  JSON.stringify({
    commit: promotedCommit,
    registeredCodebaseId: "other-application",
  }),
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a truncated or foreign journal line never becomes evidence", () => {
  const attempts = readPromotionAttempts(hostJournal);
  expect(attempts).toHaveLength(2);
  expect(attempts.map((attempt) => attempt.stage)).toEqual([
    "promotion",
    "verification-drill",
  ]);
});

test("legacy Keeplore enrollment and Deployment Contract identity survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-legacy-identity-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const schemaStore = createSqliteKeeploreOnboardingStore(databasePath);
  schemaStore.close();

  const legacyRegistration = withLegacyRegisteredCodebaseId(registration());
  const legacyContract = withLegacyRegisteredCodebaseId(contract());
  const database = new Database(databasePath);
  database
    .prepare(
      "INSERT INTO keeplore_registrations (revision, definition_json) VALUES (?, ?)",
    )
    .run(1, JSON.stringify(legacyRegistration));
  database
    .prepare(
      "INSERT INTO keeplore_contracts (revision, definition_json) VALUES (?, ?)",
    )
    .run(1, JSON.stringify(legacyContract));
  database.close();

  const restarted = createSqliteKeeploreOnboardingStore(databasePath);
  const restoredRegistration = await restarted.findRegistration();
  const restoredContract = await restarted.findActiveContract();

  expect({ restoredContract, restoredRegistration }).toMatchObject({
    restoredContract: { registeredCodebaseId: "keeplore-production" },
    restoredRegistration: { registeredCodebaseId: "keeplore-production" },
  });
  expect(restoredRegistration).not.toHaveProperty("applicationId");
  expect(restoredContract).not.toHaveProperty("applicationId");
  restarted.close();
});

test("an unenrolled Keeplore has no Evidence Record, however full the journal", async () => {
  const store = await createStore();
  expect(
    await projectKeeplorePromotionEvidence({
      journal: { async read() { return hostJournal; } },
      store,
    }),
  ).toEqual([]);
});

test("the host's journal becomes an Evidence Record for each merge commit", async () => {
  const store = await createStore();
  await store.saveRegistration(registration());
  await store.saveContract(contract());
  await store.saveAssessment("branch-protection", {
    satisfied: true,
    violations: [],
  });
  await store.saveAssessment("github-app", { satisfied: true, violations: [] });

  const records = await projectKeeplorePromotionEvidence({
    journal: { async read() { return hostJournal; } },
    store,
  });

  expect(records).toHaveLength(2);
  const promoted = records.find(
    (record) => record.task.id === `keeplore-promotion:${promotedCommit}`,
  );
  expect(promoted?.onboarding).toMatchObject({
    branchProtection: { satisfied: true },
    contractRevision: 1,
    health: { actualStatus: 200, expectedStatus: 200, outcome: "healthy" },
    merge: {
      actor: "JacobStephens2",
      branch: "main",
      commit: promotedCommit,
      repository: "JacobStephens2/keeplore",
      source: "webhook",
    },
    promotionAttempt: { mergeCommit: promotedCommit, status: "succeeded" },
    registrationRevision: 1,
    release: { path: `/opt/keeplore/releases/${promotedCommit}` },
    rollback: { performed: false },
  });
  expect(promoted?.task).toMatchObject({
    conclusion: "Keeplore is onboarded and its Human Merge was promoted.",
    kind: "keeplore.onboarding",
    status: "completed",
  });
  expect(promoted?.evidence.map((event) => event.kind)).toEqual([
    "merge.accepted",
    "release.verified",
  ]);

  const drill = records.find(
    (record) => record.task.id === `keeplore-promotion:${retainedCommit}`,
  );
  expect(drill?.onboarding.rollback).toEqual({
    attemptedReleaseId: retainedCommit,
    performed: true,
    restoredReleaseId: promotedCommit,
  });
  expect(drill?.evidence[0]?.kind).toBe("release.rolled-back");
  expect(drill?.evidence[0]?.details.drill).toBe(true);
  expect(drill?.task.conclusion).toBe(
    "Keeplore onboarding could not be confirmed.",
  );
});

test("a bounded step back is not a fresh Promotion of the retained Release", async () => {
  const store = await createStore();
  await store.saveRegistration(registration());
  await store.saveContract(contract());
  const journal = JSON.stringify({
    registeredCodebaseId: "keeplore-production",
    attemptedAt: "2026-08-25T16:00:00Z",
    commit: retainedCommit,
    previous: promotedCommit,
    release: {
      id: `keeplore-production-${retainedCommit}`,
      path: `/opt/keeplore/releases/${retainedCommit}`,
    },
    repromotion: { kind: "step-back", mergeCommit: promotedCommit },
    result: "succeeded",
    stage: "promotion",
    verification: { actualStatus: 200, expectedStatus: 200 },
  });

  const records = await projectKeeplorePromotionEvidence({
    journal: { async read() { return journal; } },
    store,
  });
  const steppedBack = records.find(
    (record) => record.task.id === `keeplore-promotion:${retainedCommit}`,
  );

  // Serving the retained Release for a bounded window is not that Release's
  // own onboarding being confirmed all over again.
  expect(steppedBack?.evidence[0]?.kind).toBe("release.switched");
  expect(steppedBack?.evidence[0]?.summary).toContain("stepped back");
  expect(steppedBack?.onboarding.promotionAttempt?.status).toBe("queued");
  expect(steppedBack?.task.conclusion).toBe(
    "Keeplore onboarding could not be confirmed.",
  );
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-evidence-"));
  temporaryDirectories.push(directory);
  return createSqliteKeeploreOnboardingStore(join(directory, "voice-agent.sqlite"));
}

function registration(): KeeploreRegistration {
  return {
    registeredCodebaseId: registeredCodebaseIdSchema.parse(
      "keeplore-production",
    ),
    deploymentBoundaries: {
      liveCheckoutPath: "/var/www/keeplore.app",
      releaseRoot: "/opt/keeplore/releases",
      retainedReleases: 2,
      sharedRoot: "/opt/keeplore/shared",
      sourceMirrorPath: "/var/lib/keeplore-source/repository.git",
    },
    permittedSubagentProvider: "codex",
    productionBranch: "main",
    readScope: ["**/*.php"],
    registeredAt: "2026-08-20T08:00:00.000Z",
    registeredBy: "fresh-passkey-action",
    repository: "JacobStephens2/keeplore",
    revision: 1,
    verification: {
      checkName: "keeplore-verification",
      command: "vendor/bin/phpunit",
    },
    worktreeRoot: "/var/lib/voice-agent-worktrees/keeplore",
  };
}

function contract(): KeeploreDeploymentContract {
  return {
    activatedAt: "2026-08-20T08:05:00.000Z",
    activatedBy: "fresh-passkey-action",
    buildCommand: "php -l",
    health: { expectedStatus: 200, path: "/api/health" },
    preflightCommand: "php -l",
    registeredCodebaseId: registeredCodebaseIdSchema.parse(
      "keeplore-production",
    ),
    releaseRoot: "/opt/keeplore/releases",
    retainedReleases: 2,
    revision: 1,
    source: "voice-agent-policy",
  };
}

function withLegacyRegisteredCodebaseId(
  value: KeeploreDeploymentContract | KeeploreRegistration,
): Record<string, unknown> {
  const { registeredCodebaseId, ...legacy } = value;
  return { ...legacy, applicationId: registeredCodebaseId };
}
