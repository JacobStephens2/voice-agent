import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createHumanMergePromotionScenario,
  signHumanMergeWebhook,
  type FixtureGitHubEvent,
} from "@voice-agent/scenario";

const temporaryDirectories: string[] = [];
const webhookSecret = "fixture-webhook-secret";
const previousCommit = "1111111111111111111111111111111111111111";
const healthyCommit = "2222222222222222222222222222222222222222";
const serialHealthyCommit = "8888888888888888888888888888888888888888";
const serialUnhealthyCommit = "9999999999999999999999999999999999999999";
const serialFinalCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const failureOneCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const failureTwoCommit = "cccccccccccccccccccccccccccccccccccccccc";
const failureThreeCommit = "dddddddddddddddddddddddddddddddddddddddd";
const recoveryCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const missedCommit = "ffffffffffffffffffffffffffffffffffffffff";
const preOpenCommit = "1414141414141414141414141414141414141414";
const missedDescendantCommit = "1515151515151515151515151515151515151515";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a Human Merge promotes its exact commit through the active Deployment Contract", async () => {
  const scenario = await createScenario({
    healthStatusByCommit: { [healthyCommit]: 204 },
    ids: ["task-healthy", "attempt-healthy"],
  });
  const event = humanMerge(healthyCommit, previousCommit);

  const registration = await scenario.getRegistration();
  const contract = await scenario.getActiveContract();
  expect(registration).toMatchObject({
    applicationId: "fixture-production",
    productionBranch: "main",
    repository: "JacobStephens2/fixture-application",
  });
  expect(contract).toMatchObject({
    activatedBy: "fresh-passkey-action",
    applicationId: "fixture-production",
    health: { expectedStatus: 204, path: "/health" },
    revision: 1,
    source: "voice-agent-policy",
  });

  const accepted = await scenario.deliver({
    deliveryId: "delivery-healthy",
    event,
    signature: signHumanMergeWebhook(webhookSecret, event),
  });

  expect(accepted.outcome).toBe("accepted");
  expect(accepted.record.promotion).toMatchObject({
    attempt: {
      id: "attempt-healthy",
      mergeCommit: healthyCommit,
      queueSequence: 1,
      status: "queued",
    },
    contract: { revision: 1 },
    merge: {
      actor: "fixture-owner",
      branch: "main",
      commit: healthyCommit,
      deliveryId: "delivery-healthy",
      repository: "JacobStephens2/fixture-application",
    },
  });

  const completed = await scenario.processNext();
  expect(completed?.task).toMatchObject({
    conclusion: `Release ${healthyCommit} is active and healthy.`,
    status: "completed",
  });
  expect(completed?.promotion).toMatchObject({
    attempt: { mergeCommit: healthyCommit, status: "succeeded" },
    circuit: { consecutiveFailures: 0, state: "closed" },
    release: {
      commit: healthyCommit,
      id: `fixture-production-${healthyCommit}`,
      path: `/fixture/releases/fixture-production-${healthyCommit}`,
    },
    rollback: { performed: false },
    verification: {
      actualStatus: 204,
      expectedStatus: 204,
      outcome: "healthy",
      path: "/health",
    },
  });

  const inspection = await scenario.inspect();
  expect(inspection.activeRelease?.commit).toBe(healthyCommit);
  expect(inspection.operations.map((operation) => operation.kind)).toEqual([
    "release.build",
    "release.preflight",
    "release.switch",
    "release.verify",
  ]);
  expect(inspection.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "release.build",
        releasePath: `/fixture/releases/fixture-production-${healthyCommit}`,
        sourcePath: `/fixture/source/${healthyCommit}`,
      }),
      expect.objectContaining({
        command: "pnpm test --run",
        kind: "release.preflight",
        outcome: "passed",
      }),
    ]),
  );

  const page = await scenario.readTaskPage(
    accepted.record.task.id,
    "scenario-trusted-session",
  );
  expect(page.statusCode).toBe(200);
  expect(page.html).toContain("Human Merge Promotion");
  expect(page.html).toContain(healthyCommit);
  expect(page.html).toContain("Webhook delivery delivery-healthy");
  expect(page.html).toContain("Promotion Attempt attempt-healthy");
  expect(page.html).toContain("Deployment Contract revision 1");
  expect(page.html).toContain(`Release fixture-production-${healthyCommit}`);
  expect(page.html).toContain("Verification healthy");
  expect(page.html).toContain("Rollback not required");
  expect(page.html).toContain("Circuit closed");

  await scenario.close();
});

