import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createHumanMergePromotionScenario,
  signHumanMergeWebhook,
  voiceAgentInitialProductionCommit,
  voiceAgentPromotionCodebase,
  voiceAgentRepository,
  type FixtureGitHubEvent,
  type SelfPromotionScenarioOptions,
} from "@voice-agent/scenario";

const temporaryDirectories: string[] = [];
const webhookSecret = "self-promotion-webhook-secret";
const previousCommit = voiceAgentInitialProductionCommit;
const upgradeCommit = "3232323232323232323232323232323232323232";
const secondUpgradeCommit = "3333333333333333333333333333333333333333";
const unhealthyCommit = "3434343434343434343434343434343434343434";
const incompatibleCommit = "3535353535353535353535353535353535353535";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("an idle Self-Promotion closes admission, switches, and reopens against the verified Release", async () => {
  const scenario = await createSelfPromotionScenario({
    ids: ["task-idle", "attempt-idle"],
  });

  const registration = await scenario.getRegistration();
  const contract = await scenario.getActiveContract();
  expect(registration).toMatchObject({
    registeredCodebaseId: "voice-agent",
    liveCheckoutPath: "/opt/voice-agent/current",
    productionBranch: "main",
    repository: voiceAgentRepository,
  });
  expect(contract).toMatchObject({
    activatedBy: "fresh-passkey-action",
    health: { expectedStatus: 200, path: "/healthz" },
    revision: 1,
    source: "voice-agent-policy",
  });

  await expect(scenario.readCallAdmission()).resolves.toMatchObject({
    state: "open",
  });

  const accepted = await deliverSigned(scenario, "delivery-idle", merge(upgradeCommit));
  expect(accepted.outcome).toBe("accepted");

  const record = await scenario.processNext();
  expect(record?.promotion.attempt?.status).toBe("succeeded");
  expect(record?.promotion.safePoint).toEqual({
    activeTelephoneSessionsAtRequest: 0,
    disposition: "already-safe",
    endedForPromotion: 0,
    nonInterruptibleOperationsAtRequest: 0,
    observations: 1,
    resumableOperationsAtRequest: 0,
    warmTelephoneSessionsAtRequest: 0,
  });
  expect(record?.promotion.selfVerification).toEqual({
    checks: [
      { check: "api-health", outcome: "passed" },
      { check: "atomic-switch", outcome: "passed" },
      { check: "call-admission", outcome: "passed" },
      { check: "durable-store-compatibility", outcome: "passed" },
      { check: "public-health", outcome: "passed" },
      { check: "service-restart", outcome: "passed" },
      { check: "worker-readiness", outcome: "passed" },
    ],
    outcome: "healthy",
  });
  expect(record?.promotion.admission).toEqual({
    reopenedAfter: "verified",
    state: "open",
  });

  // The Evidence Record carries merge provenance, the safe-point decision, the
  // disposition of active work, the Release, verification, rollback, and where
  // admission was left.
  expect(record?.promotion.merge).toMatchObject({
    actor: "voice-agent-owner",
    beforeCommit: previousCommit,
    commit: upgradeCommit,
    repository: voiceAgentRepository,
  });
  expect(record?.promotion.rollback).toEqual({ performed: false });
  expect(kinds(record)).toEqual([
    "merge.accepted",
    "promotion.queued",
    "release.built",
    "release.preflighted",
    "admission.paused",
    "work.disposed",
    "safe-point.reached",
    "release.switched",
    "release.verified",
    "release.verified",
    "admission.reopened",
  ]);

  await expect(scenario.readCallAdmission()).resolves.toMatchObject({
    state: "open",
  });
  await scenario.close();
});

