import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createKeeploreOnboardingScenario,
  signHumanMergeWebhook,
  type FixtureGitHubEvent,
  type KeeploreOnboardingScenario,
} from "@voice-agent/scenario";
import type {
  KeeploreBranchProtection,
  KeeploreGitHubAppInstallation,
  KeeploreLiveInspection,
  KeeploreWorkingTreeReconciliation,
} from "@voice-agent/contracts";

const temporaryDirectories: string[] = [];
const webhookSecret = "keeplore-webhook-secret";
const now = "2026-08-19T12:00:00.000Z";
const initialCommit = "1111111111111111111111111111111111111111";
const harmlessCommit = "2222222222222222222222222222222222222222";
const unhealthyCommit = "3333333333333333333333333333333333333333";
const recoveryCommit = "4444444444444444444444444444444444444444";
const releaseRoot = "/opt/keeplore/releases";
const liveCheckoutPath = "/var/www/keeplore";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a read-only inspection revalidates the live checkout and blocks enrollment until the owner reconciles it", async () => {
  const scenario = await createScenario({
    ids: ["task-blocked"],
    inspection: liveInspection({ uncommittedPaths: ["src/table.tsx"] }),
  });

  const inspection = await scenario.inspectLiveCheckout();
  expect(inspection).toMatchObject({
    accessMode: "read-only",
    liveCheckoutPath,
    productionBranch: "main",
    repository: "JacobStephens2/keeplore",
    serviceUnit: "keeplore-api.service",
    uncommittedPaths: ["src/table.tsx"],
  });
  expect(inspection.verificationCommands.length).toBeGreaterThan(0);

  const blocked = await scenario.enroll({
    reconciliation: reconciliation({
      outcome: "preserved-on-branch",
      preservedRef: "owner/live-work",
      remainingUncommittedPaths: ["src/table.tsx"],
    }),
    source: "fresh-passkey-action",
  });

  expect(blocked).toEqual({
    decision: "denied",
    reason:
      "Live Keeplore work must be reconciled and preserved by the owner before enrollment",
  });
  expect(await scenario.getRegistration()).toBeUndefined();
  expect(await scenario.automationActions()).toEqual([]);
  expect(await scenario.liveCheckoutState()).toEqual({
    headCommit: initialCommit,
    uncommittedPaths: ["src/table.tsx"],
  });
});

test("a Fresh Passkey Action enrolls Keeplore with fixed boundaries that no other source can claim", async () => {
  const scenario = await createScenario({ ids: [] });

  for (const source of ["repository", "trusted-session", "voice"] as const) {
    const denied = await scenario.enroll({
      reconciliation: reconciliation({}),
      source,
    });
    expect(denied.decision).toBe("denied");
  }
  expect(await scenario.getRegistration()).toBeUndefined();

  const enrolled = await scenario.enroll({
    reconciliation: reconciliation({}),
    source: "fresh-passkey-action",
  });

  expect(enrolled).toMatchObject({ decision: "enrolled" });
  expect(await scenario.getRegistration()).toMatchObject({
    applicationId: "keeplore-production",
    deploymentBoundaries: {
      liveCheckoutPath,
      releaseRoot,
      retainedReleases: 2,
      sourceMirrorPath: "/var/lib/keeplore-source/repository.git",
    },
    permittedSubagentProvider: "codex",
    productionBranch: "main",
    registeredBy: "fresh-passkey-action",
    repository: "JacobStephens2/keeplore",
    revision: 1,
    verification: { checkName: "keeplore-verification", command: "npm test" },
    worktreeRoot: "/var/lib/voice-agent-worktrees/keeplore",
  });
});

test("production-branch rules must require pull requests, block force pushes and deletion, and grant no bypass", async () => {
  const scenario = await createScenario({ ids: [] });
  await enrollKeeplore(scenario);

  expect(
    await scenario.assessBranchProtection(
      branchProtection({
        allowsDeletion: true,
        allowsForcePush: true,
        bypassActors: ["voice-agent-coding-app"],
        requiredChecks: [],
        requiresPullRequest: false,
      }),
    ),
  ).toEqual({
    satisfied: false,
    violations: [
      "Production branch does not require a pull request",
      "Production branch allows force pushes",
      "Production branch allows deletion",
      "Production branch does not require the keeplore-verification check",
      "Production branch rules grant voice-agent-coding-app bypass authority",
    ],
  });

  expect(await scenario.assessBranchProtection(branchProtection({}))).toEqual({
    satisfied: true,
    violations: [],
  });
});