test("untrusted and ineligible GitHub deliveries are denied with evidence and no Promotion", async () => {
  const scenario = await createScenario({
    ids: [
      "task-accepted",
      "attempt-accepted",
      "task-invalid-signature",
      "task-duplicate-delivery",
      "task-direct-push",
      "task-wrong-branch",
      "task-wrong-repository",
      "task-bot-merge",
    ],
  });
  const acceptedEvent = humanMerge(healthyCommit, previousCommit);
  const accepted = await scenario.deliver({
    deliveryId: "delivery-once",
    event: acceptedEvent,
    signature: signHumanMergeWebhook(webhookSecret, acceptedEvent),
  });

  const invalidSignature = await scenario.deliver({
    deliveryId: "delivery-invalid-signature",
    event: humanMerge("3333333333333333333333333333333333333333", healthyCommit),
    signature: "sha256=invalid",
  });
  const duplicate = await scenario.deliver({
    deliveryId: "delivery-once",
    event: acceptedEvent,
    signature: signHumanMergeWebhook(webhookSecret, acceptedEvent),
  });
  const directPushEvent: FixtureGitHubEvent = {
    ...humanMerge("4444444444444444444444444444444444444444", healthyCommit),
    event: "push",
  };
  const directPush = await deliverSigned(
    scenario,
    "delivery-direct-push",
    directPushEvent,
  );
  const wrongBranchEvent: FixtureGitHubEvent = {
    ...humanMerge("5555555555555555555555555555555555555555", healthyCommit),
    branch: "develop",
  };
  const wrongBranch = await deliverSigned(
    scenario,
    "delivery-wrong-branch",
    wrongBranchEvent,
  );
  const wrongRepositoryEvent: FixtureGitHubEvent = {
    ...humanMerge("6666666666666666666666666666666666666666", healthyCommit),
    repository: "attacker/fixture-application",
  };
  const wrongRepository = await deliverSigned(
    scenario,
    "delivery-wrong-repository",
    wrongRepositoryEvent,
  );
  const botMergeEvent: FixtureGitHubEvent = {
    ...humanMerge("7777777777777777777777777777777777777777", healthyCommit),
    mergedBy: { login: "automation[bot]", type: "Bot" },
  };
  const botMerge = await deliverSigned(
    scenario,
    "delivery-bot-merge",
    botMergeEvent,
  );

  expect(accepted.outcome).toBe("accepted");
  expect(
    [
      invalidSignature,
      duplicate,
      directPush,
      wrongBranch,
      wrongRepository,
      botMerge,
    ].map((result) => [
      result.outcome,
      result.record.promotion.denialReason,
      result.record.task.status,
      result.record.promotion.attempt,
    ]),
  ).toEqual([
    ["denied", "invalid-signature", "denied", undefined],
    ["duplicate", "duplicate-delivery", "denied", undefined],
    ["denied", "direct-push", "denied", undefined],
    ["denied", "wrong-branch", "denied", undefined],
    ["denied", "wrong-repository", "denied", undefined],
    ["denied", "non-human-merge", "denied", undefined],
  ]);
  for (const denial of [
    invalidSignature,
    duplicate,
    directPush,
    wrongBranch,
    wrongRepository,
    botMerge,
  ]) {
    expect(denial.record.evidence).toHaveLength(1);
    expect(denial.record.evidence[0]?.kind).toMatch(
      /^delivery\.(denied|duplicate)$/u,
    );
  }

  const inspection = await scenario.inspect();
  expect(inspection.attempts).toEqual([
    expect.objectContaining({ id: "attempt-accepted", status: "queued" }),
  ]);
  expect(inspection.operations).toEqual([]);

  await scenario.close();
});