test("a live Telephone Session is allowed to end rather than deployed away", async () => {
  let waits = 0;
  const scenario = await createSelfPromotionScenario({
    ids: ["task-live", "attempt-live"],
    selfPromotion: {
      async onSafePointWait() {
        waits += 1;
        // The call ends naturally on the second observation; nothing about the
        // Promotion ends it.
        if (waits === 2) await scenario.world?.endTelephoneSession("live-call");
      },
    },
  });
  await scenario.world?.beginTelephoneSession("live-call");

  await deliverSigned(scenario, "delivery-live", merge(upgradeCommit));
  const record = await scenario.processNext();

  expect(record?.promotion.safePoint).toMatchObject({
    activeTelephoneSessionsAtRequest: 1,
    disposition: "waited",
    endedForPromotion: 0,
    observations: 3,
  });
  expect(record?.promotion.attempt?.status).toBe("succeeded");
  expect(
    record?.evidence.find((event) => event.kind === "work.disposed")?.details,
  ).toMatchObject({ activeTelephoneSessions: 1, endedForPromotion: 0 });
  await scenario.close();
});

test("a new Telephone Session is refused while admission is closed and admitted after", async () => {
  const decisions: string[] = [];
  const scenario = await createSelfPromotionScenario({
    ids: ["task-refuse", "attempt-refuse"],
    selfPromotion: {
      async onSafePointWait() {
        const decision = await scenario.world?.admitTelephoneSession("caller");
        decisions.push(decision?.decision ?? "unavailable");
        await scenario.world?.endTelephoneSession("live-call");
      },
    },
  });
  await scenario.world?.beginTelephoneSession("live-call");

  await deliverSigned(scenario, "delivery-refuse", merge(upgradeCommit));
  await scenario.processNext();

  // The caller met the ordinary refused reservation every entry path already
  // handles, not a new failure mode.
  expect(decisions).toEqual(["rejected"]);
  await expect(
    scenario.world?.admitTelephoneSession("later-caller"),
  ).resolves.toEqual({ decision: "accepted", resource: "warm-session" });
  await scenario.close();
});

test("a session reserved before the gate closed is not switched out from under", async () => {
  const activations: string[] = [];
  let waits = 0;
  const scenario = await createSelfPromotionScenario({
    ids: ["task-warm", "attempt-warm"],
    selfPromotion: {
      async onSafePointWait() {
        waits += 1;
        // The reservation granted before the pause becomes a live call, exactly
        // the race the safe point exists to lose: the switch must not happen
        // between reading a clear safe point and this activation.
        if (waits === 1) {
          const activated =
            await scenario.world?.activateTelephoneSession("warm-caller");
          activations.push(activated?.decision ?? "unavailable");
        }
        if (waits === 3) await scenario.world?.endTelephoneSession("warm-caller");
      },
    },
  });
  await expect(
    scenario.world?.admitTelephoneSession("warm-caller"),
  ).resolves.toEqual({ decision: "accepted", resource: "warm-session" });

  await deliverSigned(scenario, "delivery-warm", merge(upgradeCommit));
  const record = await scenario.processNext();

  expect(activations).toEqual(["accepted"]);
  expect(record?.promotion.safePoint).toMatchObject({
    // The reservation was warm, not yet live, when the gate closed.
    activeTelephoneSessionsAtRequest: 0,
    disposition: "waited",
    endedForPromotion: 0,
    warmTelephoneSessionsAtRequest: 1,
  });
  expect(record?.promotion.attempt?.status).toBe("succeeded");
  await scenario.close();
});