test("the GitHub App holds only the content, pull-request, and check permissions the design requires", async () => {
  const scenario = await createScenario({ ids: [] });
  await enrollKeeplore(scenario);

  expect(
    await scenario.assessGitHubApp({
      permissions: { administration: "write", contents: "write" },
      repositories: ["JacobStephens2/keeplore"],
    }),
  ).toEqual({
    satisfied: false,
    violations: [
      "GitHub App is missing the checks permission",
      "GitHub App is missing the pull_requests permission",
      "GitHub App holds the unrequired administration permission",
    ],
  });

  expect(await scenario.assessGitHubApp(leastPrivilegeInstallation())).toEqual({
    satisfied: true,
    violations: [],
  });
});

test("a versioned Deployment Contract is activated by a Fresh Passkey Action and never by repository source", async () => {
  const scenario = await createScenario({ ids: [] });
  await enrollKeeplore(scenario);

  expect(
    await scenario.activateContract({ revision: 1, source: "repository" }),
  ).toEqual({
    decision: "denied",
    reason: "Repository content cannot activate a Keeplore Deployment Contract",
  });
  expect(
    await scenario.activateContract({
      releaseRoot: `${liveCheckoutPath}/releases`,
      revision: 1,
      source: "fresh-passkey-action",
    }),
  ).toEqual({
    decision: "denied",
    reason:
      "Deployment Contract Release root is outside the registered boundaries",
  });

  const activated = await scenario.activateContract({
    revision: 1,
    source: "fresh-passkey-action",
  });
  expect(activated).toMatchObject({
    contract: {
      activatedBy: "fresh-passkey-action",
      applicationId: "keeplore-production",
      health: { expectedStatus: 200, path: "/api/health" },
      releaseRoot,
      retainedReleases: 2,
      revision: 1,
      source: "voice-agent-policy",
    },
    decision: "activated",
  });

  expect(
    await scenario.activateContract({ revision: 1, source: "fresh-passkey-action" }),
  ).toEqual({
    decision: "denied",
    reason: "Deployment Contract revisions must increase",
  });
});

test("a harmless Human Merge promotes its exact commit into an immutable Release outside the live checkout", async () => {
  const scenario = await createScenario({
    ids: ["task-harmless", "attempt-harmless"],
  });
  await enrollKeeplore(scenario);
  await scenario.assessBranchProtection(branchProtection({}));
  await scenario.assessGitHubApp(leastPrivilegeInstallation());
  await scenario.activateContract({ revision: 1, source: "fresh-passkey-action" });

  const event = humanMerge(harmlessCommit, initialCommit);
  const accepted = await scenario.deliver({
    deliveryId: "delivery-harmless",
    event,
    signature: signHumanMergeWebhook(webhookSecret, event),
  });
  expect(accepted.outcome).toBe("accepted");

  const promoted = await scenario.processNext();
  expect(promoted?.onboarding).toMatchObject({
    branchProtection: { satisfied: true },
    contractRevision: 1,
    githubApp: { satisfied: true },
    health: { actualStatus: 200, expectedStatus: 200, outcome: "healthy" },
    merge: {
      branch: "main",
      commit: harmlessCommit,
      deliveryId: "delivery-harmless",
      repository: "JacobStephens2/keeplore",
      source: "webhook",
    },
    promotionAttempt: {
      id: "attempt-harmless",
      mergeCommit: harmlessCommit,
      status: "succeeded",
    },
    registrationRevision: 1,
    release: {
      commit: harmlessCommit,
      id: `keeplore-production-${harmlessCommit}`,
      path: `${releaseRoot}/keeplore-production-${harmlessCommit}`,
    },
    rollback: { performed: false },
  });
  expect(promoted?.task).toMatchObject({
    conclusion: "Keeplore is onboarded and its Human Merge was promoted.",
    kind: "keeplore.onboarding",
    status: "completed",
  });
  expect(promoted?.onboarding.release?.path.startsWith(liveCheckoutPath)).toBe(
    false,
  );
  expect(await scenario.liveCheckoutState()).toEqual({
    headCommit: initialCommit,
    uncommittedPaths: [],
  });
});