test("Promotion Attempts remain serial and an unhealthy Release restores the prior Release", async () => {
  const scenario = await createScenario({
    healthStatusByCommit: {
      [serialFinalCommit]: 204,
      [serialHealthyCommit]: 204,
      [serialUnhealthyCommit]: 503,
    },
    ids: [
      "task-serial-1",
      "attempt-serial-1",
      "task-serial-2",
      "attempt-serial-2",
      "task-serial-3",
      "attempt-serial-3",
    ],
  });
  const first = await deliverSigned(
    scenario,
    "delivery-serial-1",
    humanMerge(serialHealthyCommit, previousCommit),
  );
  const second = await deliverSigned(
    scenario,
    "delivery-serial-2",
    humanMerge(serialUnhealthyCommit, serialHealthyCommit),
  );
  await deliverSigned(
    scenario,
    "delivery-serial-3",
    humanMerge(serialFinalCommit, serialUnhealthyCommit),
  );

  expect((await scenario.processNext())?.promotion.attempt).toMatchObject({
    mergeCommit: serialHealthyCommit,
    queueSequence: 1,
    status: "succeeded",
  });
  const rolledBack = await scenario.processNext();
  expect(rolledBack?.task).toMatchObject({
    conclusion: `Release ${serialUnhealthyCommit} was unhealthy; fixture-production-${serialHealthyCommit} was restored.`,
    status: "completed",
  });
  expect(rolledBack?.promotion).toMatchObject({
    attempt: {
      mergeCommit: serialUnhealthyCommit,
      queueSequence: 2,
      status: "rolled-back",
    },
    circuit: { consecutiveFailures: 1, state: "closed" },
    release: { commit: serialUnhealthyCommit },
    rollback: {
      attemptedReleaseId: `fixture-production-${serialUnhealthyCommit}`,
      performed: true,
      restoredReleaseId: `fixture-production-${serialHealthyCommit}`,
    },
    verification: { actualStatus: 503, outcome: "unhealthy" },
  });

  let inspection = await scenario.inspect();
  expect(inspection.activeRelease?.commit).toBe(serialHealthyCommit);
  expect(inspection.attempts.map((attempt) => attempt.status)).toEqual([
    "succeeded",
    "rolled-back",
    "queued",
  ]);
  expect(inspection.operations.map((operation) => operation.kind)).toEqual([
    "release.build",
    "release.preflight",
    "release.switch",
    "release.verify",
    "release.build",
    "release.preflight",
    "release.switch",
    "release.verify",
    "release.rollback",
  ]);
  expect(inspection.operations.at(-1)).toMatchObject({
    kind: "release.rollback",
    restoredReleaseId: `fixture-production-${serialHealthyCommit}`,
  });
  const rollbackPage = await scenario.readTaskPage(
    second.record.task.id,
    "scenario-trusted-session",
  );
  expect(rollbackPage.html).toContain("Rollback performed");
  expect(rollbackPage.html).toContain(
    `Restored fixture-production-${serialHealthyCommit}`,
  );

  const final = await scenario.processNext();
  expect(final?.promotion.attempt).toMatchObject({
    mergeCommit: serialFinalCommit,
    queueSequence: 3,
    status: "succeeded",
  });
  inspection = await scenario.inspect();
  expect(inspection.activeRelease?.commit).toBe(serialFinalCommit);
  expect(inspection.attempts).toHaveLength(3);
  expect(first.record.task.id).toBe("task-serial-1");
  expect(second.record.task.id).toBe("task-serial-2");

  await scenario.close();
});

test("three failed Promotions open the circuit and the next Human Merge is half-open", async () => {
  const scenario = await createScenario({
    healthStatusByCommit: {
      [failureOneCommit]: 503,
      [failureThreeCommit]: 503,
      [failureTwoCommit]: 503,
      [recoveryCommit]: 204,
    },
    ids: [
      "task-failure-1",
      "attempt-failure-1",
      "task-failure-2",
      "attempt-failure-2",
      "task-failure-3",
      "attempt-failure-3",
      "task-pre-open",
      "attempt-pre-open",
      "task-recovery",
      "attempt-recovery",
    ],
  });
  await deliverSigned(
    scenario,
    "delivery-failure-1",
    humanMerge(failureOneCommit, previousCommit),
  );
  await deliverSigned(
    scenario,
    "delivery-failure-2",
    humanMerge(failureTwoCommit, failureOneCommit),
  );
  await deliverSigned(
    scenario,
    "delivery-failure-3",
    humanMerge(failureThreeCommit, failureTwoCommit),
  );
  await deliverSigned(
    scenario,
    "delivery-pre-open",
    humanMerge(preOpenCommit, failureThreeCommit),
  );

  await scenario.processNext();
  await scenario.processNext();
  const opened = await scenario.processNext();
  expect(opened?.promotion.circuit).toEqual({
    consecutiveFailures: 3,
    state: "open",
  });
  expect(opened?.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        details: expect.objectContaining({ state: "open" }),
        kind: "circuit.changed",
      }),
    ]),
  );
  expect(await scenario.processNext()).toBeUndefined();

  const recovery = await deliverSigned(
    scenario,
    "delivery-recovery",
    humanMerge(recoveryCommit, failureThreeCommit),
  );
  expect(recovery.record.promotion.circuit.state).toBe("open");
  const recovered = await scenario.processNext();
  expect(recovered?.promotion).toMatchObject({
    attempt: { mergeCommit: recoveryCommit, status: "succeeded" },
    circuit: { consecutiveFailures: 0, state: "closed" },
  });
  expect(
    recovered?.evidence
      .filter((event) => event.kind === "circuit.changed")
      .map((event) => event.details.state),
  ).toEqual(["half-open", "closed"]);
  const resumedPreOpen = await scenario.processNext();
  expect(resumedPreOpen?.promotion.attempt).toMatchObject({
    id: "attempt-pre-open",
    mergeCommit: preOpenCommit,
    status: "succeeded",
  });

  await scenario.close();
});