test("a call that never ends abandons the attempt rather than being deployed away", async () => {
  const scenario = await createSelfPromotionScenario({
    ids: ["task-first", "attempt-first", "task-stuck", "attempt-stuck"],
    selfPromotion: { maximumSafePointObservations: 3 },
  });
  await deliverSigned(scenario, "delivery-first", merge(upgradeCommit));
  await scenario.processNext();
  await scenario.world?.beginTelephoneSession("endless-call");

  await deliverSigned(
    scenario,
    "delivery-stuck",
    merge(secondUpgradeCommit, upgradeCommit),
  );
  const record = await scenario.processNext();

  expect(record?.promotion.safePoint).toMatchObject({
    disposition: "deadline-exceeded",
    endedForPromotion: 0,
    observations: 3,
  });
  // Nothing switched, so there was never anything to restore, and the call is
  // still up.
  expect(record?.promotion.attempt?.status).toBe("rolled-back");
  expect(record?.promotion.rollback).toEqual({
    attemptedReleaseId: `voice-agent-${secondUpgradeCommit}`,
    performed: false,
  });
  expect(record?.promotion.verification).toBeUndefined();
  expect(kinds(record)).not.toContain("release.switched");
  // The prior Release was never replaced, so the Evidence Record says exactly
  // that rather than claiming a rollback was verified.
  expect(record?.promotion.admission).toEqual({
    reopenedAfter: "abandoned-before-switch",
    state: "open",
  });
  // The call is still up, and admission is open again for the next caller.
  await expect(
    scenario.world?.listActiveTelephoneSessionIds(),
  ).resolves.toEqual(["endless-call"]);
  await expect(scenario.readCallAdmission()).resolves.toMatchObject({
    state: "open",
  });
  await scenario.close();
});

test("a non-interruptible Operation reaches its safe boundary before the switch", async () => {
  let waits = 0;
  const scenario = await createSelfPromotionScenario({
    ids: ["task-restart", "attempt-restart"],
    selfPromotion: {
      async onSafePointWait() {
        waits += 1;
        if (waits === 2) await scenario.world?.settleOperation("restart-operation");
      },
    },
  });
  await scenario.world?.beginOperation({
    kind: "bountywell.service.restart",
    operationId: "restart-operation",
    taskId: "restart-task",
  });

  await deliverSigned(scenario, "delivery-restart", merge(upgradeCommit));
  const record = await scenario.processNext();

  expect(record?.promotion.safePoint).toMatchObject({
    disposition: "waited",
    nonInterruptibleOperationsAtRequest: 1,
    observations: 3,
  });
  expect(record?.promotion.attempt?.status).toBe("succeeded");
  await expect(scenario.world?.listUnsettledOperations()).resolves.toEqual([]);
  await scenario.close();
});

test("resumable work does not hold the safe point and survives the switch", async () => {
  const scenario = await createSelfPromotionScenario({
    ids: ["task-resumable", "attempt-resumable"],
  });
  await scenario.world?.beginOperation({
    kind: "bountywell.health.observe",
    operationId: "observe-operation",
    taskId: "observe-task",
  });

  await deliverSigned(scenario, "delivery-resumable", merge(upgradeCommit));
  const record = await scenario.processNext();

  expect(record?.promotion.safePoint).toMatchObject({
    disposition: "already-safe",
    nonInterruptibleOperationsAtRequest: 0,
    observations: 1,
    resumableOperationsAtRequest: 1,
  });
  expect(
    record?.evidence.find((event) => event.kind === "work.disposed")?.details,
  ).toMatchObject({ resumableOperations: 1 });
  // The Operation is still unsettled, under the same durable identity, for the
  // switched runtime to finish.
  await expect(scenario.world?.listUnsettledOperations()).resolves.toEqual([
    {
      id: "observe-operation",
      kind: "bountywell.health.observe",
      status: "running",
      taskId: "observe-task",
    },
  ]);
  await scenario.close();
});

test("a failed health check restores the prior Release before admission reopens", async () => {
  const scenario = await createSelfPromotionScenario({
    healthStatusByCommit: { [unhealthyCommit]: 503 },
    ids: [
      "task-first",
      "attempt-first",
      "task-unhealthy",
      "attempt-unhealthy",
    ],
  });

  await deliverSigned(scenario, "delivery-first", merge(upgradeCommit));
  await scenario.processNext();
  await deliverSigned(
    scenario,
    "delivery-unhealthy",
    merge(unhealthyCommit, upgradeCommit),
  );
  const record = await scenario.processNext();

  expect(record?.promotion.attempt?.status).toBe("rolled-back");
  expect(record?.promotion.verification).toMatchObject({
    actualStatus: 503,
    expectedStatus: 200,
    outcome: "unhealthy",
  });
  expect(record?.promotion.selfVerification?.outcome).toBe("unhealthy");
  expect(record?.promotion.rollback).toEqual({
    attemptedReleaseId: `voice-agent-${unhealthyCommit}`,
    performed: true,
    restoredReleaseId: `voice-agent-${upgradeCommit}`,
  });
  expect(record?.promotion.admission).toEqual({
    reopenedAfter: "rollback-verified",
    state: "open",
  });
  expect(kinds(record)).toContain("release.rolled-back");
  await expect(scenario.readCallAdmission()).resolves.toMatchObject({
    state: "open",
  });
  await expect(
    scenario.world?.admitTelephoneSession("after-rollback"),
  ).resolves.toEqual({ decision: "accepted", resource: "warm-session" });
  await scenario.close();
});