test("unsigned, duplicated, direct-push, and bot deliveries never enqueue a Promotion", async () => {
  const scenario = await createScenario({
    ids: [
      "task-unsigned",
      "task-wrong-repository",
      "task-push",
      "task-bot",
      "task-valid",
      "attempt-valid",
      "task-duplicate",
    ],
  });
  await enrollKeeplore(scenario);
  await scenario.activateContract({ revision: 1, source: "fresh-passkey-action" });

  const event = humanMerge(harmlessCommit, initialCommit);
  expect(
    (await scenario.deliver({
      deliveryId: "delivery-unsigned",
      event,
      signature: "sha256=0000",
    })).outcome,
  ).toBe("denied");

  const foreign = { ...event, repository: "attacker/keeplore" };
  expect(
    (await scenario.deliver({
      deliveryId: "delivery-foreign",
      event: foreign,
      signature: signHumanMergeWebhook(webhookSecret, foreign),
    })).outcome,
  ).toBe("denied");

  const push = { ...event, event: "push" as const };
  expect(
    (await scenario.deliver({
      deliveryId: "delivery-push",
      event: push,
      signature: signHumanMergeWebhook(webhookSecret, push),
    })).outcome,
  ).toBe("denied");

  const bot = {
    ...event,
    mergedBy: { login: "codex[bot]", type: "Bot" as const },
  };
  expect(
    (await scenario.deliver({
      deliveryId: "delivery-bot",
      event: bot,
      signature: signHumanMergeWebhook(webhookSecret, bot),
    })).outcome,
  ).toBe("denied");

  const signature = signHumanMergeWebhook(webhookSecret, event);
  expect(
    (await scenario.deliver({ deliveryId: "delivery-once", event, signature }))
      .outcome,
  ).toBe("accepted");
  expect(
    (await scenario.deliver({ deliveryId: "delivery-once", event, signature }))
      .outcome,
  ).toBe("duplicate");

  const attempts = await scenario.inspect();
  expect(attempts.attempts.map((attempt) => attempt.mergeCommit)).toEqual([
    harmlessCommit,
  ]);
});

test("a failed verification rolls back to the retained Release without touching live Keeplore data", async () => {
  const scenario = await createScenario({
    healthStatusByCommit: { [unhealthyCommit]: 503 },
    ids: [
      "task-healthy",
      "attempt-healthy",
      "task-unhealthy",
      "attempt-unhealthy",
    ],
  });
  await enrollKeeplore(scenario);
  await scenario.activateContract({ revision: 1, source: "fresh-passkey-action" });

  const healthy = humanMerge(harmlessCommit, initialCommit);
  await scenario.deliver({
    deliveryId: "delivery-healthy",
    event: healthy,
    signature: signHumanMergeWebhook(webhookSecret, healthy),
  });
  await scenario.processNext();

  const unhealthy = humanMerge(unhealthyCommit, harmlessCommit);
  await scenario.deliver({
    deliveryId: "delivery-unhealthy",
    event: unhealthy,
    signature: signHumanMergeWebhook(webhookSecret, unhealthy),
  });
  const rolledBack = await scenario.processNext();

  expect(rolledBack?.onboarding).toMatchObject({
    health: { actualStatus: 503, expectedStatus: 200, outcome: "unhealthy" },
    promotionAttempt: { status: "rolled-back" },
    rollback: {
      attemptedReleaseId: `keeplore-production-${unhealthyCommit}`,
      performed: true,
      restoredReleaseId: `keeplore-production-${harmlessCommit}`,
    },
  });
  expect(rolledBack?.task.conclusion).toBe(
    "Keeplore onboarding could not be confirmed.",
  );
  expect((await scenario.inspect()).activeRelease).toMatchObject({
    commit: harmlessCommit,
    id: `keeplore-production-${harmlessCommit}`,
  });
  expect(await scenario.liveCheckoutState()).toEqual({
    headCommit: initialCommit,
    uncommittedPaths: [],
  });
});

test("reconciliation discovers a missed Human Merge and stays idempotent once its webhook was processed", async () => {
  const scenario = await createScenario({
    ids: [
      "task-webhook",
      "attempt-webhook",
      "task-reconciled",
      "attempt-reconciled",
    ],
  });
  await enrollKeeplore(scenario);
  await scenario.activateContract({ revision: 1, source: "fresh-passkey-action" });

  const delivered = humanMerge(harmlessCommit, initialCommit);
  await scenario.deliver({
    deliveryId: "delivery-webhook",
    event: delivered,
    signature: signHumanMergeWebhook(webhookSecret, delivered),
  });
  await scenario.processNext();

  expect(await scenario.reconcile([delivered])).toEqual([]);

  const missed = humanMerge(recoveryCommit, harmlessCommit);
  const discovered = await scenario.reconcile([delivered, missed]);
  expect(discovered).toHaveLength(1);
  expect(discovered[0]?.record.onboarding.merge).toMatchObject({
    commit: recoveryCommit,
    source: "reconciliation",
  });
  expect(await scenario.reconcile([delivered, missed])).toEqual([]);
});