test("reconciliation discovers a missed Human Merge exactly once", async () => {
  const scenario = await createScenario({
    ids: [
      "task-recorded",
      "attempt-recorded",
      "task-missed",
      "attempt-missed",
      "task-missed-descendant",
      "attempt-missed-descendant",
    ],
  });
  const recordedEvent = humanMerge(healthyCommit, previousCommit);
  const missedEvent = humanMerge(missedCommit, healthyCommit);
  const missedDescendantEvent = humanMerge(
    missedDescendantCommit,
    missedCommit,
  );
  const wrongBranchEvent: FixtureGitHubEvent = {
    ...humanMerge(serialHealthyCommit, missedCommit),
    branch: "develop",
  };
  await deliverSigned(scenario, "delivery-recorded", recordedEvent);

  const discovered = await scenario.reconcile([
    missedDescendantEvent,
    missedEvent,
    recordedEvent,
    wrongBranchEvent,
  ]);
  expect(discovered).toHaveLength(2);
  expect(discovered[0]).toMatchObject({
    outcome: "accepted",
    record: {
      promotion: {
        attempt: {
          id: "attempt-missed",
          mergeCommit: missedCommit,
          queueSequence: 2,
          status: "queued",
        },
        merge: {
          commit: missedCommit,
          deliveryId: `reconciliation:${missedCommit}`,
          source: "reconciliation",
        },
      },
    },
  });
  expect(discovered[0]?.record.evidence[0]).toMatchObject({
    kind: "reconciliation.discovered",
  });
  expect(discovered[1]).toMatchObject({
    record: {
      promotion: {
        attempt: {
          id: "attempt-missed-descendant",
          mergeCommit: missedDescendantCommit,
          queueSequence: 3,
        },
      },
    },
  });
  expect(
    await scenario.reconcile([
      missedDescendantEvent,
      recordedEvent,
      missedEvent,
    ]),
  ).toEqual([]);
  expect((await scenario.inspect()).attempts.map((attempt) => attempt.mergeCommit)).toEqual([
    healthyCommit,
    missedCommit,
    missedDescendantCommit,
  ]);

  await scenario.processNext();
  const reconciled = await scenario.processNext();
  expect(reconciled?.promotion.attempt).toMatchObject({
    mergeCommit: missedCommit,
    status: "succeeded",
  });
  const reconciledDescendant = await scenario.processNext();
  expect(reconciledDescendant?.promotion.attempt).toMatchObject({
    mergeCommit: missedDescendantCommit,
    status: "succeeded",
  });

  await scenario.close();
});