test("a Release that cannot read the durable store rolls back although its health path answers", async () => {
  const scenario = await createSelfPromotionScenario({
    ids: [
      "task-first",
      "attempt-first",
      "task-incompatible",
      "attempt-incompatible",
    ],
    selfPromotion: {
      failedChecksByCommit: {
        [incompatibleCommit]: ["durable-store-compatibility"],
      },
    },
  });

  await deliverSigned(scenario, "delivery-first", merge(upgradeCommit));
  await scenario.processNext();
  await deliverSigned(
    scenario,
    "delivery-incompatible",
    merge(incompatibleCommit, upgradeCommit),
  );
  const record = await scenario.processNext();

  // The contract's health path is satisfied; the Self-Promotion's own reading
  // of the durable store is what refuses the Release.
  expect(record?.promotion.verification?.outcome).toBe("healthy");
  expect(record?.promotion.selfVerification).toMatchObject({
    checks: expect.arrayContaining([
      { check: "durable-store-compatibility", outcome: "failed" },
      { check: "api-health", outcome: "passed" },
    ]),
    outcome: "unhealthy",
  });
  expect(record?.promotion.attempt?.status).toBe("rolled-back");
  expect(record?.promotion.rollback.restoredReleaseId).toBe(
    `voice-agent-${upgradeCommit}`,
  );
  expect(record?.promotion.admission).toEqual({
    reopenedAfter: "rollback-verified",
    state: "open",
  });
  await scenario.close();
});

test("admission stays closed when the restored Release cannot be confirmed healthy", async () => {
  const scenario = await createSelfPromotionScenario({
    healthStatusByCommit: {
      [upgradeCommit]: 503,
      [secondUpgradeCommit]: 503,
    },
    ids: [
      "task-first",
      "attempt-first",
      "task-second",
      "attempt-second",
    ],
  });

  // The first Self-Promotion is unhealthy and has no prior Release to restore,
  // so nothing healthy is ever confirmed and the gate stays closed.
  await deliverSigned(scenario, "delivery-first", merge(upgradeCommit));
  const record = await scenario.processNext();

  expect(record?.promotion.attempt?.status).toBe("rolled-back");
  expect(record?.promotion.rollback.restoredReleaseId).toBeUndefined();
  expect(record?.promotion.admission).toEqual({ state: "paused" });
  await expect(scenario.readCallAdmission()).resolves.toMatchObject({
    reason: "self-promotion",
    state: "paused",
  });
  await expect(
    scenario.world?.admitTelephoneSession("blocked-caller"),
  ).resolves.toEqual({
    decision: "rejected",
    reason: "call-admission-paused",
    resource: "call-admission",
  });
  await scenario.close();
});

test("a duplicate merge and a reconciliation do not repeat the Self-Promotion", async () => {
  const scenario = await createSelfPromotionScenario({
    ids: [
      "task-once",
      "attempt-once",
      "task-duplicate",
      "task-reconciled",
      "attempt-reconciled",
    ],
  });
  const event = merge(upgradeCommit);

  await deliverSigned(scenario, "delivery-once", event);
  const first = await scenario.processNext();
  expect(first?.promotion.attempt?.status).toBe("succeeded");

  const duplicate = await deliverSigned(scenario, "delivery-once", event);
  expect(duplicate.outcome).toBe("duplicate");
  await expect(scenario.reconcile([event])).resolves.toEqual([]);
  await expect(scenario.processNext()).resolves.toBeUndefined();

  const inspection = await scenario.inspect();
  expect(inspection.attempts).toHaveLength(1);
  expect(
    inspection.operations.filter(
      (operation) => operation.kind === "release.switch",
    ),
  ).toHaveLength(1);
  await scenario.close();
});