test("the Evidence Record is authenticated and shows registration, contract, merge, Release, health, and rollback", async () => {
  const scenario = await createScenario({
    ids: ["task-evidence", "attempt-evidence"],
  });
  await enrollKeeplore(scenario);
  await scenario.assessBranchProtection(branchProtection({}));
  await scenario.assessGitHubApp(leastPrivilegeInstallation());
  await scenario.activateContract({ revision: 1, source: "fresh-passkey-action" });

  const event = humanMerge(harmlessCommit, initialCommit);
  await scenario.deliver({
    deliveryId: "delivery-evidence",
    event,
    signature: signHumanMergeWebhook(webhookSecret, event),
  });
  await scenario.processNext();

  const anonymous = await scenario.readTaskPage("task-evidence");
  expect(anonymous.statusCode).toBe(401);

  const page = await scenario.readTaskPage("task-evidence", "trusted");
  expect(page.statusCode).toBe(200);
  expect(page.html).toContain("Keeplore onboarding");
  expect(page.html).toContain("Registered Codebase revision 1");
  expect(page.html).toContain("Deployment Contract revision 1");
  expect(page.html).toContain(`keeplore-production-${harmlessCommit}`);
  expect(page.html).toContain("Verification healthy");
  expect(page.html).toContain("Rollback not required");
  expect(page.html).not.toContain(webhookSecret);

  const record = await scenario.getRecord("task-evidence");
  expect(record?.evidence.map((entry) => entry.kind)).toEqual([
    "merge.accepted",
    "promotion.queued",
    "release.built",
    "release.preflighted",
    "release.switched",
    "release.verified",
  ]);
});

async function createScenario(options: {
  readonly healthStatusByCommit?: Readonly<Record<string, number>>;
  readonly ids: readonly string[];
  readonly inspection?: KeeploreLiveInspection;
}): Promise<KeeploreOnboardingScenario> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-onboarding-"));
  temporaryDirectories.push(directory);
  return createKeeploreOnboardingScenario({
    databasePath: join(directory, "keeplore.sqlite"),
    healthStatusByCommit: options.healthStatusByCommit,
    ids: options.ids,
    inspection: options.inspection ?? liveInspection({}),
    now,
    webhookSecret,
  });
}

async function enrollKeeplore(
  scenario: KeeploreOnboardingScenario,
): Promise<void> {
  const enrolled = await scenario.enroll({
    reconciliation: reconciliation({}),
    source: "fresh-passkey-action",
  });
  if (enrolled.decision !== "enrolled") {
    throw new Error(`Keeplore enrollment failed: ${enrolled.reason}`);
  }
}

function liveInspection(overrides: {
  readonly uncommittedPaths?: readonly string[];
}): KeeploreLiveInspection {
  return {
    accessMode: "read-only",
    headCommit: initialCommit,
    inspectedAt: now,
    liveCheckoutPath,
    productionBranch: "main",
    repository: "JacobStephens2/keeplore",
    servingPath: `${liveCheckoutPath}/public`,
    serviceUnit: "keeplore-api.service",
    uncommittedPaths: [...(overrides.uncommittedPaths ?? [])],
    verificationCommands: ["npm test"],
  };
}

function reconciliation(overrides: {
  readonly outcome?: KeeploreWorkingTreeReconciliation["outcome"];
  readonly preservedRef?: string;
  readonly remainingUncommittedPaths?: readonly string[];
}): KeeploreWorkingTreeReconciliation {
  return {
    outcome: overrides.outcome ?? "already-clean",
    ...(overrides.preservedRef === undefined
      ? {}
      : { preservedRef: overrides.preservedRef }),
    reconciledAt: now,
    reconciledBy: "owner",
    remainingUncommittedPaths: [...(overrides.remainingUncommittedPaths ?? [])],
  };
}

function branchProtection(overrides: {
  readonly allowsDeletion?: boolean;
  readonly allowsForcePush?: boolean;
  readonly bypassActors?: readonly string[];
  readonly requiredChecks?: readonly string[];
  readonly requiresPullRequest?: boolean;
}): KeeploreBranchProtection {
  return {
    allowsDeletion: overrides.allowsDeletion ?? false,
    allowsForcePush: overrides.allowsForcePush ?? false,
    branch: "main",
    bypassActors: [...(overrides.bypassActors ?? [])],
    requiredChecks: [...(overrides.requiredChecks ?? ["keeplore-verification"])],
    requiresPullRequest: overrides.requiresPullRequest ?? true,
  };
}

function leastPrivilegeInstallation(): KeeploreGitHubAppInstallation {
  return {
    permissions: {
      checks: "read",
      contents: "write",
      pull_requests: "write",
    },
    repositories: ["JacobStephens2/keeplore"],
  };
}

function humanMerge(commit: string, beforeCommit: string): FixtureGitHubEvent {
  return {
    action: "closed",
    beforeCommit,
    branch: "main",
    commit,
    event: "pull_request",
    merged: true,
    mergedAt: now,
    mergedBy: { login: "JacobStephens2", type: "User" },
    repository: "JacobStephens2/keeplore",
  };
}