test("reconciliation inserts a missed ancestor before its queued descendant", async () => {
  const scenario = await createScenario({
    ids: [
      "task-descendant-first",
      "attempt-descendant-first",
      "task-missed-ancestor",
      "attempt-missed-ancestor",
    ],
  });
  const missedAncestor = humanMerge(missedCommit, healthyCommit);
  const recordedDescendant = humanMerge(missedDescendantCommit, missedCommit);
  await deliverSigned(
    scenario,
    "delivery-descendant-first",
    recordedDescendant,
  );

  const discovered = await scenario.reconcile([
    recordedDescendant,
    missedAncestor,
  ]);
  expect(discovered[0]?.record.promotion.attempt).toMatchObject({
    id: "attempt-missed-ancestor",
    mergeCommit: missedCommit,
    queueSequence: 1,
  });
  expect((await scenario.inspect()).attempts).toEqual([
    expect.objectContaining({
      id: "attempt-missed-ancestor",
      mergeCommit: missedCommit,
      queueSequence: 1,
    }),
    expect.objectContaining({
      id: "attempt-descendant-first",
      mergeCommit: missedDescendantCommit,
      queueSequence: 2,
    }),
  ]);
  expect((await scenario.processNext())?.promotion.attempt?.mergeCommit).toBe(
    missedCommit,
  );
  expect((await scenario.processNext())?.promotion.attempt?.mergeCommit).toBe(
    missedDescendantCommit,
  );

  await scenario.close();
});

test("recorded external operations are not repeated after simulated process loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-promotion-loss-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "scenario.sqlite");
  const event = humanMerge(healthyCommit, previousCommit);
  const interrupted = await createHumanMergePromotionScenario({
    databasePath,
    healthStatusByCommit: { [healthyCommit]: 204 },
    ids: ["task-process-loss", "attempt-process-loss"],
    now: "2026-08-15T12:00:00.000Z",
    processLossAfterOperation: "release.switch",
    webhookSecret,
  });
  await deliverSigned(interrupted, "delivery-process-loss", event);

  await expect(interrupted.processNext()).rejects.toThrow(
    "Simulated process loss after release.switch",
  );
  expect((await interrupted.inspect()).operations.map((operation) => operation.kind)).toEqual([
    "release.build",
    "release.preflight",
    "release.switch",
  ]);
  await interrupted.close();

  const resumed = await createHumanMergePromotionScenario({
    databasePath,
    healthStatusByCommit: { [healthyCommit]: 204 },
    ids: [],
    now: "2026-08-15T12:00:01.000Z",
    webhookSecret,
  });
  const completed = await resumed.processNext();
  expect(completed?.promotion.attempt).toMatchObject({
    id: "attempt-process-loss",
    status: "succeeded",
  });
  expect(completed?.evidence.map((eventProjection) => eventProjection.kind)).toEqual([
    "merge.accepted",
    "promotion.queued",
    "release.built",
    "release.preflighted",
    "release.switched",
    "release.verified",
  ]);
  const inspection = await resumed.inspect();
  expect(inspection.operations.map((operation) => operation.kind)).toEqual([
    "release.build",
    "release.preflight",
    "release.switch",
    "release.verify",
  ]);
  expect(new Set(inspection.operations.map((operation) => operation.operationId)).size).toBe(4);
  expect(inspection.activeRelease?.commit).toBe(healthyCommit);

  await resumed.close();
});

test("an unhealthy persisted verification still rolls back after process loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-promotion-verify-loss-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "scenario.sqlite");
  const interrupted = await createHumanMergePromotionScenario({
    databasePath,
    healthStatusByCommit: { [serialUnhealthyCommit]: 503 },
    ids: ["task-verify-loss", "attempt-verify-loss"],
    now: "2026-08-15T12:00:00.000Z",
    processLossAfterOperation: "release.verify",
    webhookSecret,
  });
  await deliverSigned(
    interrupted,
    "delivery-verify-loss",
    humanMerge(serialUnhealthyCommit, previousCommit),
  );
  await expect(interrupted.processNext()).rejects.toThrow(
    "Simulated process loss after release.verify",
  );
  await interrupted.close();

  const resumed = await createHumanMergePromotionScenario({
    databasePath,
    ids: [],
    now: "2026-08-15T12:00:01.000Z",
    webhookSecret,
  });
  const completed = await resumed.processNext();
  expect(completed?.promotion).toMatchObject({
    attempt: { status: "rolled-back" },
    rollback: { performed: true },
    verification: { actualStatus: 503, outcome: "unhealthy" },
  });
  expect((await resumed.inspect()).operations.map((operation) => operation.kind)).toEqual([
    "release.build",
    "release.preflight",
    "release.switch",
    "release.verify",
    "release.rollback",
  ]);
  await resumed.close();
});