test("repository source cannot activate a Deployment Contract revision it proposes", async () => {
  const scenario = await createSelfPromotionScenario({
    ids: ["task-proposal", "attempt-proposal"],
  });

  // A merge that carries a proposed contract revision in the repository.
  await deliverSigned(scenario, "delivery-proposal", merge(upgradeCommit));
  await scenario.processNext();
  await expect(scenario.getActiveContract()).resolves.toMatchObject({
    activatedBy: "fresh-passkey-action",
    revision: 1,
  });

  // The merged source proposing revision 2 cannot activate it: activation is a
  // Fresh Passkey Action, and a trusted browser session is not one.
  await expect(
    scenario.activateContract({
      buildCommand: "pnpm build",
      health: { expectedStatus: 200, path: "/healthz" },
      preflightCommand: "/bin/true",
      releaseRoot: "/opt/voice-agent/releases",
      revision: 2,
      sessionToken: "merged-repository-source",
    }),
  ).rejects.toThrow("Fresh Passkey Action required");
  await expect(scenario.getActiveContract()).resolves.toMatchObject({
    revision: 1,
  });

  // The owner's Fresh Passkey Action is the only thing that revises it.
  await expect(
    scenario.activateContract({
      buildCommand: "pnpm build",
      health: { expectedStatus: 200, path: "/healthz" },
      preflightCommand: "/bin/true",
      releaseRoot: "/opt/voice-agent/releases",
      revision: 2,
      sessionToken: "fresh-contract-session",
    }),
  ).resolves.toMatchObject({ activatedBy: "fresh-passkey-action", revision: 2 });
  await scenario.close();
});

async function createSelfPromotionScenario(input: {
  readonly healthStatusByCommit?: Readonly<Record<string, number>>;
  readonly ids: readonly string[];
  readonly selfPromotion?: SelfPromotionScenarioOptions;
}) {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-self-promotion-"));
  temporaryDirectories.push(directory);
  return createHumanMergePromotionScenario({
    codebase: voiceAgentPromotionCodebase,
    contractActivationAuthority: {
      async hasFreshPasskeyAction(sessionToken) {
        return sessionToken === "fresh-contract-session";
      },
    },
    databasePath: join(directory, "scenario.sqlite"),
    healthStatusByCommit: input.healthStatusByCommit,
    ids: input.ids,
    now: "2026-08-25T12:00:00.000Z",
    selfPromotion: {
      maximumSafePointObservations: 8,
      ...input.selfPromotion,
    },
    webhookSecret,
  });
}

function merge(
  commit: string,
  beforeCommit: string = previousCommit,
): FixtureGitHubEvent {
  return {
    action: "closed",
    beforeCommit,
    branch: "main",
    commit,
    event: "pull_request",
    merged: true,
    mergedAt: "2026-08-25T11:00:00.000Z",
    mergedBy: { login: "voice-agent-owner", type: "User" },
    repository: voiceAgentRepository,
  };
}

function deliverSigned(
  scenario: Awaited<ReturnType<typeof createSelfPromotionScenario>>,
  deliveryId: string,
  event: FixtureGitHubEvent,
) {
  return scenario.deliver({
    deliveryId,
    event,
    signature: signHumanMergeWebhook(webhookSecret, event),
  });
}

function kinds(
  record: Awaited<ReturnType<HumanMergePromotionRecord>> | undefined,
): readonly string[] {
  return (record?.evidence ?? []).map((event) => event.kind);
}

type HumanMergePromotionRecord = () => Promise<
  | Awaited<
      ReturnType<Awaited<ReturnType<typeof createSelfPromotionScenario>>["processNext"]>
    >
  | undefined
>;