test("Deployment Contract revisions activate independently and remain fixed per attempt", async () => {
  const contractTwoCommit = "1212121212121212121212121212121212121212";
  const scenario = await createScenario({
    healthStatusByCommit: {
      [contractTwoCommit]: 418,
      [healthyCommit]: 204,
    },
    ids: [
      "task-contract-1",
      "attempt-contract-1",
      "task-contract-2",
      "attempt-contract-2",
    ],
  });
  const revisionOne = await deliverSigned(
    scenario,
    "delivery-contract-1",
    humanMerge(healthyCommit, previousCommit),
  );
  await expect(
    scenario.activateContract({
      buildCommand: "pnpm build:fixture",
      health: { expectedStatus: 418, path: "/ready" },
      preflightCommand: "pnpm fixture:preflight",
      releaseRoot: "/fixture/releases",
      revision: 2,
      sessionToken: "not-fresh",
    }),
  ).rejects.toThrow("Fresh Passkey Action required");
  const activated = await scenario.activateContract({
    buildCommand: "pnpm build:fixture",
    health: { expectedStatus: 418, path: "/ready" },
    preflightCommand: "pnpm fixture:preflight",
    releaseRoot: "/fixture/releases",
    revision: 2,
    sessionToken: "fresh-contract-session",
  });
  const revisionTwo = await deliverSigned(
    scenario,
    "delivery-contract-2",
    humanMerge(contractTwoCommit, healthyCommit),
  );

  expect(activated).toMatchObject({
    activatedBy: "fresh-passkey-action",
    revision: 2,
    source: "voice-agent-policy",
  });
  expect(revisionOne.record.promotion.contract?.revision).toBe(1);
  expect(revisionTwo.record.promotion.contract?.revision).toBe(2);
  expect((await scenario.getActiveContract()).revision).toBe(2);

  await expect(
    scenario.activateContract({
      buildCommand: "malicious repository proposal",
      health: { expectedStatus: 200, path: "/changed" },
      preflightCommand: "skip",
      releaseRoot: "/tmp/live-checkout",
      revision: 2,
      sessionToken: "fresh-contract-session",
    }),
  ).rejects.toThrow("Deployment Contract revision 2 already exists");

  const first = await scenario.processNext();
  const second = await scenario.processNext();
  expect(first?.promotion).toMatchObject({
    contract: { revision: 1 },
    verification: { expectedStatus: 204, outcome: "healthy", path: "/health" },
  });
  expect(second?.promotion).toMatchObject({
    contract: { revision: 2 },
    verification: { expectedStatus: 418, outcome: "healthy", path: "/ready" },
  });
  expect(
    (await scenario.inspect()).operations
      .filter((operation) => operation.kind === "release.build")
      .map((operation) => operation.command),
  ).toEqual(["pnpm build", "pnpm build:fixture"]);
  expect(
    (await scenario.inspect()).operations
      .filter((operation) => operation.kind === "release.preflight")
      .map((operation) => operation.command),
  ).toEqual(["pnpm test --run", "pnpm fixture:preflight"]);

  await scenario.close();
});

async function createScenario(input: {
  readonly contractActivationAuthority?:
    | {
        hasFreshPasskeyAction(sessionToken: string): Promise<boolean>;
      }
    | undefined;
  readonly healthStatusByCommit?: Readonly<Record<string, number>>;
  readonly ids: readonly string[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-promotion-"));
  temporaryDirectories.push(directory);
  return createHumanMergePromotionScenario({
    databasePath: join(directory, "scenario.sqlite"),
    contractActivationAuthority:
      input.contractActivationAuthority ??
      {
        async hasFreshPasskeyAction(sessionToken) {
          return sessionToken === "fresh-contract-session";
        },
      },
    healthStatusByCommit: input.healthStatusByCommit,
    ids: input.ids,
    now: "2026-08-15T12:00:00.000Z",
    webhookSecret,
  });
}

function humanMerge(commit: string, beforeCommit: string): FixtureGitHubEvent {
  return {
    action: "closed",
    beforeCommit,
    branch: "main",
    commit,
    event: "pull_request",
    merged: true,
    mergedBy: { login: "fixture-owner", type: "User" },
    repository: "JacobStephens2/fixture-application",
  };
}

function deliverSigned(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  deliveryId: string,
  event: FixtureGitHubEvent,
) {
  return scenario.deliver({
    deliveryId,
    event,
    signature: signHumanMergeWebhook(webhookSecret, event),
  });
}
