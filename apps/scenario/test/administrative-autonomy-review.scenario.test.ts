import { rm } from "node:fs/promises";

import { afterEach, expect, test } from "vitest";

import {
  administrativeExecutionManifestSchema,
  administrativePlanProviderIdentitySchema,
  administrativePolicyEvidencePageSchema,
  administrativeTimestampSchema,
  type LivePatchRollbackActivationRequest,
} from "@voice-agent/contracts";

import { createAdministrativeAutonomyScenario } from "../src/administrative-autonomy.ts";
import { createActivatedScenario } from "./administrative-autonomy.fixture.ts";

const temporaryDirectories: string[] = [];
const target = {
  environment: "production" as const,
  registeredCodebaseId: "voice-agent",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("an Administrative Execution Manifest cannot gain authority after Human Merge", async () => {
  const { databasePath, scenario: policyProcess } =
    await createActivatedScenario(
      {
        executionAdapters: "unavailable",
        now: "2026-10-02T10:00:00.000Z",
        providerPlan: [{ kind: "production.observe" }],
      },
      temporaryDirectories,
    );
  await policyProcess.close();

  const mergedAdapterProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    identifierNamespace: "merged-",
    now: "2026-10-02T10:01:00.000Z",
    providerPlan: [{ kind: "production.observe" }],
  });
  const staleAdmission = await mergedAdapterProcess.prepareTask({
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "manifest-stale-request",
    target,
  });
  const statusBeforeReactivation =
    await mergedAdapterProcess.readAutonomyStatus();
  const staleManifestActivation = await mergedAdapterProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedExecutionManifestFingerprint: "stale-observed-manifest",
    expectedStateVersion: 1,
    freshPasskey: true,
  });
  const reactivation = await mergedAdapterProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 1,
    freshPasskey: true,
  });
  const admitted = await mergedAdapterProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "manifest-current-request",
    target,
  });

  expect({
    admitted,
    reactivation,
    staleAdmission,
    staleManifestActivation,
    statusBeforeReactivation,
  }).toMatchObject({
      admitted: { decision: "admitted", policyRevision: 2 },
      reactivation: {
        body: {
          executionManifest: {
            operationAdapters: [
              { kind: "production.observe" },
              { kind: "delegated-worktree.change" },
              { kind: "live-patch.apply" },
            ],
            provider: { kind: "scenario-fake" },
          },
          revision: 2,
          status: "active",
        },
        statusCode: 200,
      },
      staleAdmission: {
        decision: "denied",
        reason:
          "The active policy revision does not authorize the configured execution manifest.",
      },
      staleManifestActivation: {
        body: {
          error:
            "Administrative execution manifest changed after it was observed",
        },
        statusCode: 409,
      },
      statusBeforeReactivation: {
        body: {
          policy: {
            executionManifest: { provider: { kind: "unavailable" } },
            revision: 1,
          },
          taskExecution: { status: "activation-required" },
        },
        statusCode: 200,
      },
    });

  await mergedAdapterProcess.close();
});

test.each([
  ["provider", { provider: 2 }],
  ["Operation executor", { executor: 2 }],
  ["Live Patch rollback activator", { rollbackActivator: 2 }],
] as const)(
  "a restarted runtime refuses a mismatched %s identity until Fresh Passkey activation",
  async (_implementation, executionImplementationVersions) => {
    const { databasePath, scenario: firstProcess } =
      await createActivatedScenario(
        {
          now: "2026-10-02T10:10:00.000Z",
          providerPlan: [{ kind: "production.observe" }],
        },
        temporaryDirectories,
      );
    await firstProcess.close();

    await expect(
      createAdministrativeAutonomyScenario({
        databasePath,
        executionImplementationVersions,
        identifierNamespace: "mismatch-",
        now: "2026-10-02T10:11:00.000Z",
        providerPlan: [{ kind: "production.observe" }],
      }),
    ).rejects.toThrow(/implementation identity does not match/u);

    const replacementProcess = await createAdministrativeAutonomyScenario({
      databasePath,
      executionImplementationVersions: {
        executor: 2,
        provider: 2,
        rollbackActivator: 2,
      },
      executionManifestVersion: 2,
      identifierNamespace: "replacement-",
      now: "2026-10-02T10:12:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    });
    const blocked = await replacementProcess.prepareTask({
      intendedState: "Production health is understood.",
      outcome: "investigate",
      ownerId: "owner",
      requestId: `identity-${_implementation}-blocked`,
      target,
    });
    const beforeActivation = await replacementProcess.readAutonomyStatus();
    const activated = await replacementProcess.activatePolicy({
      expectedActiveRevision: 1,
      expectedStateVersion: 1,
      freshPasskey: true,
    });

    expect({ activated, beforeActivation, blocked }).toMatchObject({
      activated: {
        body: { revision: 2, stateVersion: 2, status: "active" },
        statusCode: 200,
      },
      beforeActivation: {
        body: { taskExecution: { status: "activation-required" } },
        statusCode: 200,
      },
      blocked: {
        decision: "denied",
        reason:
          "The active policy revision does not authorize the configured execution manifest.",
      },
    });

    await replacementProcess.close();
  },
);

test("administrative safety timestamps require canonical UTC millisecond precision", () => {
  expect(
    administrativeTimestampSchema.safeParse("2026-10-02T10:00:00.000Z")
      .success,
  ).toBe(true);
  expect(
    [
      "2026-10-02T10:00:00Z",
      "2026-10-02T10:00:00.5Z",
      "2026-10-02T10:00:00.000+00:00",
    ].every(
      (timestamp) =>
        !administrativeTimestampSchema.safeParse(timestamp).success,
    ),
  ).toBe(true);
});

test("a Grok Administrative Execution Manifest binds the complete reviewed Runner Pin", () => {
  const provider = {
    enrollmentCampaignId: "grok-enrollment-campaign-1",
    kind: "grok-build" as const,
    runnerPin: {
      configurationPath: "/etc/voice-agent/grok/requirements.toml",
      digest:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      version: "1.0.13",
    },
  };
  const manifest = administrativeExecutionManifestSchema.parse({
    operationAdapters: [],
    provider,
    schemaVersion: 1,
  });
  const identity = administrativePlanProviderIdentitySchema.parse(provider);
  const digestOnly = administrativeExecutionManifestSchema.safeParse({
    operationAdapters: [],
    provider: {
      enrollmentCampaignId: provider.enrollmentCampaignId,
      kind: provider.kind,
      runnerPin: provider.runnerPin.digest,
    },
    schemaVersion: 1,
  });

  expect({ digestOnly: digestOnly.success, identity, manifest }).toMatchObject({
    digestOnly: false,
    identity: provider,
    manifest: { provider },
  });
});

test("confirmed publication intent becomes a bounded request and provider payload injection is denied", async () => {
  const { scenario } = await createActivatedScenario(
    {
      now: "2026-10-02T11:00:00.000Z",
      providerPlan: [{ kind: "delegated-worktree.change" }],
    },
    temporaryDirectories,
  );
  const result = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The reviewable change is ready for Human Merge.",
    outcome: "open-pull-request",
    ownerId: "owner",
    requestId: "open-pr-intent-request",
    target,
  });
  const record =
    result.decision === "admitted"
      ? await scenario.readTask(result.taskId)
      : undefined;
  const publicationProof = record?.evidence.find(
    (event) => event.kind === "administrative.operation.completed",
  );

  expect({
    operation: scenario.executedOperations[0],
    publicationProof,
    task: record?.task,
  }).toMatchObject({
    operation: {
      change: {
        intendedState: "The reviewable change is ready for Human Merge.",
        kind: "achieve-confirmed-intended-state",
        targetSource: "confirmed-durable-task",
      },
      kind: "delegated-worktree.change",
      publication: {
        baseBranch: "registered-production-branch",
        kind: "open-pull-request",
        productionMutation: false,
      },
      target,
    },
    publicationProof: {
      details: {
        result: {
          publication: {
            baseBranch: "registered-production-branch",
            kind: "isolated-pull-request-opened",
            productionMutation: false,
            registeredCodebaseId: "voice-agent",
            state: "open",
          },
        },
      },
    },
    task: { publicationIntent: "open-pull-request", status: "completed" },
  });
  await scenario.close();

  const { scenario: branchOnly } = await createActivatedScenario(
    {
      now: "2026-10-02T11:15:00.000Z",
      providerPlan: [{ kind: "delegated-worktree.change" }],
    },
    temporaryDirectories,
  );
  const branchResult = await branchOnly.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The reviewable branch is ready without publication.",
    outcome: "propose",
    ownerId: "owner",
    requestId: "branch-only-intent-request",
    target,
  });
  const branchRecord =
    branchResult.decision === "admitted"
      ? await branchOnly.readTask(branchResult.taskId)
      : undefined;
  expect({
    publicationRequest:
      branchOnly.executedOperations[0]?.kind === "delegated-worktree.change"
        ? branchOnly.executedOperations[0].publication
        : undefined,
    publicationResult: branchRecord?.evidence.find(
      (event) => event.kind === "administrative.operation.completed",
    ),
  }).toMatchObject({
    publicationRequest: { kind: "branch-only", productionMutation: false },
    publicationResult: {
      details: {
        result: {
          publication: {
            kind: "isolated-branch-prepared",
            productionMutation: false,
          },
        },
      },
    },
  });
  await branchOnly.close();

  const { scenario: injected } = await createActivatedScenario(
    {
      now: "2026-10-02T11:30:00.000Z",
      providerPlan: [
        {
          kind: "production.observe",
          target: {
            environment: "production",
            registeredCodebaseId: "provider-selected-target",
          },
        },
      ],
    },
    temporaryDirectories,
  );
  const denied = await injected.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "provider-payload-injection-request",
    target,
  });

  expect({ denied, executed: injected.executedOperations }).toEqual({
    denied: {
      decision: "denied",
      reason:
        "Provider instructions did not describe a permitted typed Operation plan",
    },
    executed: [],
  });
  await injected.close();
});

test("a running plan cannot cross an execution-manifest change after restart", async () => {
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      executorFailures: 1,
      now: "2026-10-02T11:40:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );
  const admission = await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "running-manifest-change-request",
    target,
  });
  await firstProcess.close();

  const changedProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    executionManifestVersion: 2,
    identifierNamespace: "changed-",
    now: "2026-10-02T11:41:00.000Z",
    providerPlan: [{ kind: "production.observe" }],
  });
  const record =
    admission.decision === "admitted"
      ? await changedProcess.readTask(admission.taskId)
      : undefined;

  expect({
    executed: changedProcess.executedOperations,
    status: await changedProcess.readAutonomyStatus(),
    task: record?.task,
  }).toMatchObject({
    executed: [],
    status: {
      body: { taskExecution: { status: "activation-required" } },
      statusCode: 200,
    },
    task: {
      conclusion:
        "The active policy revision does not authorize the configured execution manifest.",
      status: "denied",
    },
  });

  await changedProcess.close();
});

test("provider planning is aborted at the Durable Task execution deadline and ignores a late plan", async () => {
  const clock = { current: "2026-10-02T11:45:00.000Z" };
  const planningDeadlineCallbacks: Array<() => void> = [];
  const providerSignals: Array<AbortSignal | undefined> = [];
  let reportPlanningStarted: (() => void) | undefined;
  const planningStarted = new Promise<void>((resolve) => {
    reportPlanningStarted = resolve;
  });
  let releaseProvider: (() => void) | undefined;
  const providerReleased = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const { scenario } = await createActivatedScenario(
    {
      beforeProviderPlanReturn: async () => providerReleased,
      clock,
      now: clock.current,
      onProviderPlanStart: () => {
        clock.current = "2026-10-02T17:45:00.000Z";
        reportPlanningStarted?.();
      },
      planningDeadlineCallbacks,
      providerPlan: [{ kind: "production.observe" }],
      providerSignals,
    },
    temporaryDirectories,
  );

  try {
    let admissionSettled = false;
    const admissionPromise = scenario
      .confirmAndRunTask({
        confirmation: "confirmed",
        intendedState: "Production health is understood.",
        outcome: "investigate",
        ownerId: "owner",
        requestId: "provider-deadline-request",
        target,
      })
      .then((result) => {
        admissionSettled = true;
        return result;
      });
    await planningStarted;
    planningDeadlineCallbacks[0]?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeProviderRelease = admissionSettled;
    releaseProvider?.();
    const admission = await admissionPromise;
    const record = await scenario.readTask("administrative-task-1");

    expect({
      admission,
      evidenceKinds: record?.evidence.map((event) => event.kind),
      executed: scenario.executedOperations,
      providerSignalAborted: providerSignals[0]?.aborted,
      settledBeforeProviderRelease,
      task: record?.task,
    }).toMatchObject({
      admission: {
        decision: "denied",
        reason: "Administrative Task active-execution deadline elapsed",
      },
      evidenceKinds: [
        "administrative.confirmation.prepared",
        "administrative.confirmation.accepted",
        "administrative.task.denied",
      ],
      executed: [],
      providerSignalAborted: true,
      settledBeforeProviderRelease: true,
      task: {
        conclusion: "Administrative Task active-execution deadline elapsed",
        status: "denied",
      },
    });
  } finally {
    releaseProvider?.();
    await scenario.close();
  }
});

test("a delayed Live Patch arms a fresh thirty-minute rollback and must reconcile before completion", async () => {
  const clock = { current: "2026-10-02T12:00:00.000Z" };
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      clock,
      executorFailures: 1,
      now: clock.current,
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  const admission = await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "delayed-live-patch-request",
    target,
  });
  await firstProcess.close();

  clock.current = "2026-10-02T12:20:00.000Z";
  const restartedProcess = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    identifierNamespace: "restart-",
    now: clock.current,
    providerPlan: [{ kind: "live-patch.apply" }],
  });
  const record =
    admission.decision === "admitted"
      ? await restartedProcess.readTask(admission.taskId)
      : undefined;
  const completed = record?.evidence.find(
    (event) => event.kind === "administrative.operation.completed",
  );

  expect({ admission, completed, task: record?.task }).toMatchObject({
    admission: { decision: "admitted" },
    completed: {
      details: {
        result: {
          mutationProof: {
            independentRollback: {
              armedBeforeMutation: true,
              armedAt: "2026-10-02T12:20:00.000Z",
              rollbackDeadline: "2026-10-02T12:50:00.000Z",
            },
            reconciliation: {
              baseBranch: "registered-production-branch",
              kind: "captured-as-isolated-pull-request",
              observedAt: "2026-10-02T12:20:00.000Z",
              productionMutationRetained: true,
              reconciledPatch: "accepted-live-patch-diff",
              registeredCodebaseId: "voice-agent",
              state: "open",
              verifiedBy: "independent-reconciliation-observer",
            },
          },
        },
      },
    },
    task: { status: "completed" },
  });
  await restartedProcess.close();

  const { scenario: incompleteProof } = await createActivatedScenario(
    {
      omitLivePatchReconciliation: true,
      now: "2026-10-02T13:00:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  const denied = await incompleteProof.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "missing-live-patch-reconciliation-request",
    target,
  });
  expect(denied).toEqual({
    decision: "denied",
    reason:
      "Administrative executor returned incomplete or mismatched bounded proof",
  });
  await incompleteProof.close();

  const { scenario: shortenedRollback } = await createActivatedScenario(
    {
      livePatchRollbackDurationMilliseconds: 29 * 60 * 1_000,
      now: "2026-10-02T13:30:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  const shortened = await shortenedRollback.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "shortened-live-patch-rollback-request",
    target,
  });
  expect(shortened).toEqual({
    decision: "denied",
    reason:
      "Administrative executor returned incomplete or mismatched bounded proof",
  });
  await shortenedRollback.close();

  const rollbackClock = { current: "2026-10-02T13:45:00.000Z" };
  const { scenario: expiredBeforeMutation } = await createActivatedScenario(
    {
      afterLivePatchRollbackArmed: async () => {
        rollbackClock.current = "2026-10-02T14:16:00.000Z";
      },
      clock: rollbackClock,
      now: rollbackClock.current,
      operationLeaseMilliseconds: 40 * 60 * 1_000,
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  const staleRollback = await expiredBeforeMutation.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "expired-live-patch-rollback-request",
    target,
  });
  expect(staleRollback).toEqual({
    decision: "denied",
    reason:
      "Administrative executor returned incomplete or mismatched bounded proof",
  });
  await expiredBeforeMutation.close();
});

test("a Live Patch armed before a delayed mutation retains thirty minutes after mutation", async () => {
  const clock = { current: "2026-10-02T13:50:00.000Z" };
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const { scenario } = await createActivatedScenario(
    {
      afterLivePatchRollbackArmed: async () => {
        clock.current = "2026-10-02T13:51:00.000Z";
      },
      clock,
      now: clock.current,
      operationLeaseMilliseconds: 2 * 60 * 1_000,
      providerPlan: [{ kind: "live-patch.apply" }],
      rollbackActivationAttempts,
    },
    temporaryDirectories,
  );
  const admission = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "delayed-after-arming-live-patch-request",
    target,
  });
  const record =
    admission.decision === "admitted"
      ? await scenario.readTask(admission.taskId)
      : undefined;
  const completed = record?.evidence.find(
    (event) => event.kind === "administrative.operation.completed",
  );
  await scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });

  expect({
    admission,
    completed,
    rollbackRequest: rollbackActivationAttempts[0],
    task: record?.task,
  }).toMatchObject({
    admission: { decision: "admitted" },
    completed: {
      details: {
        result: {
          mutationProof: {
            independentRollback: {
              armedAt: "2026-10-02T13:50:00.000Z",
              rollbackDeadline: "2026-10-02T14:21:00.000Z",
            },
            mutationStartedAt: "2026-10-02T13:51:00.000Z",
          },
        },
      },
    },
    rollbackRequest: {
      armedAt: "2026-10-02T13:50:00.000Z",
      armedRollbackDeadline: "2026-10-02T14:20:00.000Z",
      mutationAuthorizedAt: "2026-10-02T13:51:00.000Z",
      rollbackDeadline: "2026-10-02T14:21:00.000Z",
    },
    task: { status: "completed" },
  });

  await scenario.close();
});

test("authenticated Administrative Suspension is durable and blocks new admission", async () => {
  const { scenario } = await createActivatedScenario(
    {
      now: "2026-10-02T14:00:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );
  const unauthenticated = await scenario.suspendPolicy({
    authenticated: false,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const suspension = await scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const admission = await scenario.prepareTask({
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "post-suspension-request",
    target,
  });

  expect({
    admission,
    status: await scenario.readAutonomyStatus(),
    suspension,
    unauthenticated,
  }).toMatchObject({
    admission: {
      decision: "denied",
      reason: "Administrative Autonomy is not active",
    },
    status: {
      body: {
        policy: { revision: 1, stateVersion: 2, status: "suspended" },
      },
      statusCode: 200,
    },
    suspension: {
      body: { revision: 1, stateVersion: 2, status: "suspended" },
      statusCode: 200,
    },
    unauthenticated: {
      body: { error: "Authentication required" },
      statusCode: 401,
    },
  });

  await scenario.close();
});

test("Administrative Suspension decisions remain immutable after reactivation and restart", async () => {
  const clock = { current: "2026-10-02T14:05:00.000Z" };
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      clock,
      now: clock.current,
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );
  await firstProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  clock.current = "2026-10-02T14:06:00.000Z";
  await firstProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 2,
    freshPasskey: true,
  });
  clock.current = "2026-10-02T14:07:00.000Z";
  await firstProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 2,
    expectedStateVersion: 3,
  });
  clock.current = "2026-10-02T14:08:00.000Z";
  await firstProcess.activatePolicy({
    expectedActiveRevision: 2,
    expectedStateVersion: 4,
    freshPasskey: true,
  });
  await firstProcess.close();

  const restartedProcess = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    identifierNamespace: "suspension-history-restart-",
    now: clock.current,
    providerPlan: [{ kind: "production.observe" }],
  });
  const status = await restartedProcess.readAutonomyStatus();

  expect(status).toMatchObject({
    body: {
      policy: { revision: 3, stateVersion: 5, status: "active" },
      policyEvidence: {
        events: [
          {
            details: { policyRevision: 1, resultingStateVersion: 2 },
            kind: "administrative.policy.suspended",
            occurredAt: "2026-10-02T14:05:00.000Z",
            sequence: 1,
          },
          {
            details: { policyRevision: 2, resultingStateVersion: 4 },
            kind: "administrative.policy.suspended",
            occurredAt: "2026-10-02T14:07:00.000Z",
            sequence: 2,
          },
        ],
        totalCount: 2,
        truncated: false,
      },
    },
    statusCode: 200,
  });

  await restartedProcess.close();
});

test("every Administrative Suspension decision remains queryable through bounded history pages", async () => {
  const clock = { current: "2026-10-03T00:00:00.000Z" };
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      clock,
      now: clock.current,
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );

  for (let index = 1; index <= 101; index += 1) {
    clock.current = new Date(
      Date.UTC(2026, 9, 3, 0, 0, index),
    ).toISOString();
    expect(
      await firstProcess.suspendPolicy({
        authenticated: true,
        expectedRevision: index,
        expectedStateVersion: index * 2 - 1,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      await firstProcess.activatePolicy({
        expectedActiveRevision: index,
        expectedStateVersion: index * 2,
        freshPasskey: true,
      }),
    ).toMatchObject({ statusCode: 200 });
  }
  await firstProcess.close();

  const restarted = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    identifierNamespace: "policy-history-restart-",
    now: clock.current,
    providerPlan: [{ kind: "production.observe" }],
  });
  const latestResponse = await restarted.readPolicyEvidencePage();
  const latest = administrativePolicyEvidencePageSchema.parse(
    latestResponse.body,
  );
  if (latest.nextBeforeSequence === null) {
    throw new Error("The bounded policy history page lost its continuation");
  }
  const earlierResponse = await restarted.readPolicyEvidencePage({
    beforeSequence: latest.nextBeforeSequence,
  });
  const earlier = administrativePolicyEvidencePageSchema.parse(
    earlierResponse.body,
  );
  const events = [...earlier.events, ...latest.events];

  expect({
    earlierResponse: earlierResponse.statusCode,
    eventCount: events.length,
    first: events[0],
    latestResponse: latestResponse.statusCode,
    last: events.at(-1),
    sequences: events.map((event) => event.sequence),
  }).toMatchObject({
    earlierResponse: 200,
    eventCount: 101,
    first: {
      details: { policyRevision: 1, resultingStateVersion: 2 },
      kind: "administrative.policy.suspended",
      sequence: 1,
    },
    latestResponse: 200,
    last: {
      details: { policyRevision: 101, resultingStateVersion: 202 },
      kind: "administrative.policy.suspended",
      sequence: 101,
    },
    sequences: Array.from({ length: 101 }, (_, index) => index + 1),
  });
  expect(earlier).toMatchObject({
    events: [{ sequence: 1 }],
    hasMore: false,
    nextBeforeSequence: null,
    totalCount: 101,
  });
  expect(latest).toMatchObject({
    hasMore: true,
    nextBeforeSequence: 2,
    totalCount: 101,
  });

  await restarted.close();
});

test("Administrative Suspension aborts an armed Live Patch before mutation and activates its rollback", async () => {
  let reportArmed: (() => void) | undefined;
  const armed = new Promise<void>((resolve) => {
    reportArmed = resolve;
  });
  let releaseExecutor: (() => void) | undefined;
  const executorReleased = new Promise<void>((resolve) => {
    releaseExecutor = resolve;
  });
  const effectLedger = new Set<string>();
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const rollbackActivationLedger = new Set<string>();
  const { scenario } = await createActivatedScenario(
    {
      afterLivePatchRollbackArmed: async () => {
        reportArmed?.();
        await executorReleased;
      },
      effectLedger,
      now: "2026-10-02T14:15:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
      rollbackActivationAttempts,
      rollbackActivationLedger,
    },
    temporaryDirectories,
  );
  const admission = scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "in-flight-suspension-request",
    target,
  });
  await armed;
  const suspension = await scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  releaseExecutor?.();

  expect({
    admission: await admission,
    effects: [...effectLedger],
    rollbackActivationAttempts,
    rollbackActivationLedger: [...rollbackActivationLedger],
    suspension,
    task: await scenario.readTask("administrative-task-1"),
  }).toMatchObject({
    admission: { decision: "admitted" },
    effects: [],
    rollbackActivationAttempts: [
      {
        kind: "activate-armed-live-patch-rollback",
        operationId: "administrative-operation-1",
        taskId: "administrative-task-1",
        target,
      },
    ],
    rollbackActivationLedger: ["administrative-operation-1"],
    suspension: {
      body: {
        rollbackActivations: {
          activatedOperationIds: ["administrative-operation-1"],
          pendingOperationIds: [],
        },
        status: "suspended",
      },
      statusCode: 200,
    },
    task: { task: { status: "running" } },
  });

  await scenario.close();
});

test("Administrative Suspension retains failed Live Patch rollback activation for restart", async () => {
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const rollbackActivationLedger = new Set<string>();
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      now: "2026-10-02T14:30:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
      rollbackActivationAttempts,
      rollbackActivationFailures: 1,
      rollbackActivationLedger,
    },
    temporaryDirectories,
  );
  await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "suspension-rollback-request",
    target,
  });
  const suspension = await firstProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const failedStatus = await firstProcess.readAutonomyStatus();
  await firstProcess.close();

  const restartedProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    identifierNamespace: "suspension-restart-",
    now: "2026-10-02T14:31:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
    rollbackActivationLedger,
  });
  const restartedStatus = await restartedProcess.readAutonomyStatus();
  const repeatedSuspension = await restartedProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const blockedAdmission = await restartedProcess.prepareTask({
    intendedState: "No additional production effect occurs.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "suspension-blocked-request",
    target,
  });

  expect({
    blockedAdmission,
    failedStatus,
    repeatedSuspension,
    restartedStatus,
    rollbackActivationAttempts,
    rollbackActivationLedger: [...rollbackActivationLedger],
    suspension,
  }).toMatchObject({
    blockedAdmission: {
      decision: "denied",
      reason: "Administrative Autonomy is not active",
    },
    failedStatus: {
      body: {
        policy: {
          rollbackActivations: {
            activatedOperationIds: [],
            pendingOperationIds: ["administrative-operation-1"],
          },
          status: "suspended",
        },
      },
      statusCode: 200,
    },
    repeatedSuspension: {
      body: {
        rollbackActivations: {
          activatedOperationIds: ["administrative-operation-1"],
          pendingOperationIds: [],
        },
        status: "suspended",
      },
      statusCode: 200,
    },
    restartedStatus: {
      body: {
        policy: {
          rollbackActivations: {
            activatedOperationIds: ["administrative-operation-1"],
            pendingOperationIds: [],
          },
          status: "suspended",
        },
      },
      statusCode: 200,
    },
    rollbackActivationAttempts: [
      {
        kind: "activate-armed-live-patch-rollback",
        operationId: "administrative-operation-1",
        taskId: "administrative-task-1",
        target,
      },
      {
        kind: "activate-armed-live-patch-rollback",
        operationId: "administrative-operation-1",
        taskId: "administrative-task-1",
        target,
      },
    ],
    rollbackActivationLedger: ["administrative-operation-1"],
    suspension: {
      body: {
        rollbackActivations: {
          activatedOperationIds: [],
          pendingOperationIds: ["administrative-operation-1"],
        },
        status: "suspended",
      },
      statusCode: 200,
    },
  });

  await restartedProcess.close();
});

test("Administrative Suspension bounds historical rollback status while preserving every unresolved activation", async () => {
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const rollbackActivationLedger = new Set<string>();
  const { databasePath, scenario: firstProcess } =
    await createActivatedScenario(
      {
        now: "2026-10-02T14:40:00.000Z",
        providerPlan: [{ kind: "live-patch.apply" }],
        rollbackActivationAttempts,
        rollbackActivationFailures: 101,
        rollbackActivationLedger,
      },
      temporaryDirectories,
    );

  for (let index = 1; index <= 101; index += 1) {
    const admission = await firstProcess.confirmAndRunTask({
      confirmation: "confirmed",
      intendedState: `Production behavior ${index} is restored.`,
      outcome: "restore",
      ownerId: "owner",
      requestId: `historical-live-patch-${index}`,
      target,
    });
    expect(admission).toMatchObject({ decision: "admitted" });
  }

  const suspension = await firstProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const blockedAdmission = await firstProcess.prepareTask({
    intendedState: "No new work starts while suspension is incomplete.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "post-bulk-suspension",
    target,
  });

  expect({ blockedAdmission, suspension }).toMatchObject({
    blockedAdmission: {
      decision: "denied",
      reason: "Administrative Autonomy is not active",
    },
    suspension: {
      body: {
        rollbackActivations: {
          activatedOperationCount: 0,
          activatedOperationIds: [],
          activatedOperationIdsTruncated: false,
          pendingOperationCount: 101,
          pendingOperationIdsTruncated: true,
        },
        status: "suspended",
      },
      statusCode: 200,
    },
  });
  expect(
    (
      suspension.body as {
        rollbackActivations: { pendingOperationIds: string[] };
      }
    ).rollbackActivations.pendingOperationIds,
  ).toHaveLength(100);
  expect(rollbackActivationAttempts).toHaveLength(101);
  await firstProcess.close();

  const restarted = await createAdministrativeAutonomyScenario({
    databasePath,
    identifierNamespace: "bulk-restart-",
    now: "2026-10-02T14:41:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
    rollbackActivationLedger,
  });
  const reconciled = await restarted.readPolicyStatus();

  expect(reconciled).toMatchObject({
    rollbackActivations: {
      activatedOperationCount: 101,
      activatedOperationIdsTruncated: true,
      pendingOperationCount: 0,
      pendingOperationIds: [],
      pendingOperationIdsTruncated: false,
    },
    status: "suspended",
  });
  if (reconciled.status !== "suspended") {
    throw new Error("Administrative Suspension was unexpectedly reopened");
  }
  expect(reconciled.rollbackActivations.activatedOperationIds).toHaveLength(100);
  expect(rollbackActivationLedger).toHaveLength(101);

  await restarted.close();
});

test("pending Live Patch rollback activation blocks Fresh Passkey reactivation until restart recovery", async () => {
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const rollbackActivationLedger = new Set<string>();
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      now: "2026-10-02T14:35:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
      rollbackActivationAttempts,
      rollbackActivationFailures: 2,
      rollbackActivationLedger,
    },
    temporaryDirectories,
  );
  await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "pending-reactivation-request",
    target,
  });
  await firstProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const blockedReactivation = await firstProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 2,
    freshPasskey: true,
  });
  const stillPending = await firstProcess.readPolicyStatus();
  await firstProcess.close();

  const mismatchedProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    executionImplementationVersions: {
      executor: 2,
      provider: 2,
      rollbackActivator: 2,
    },
    executionManifestVersion: 2,
    identifierNamespace: "pending-reactivation-mismatch-",
    now: "2026-10-02T14:36:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
    rollbackActivationLedger,
  });
  const mismatchStatus = await mismatchedProcess.readPolicyStatus();
  const mismatchReactivation = await mismatchedProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 2,
    freshPasskey: true,
  });
  await mismatchedProcess.close();

  const recoveryProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    identifierNamespace: "pending-reactivation-recovery-",
    now: "2026-10-02T14:37:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
    rollbackActivationLedger,
  });
  const recovered = await recoveryProcess.readPolicyStatus();
  await recoveryProcess.close();

  const replacementProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    executionImplementationVersions: {
      executor: 2,
      provider: 2,
      rollbackActivator: 2,
    },
    executionManifestVersion: 2,
    identifierNamespace: "pending-reactivation-replacement-",
    now: "2026-10-02T14:38:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
    rollbackActivationLedger,
  });
  const reactivated = await replacementProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 2,
    freshPasskey: true,
  });

  expect({
    attempts: rollbackActivationAttempts.map((request) => request.operationId),
    blockedReactivation,
    mismatchReactivation,
    mismatchStatus,
    reactivated,
    recovered,
    stillPending,
  }).toMatchObject({
    attempts: [
      "administrative-operation-1",
      "administrative-operation-1",
      "administrative-operation-1",
    ],
    blockedReactivation: {
      body: {
        error:
          "Administrative Suspension has pending Live Patch rollback activation",
      },
      statusCode: 409,
    },
    mismatchReactivation: {
      body: {
        error:
          "Administrative Suspension has pending Live Patch rollback activation",
      },
      statusCode: 409,
    },
    mismatchStatus: {
      rollbackActivations: {
        activatedOperationIds: [],
        pendingOperationIds: ["administrative-operation-1"],
      },
      status: "suspended",
    },
    reactivated: {
      body: { revision: 2, stateVersion: 3, status: "active" },
      statusCode: 200,
    },
    recovered: {
      rollbackActivations: {
        activatedOperationIds: ["administrative-operation-1"],
        pendingOperationIds: [],
      },
      status: "suspended",
    },
    stillPending: {
      rollbackActivations: {
        activatedOperationIds: [],
        pendingOperationIds: ["administrative-operation-1"],
      },
      status: "suspended",
    },
  });

  await replacementProcess.close();
});

test("an armed Live Patch blocks manifest replacement and retains its rollback implementation identity", async () => {
  const effectLedger = new Set<string>();
  const livePatchProofLedger = new Map();
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      crashAfterFirstEffect: true,
      effectLedger,
      livePatchProofLedger,
      now: "2026-10-02T14:40:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "armed-manifest-replacement-request",
    target,
  });
  await firstProcess.close();

  const mismatchedProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    executionImplementationVersions: {
      executor: 2,
      provider: 2,
      rollbackActivator: 2,
    },
    executionManifestVersion: 2,
    identifierNamespace: "armed-mismatch-",
    now: "2026-10-02T14:41:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
  });
  const replacement = await mismatchedProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 1,
    freshPasskey: true,
  });
  const suspension = await mismatchedProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  await mismatchedProcess.close();

  const matchingProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    identifierNamespace: "armed-recovery-",
    now: "2026-10-02T14:42:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
  });
  const recovered = await matchingProcess.readPolicyStatus();

  expect({
    activatorAuthority: rollbackActivationAttempts[0]?.authority,
    activatorAttempts: rollbackActivationAttempts.map(
      (request) => request.operationId,
    ),
    recovered,
    replacement,
    suspension,
  }).toMatchObject({
    activatorAuthority: {
      executionManifest: {
        operationAdapters: [
          { kind: "production.observe" },
          { kind: "delegated-worktree.change" },
          {
            kind: "live-patch.apply",
            rollbackActivationImplementationDigest:
              "4444444444444444444444444444444444444444444444444444444444444444",
          },
        ],
      },
      policyRevision: 1,
      policyStateVersion: 1,
    },
    activatorAttempts: ["administrative-operation-1"],
    recovered: {
      rollbackActivations: {
        activatedOperationIds: ["administrative-operation-1"],
        pendingOperationIds: [],
      },
      status: "suspended",
    },
    replacement: {
      body: { error: "Administrative Autonomy policy state is stale" },
      statusCode: 409,
    },
    suspension: {
      body: {
        rollbackActivations: {
          activatedOperationIds: [],
          pendingOperationIds: ["administrative-operation-1"],
        },
        status: "suspended",
      },
      statusCode: 200,
    },
  });

  await matchingProcess.close();
});

test("Administrative Suspension replays rollback activation without repeating its effect", async () => {
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const rollbackActivationEffects: string[] = [];
  const rollbackActivationLedger = new Set<string>();
  const rollbackActivationTimeLedger = new Map();
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      crashAfterFirstRollbackActivation: true,
      now: "2026-10-02T14:40:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
      rollbackActivationAttempts,
      rollbackActivationEffects,
      rollbackActivationLedger,
      rollbackActivationTimeLedger,
    },
    temporaryDirectories,
  );
  await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "rollback-post-effect-crash-request",
    target,
  });
  const suspension = await firstProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  await firstProcess.close();

  const restartedProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    identifierNamespace: "rollback-replay-",
    now: "2026-10-02T14:41:00.000Z",
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
    rollbackActivationEffects,
    rollbackActivationLedger,
    rollbackActivationTimeLedger,
  });
  const rollbackEvidence = (
    await restartedProcess.readTask("administrative-task-1")
  )?.evidence.filter(
    (event) => event.kind === "administrative.live-patch.rollback-activated",
  );

  expect({
    attempts: rollbackActivationAttempts.map((request) => request.operationId),
    effects: rollbackActivationEffects,
    rollbackEvidence,
    restarted: await restartedProcess.readPolicyStatus(),
    suspension,
  }).toMatchObject({
    attempts: ["administrative-operation-1", "administrative-operation-1"],
    effects: ["administrative-operation-1"],
    rollbackEvidence: [
      {
        details: {
          operationId: "administrative-operation-1",
          result: {
            outcome: "already-activated",
            productionMutationRetained: false,
          },
        },
        kind: "administrative.live-patch.rollback-activated",
        occurredAt: "2026-10-02T14:40:00.000Z",
      },
    ],
    restarted: {
      rollbackActivations: {
        activatedOperationIds: ["administrative-operation-1"],
        pendingOperationIds: [],
      },
      status: "suspended",
    },
    suspension: {
      body: {
        rollbackActivations: {
          activatedOperationIds: [],
          pendingOperationIds: ["administrative-operation-1"],
        },
        status: "suspended",
      },
      statusCode: 200,
    },
  });

  await restartedProcess.close();
});

test("a Live Patch crash after its effect replays the original durable safety proof", async () => {
  const clock = { current: "2026-10-02T15:00:00.000Z" };
  const effectLedger = new Set<string>();
  const livePatchProofLedger = new Map();
  const operationAttempts: string[] = [];
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      clock,
      crashAfterFirstEffect: true,
      effectLedger,
      livePatchProofLedger,
      now: clock.current,
      operationAttempts,
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  const admission = await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "live-patch-post-effect-crash-request",
    target,
  });
  await firstProcess.close();

  clock.current = "2026-10-02T15:01:00.000Z";
  const restartedProcess = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    effectLedger,
    identifierNamespace: "live-restart-",
    livePatchProofLedger,
    now: clock.current,
    operationAttempts,
    providerPlan: [{ kind: "live-patch.apply" }],
  });
  const record =
    admission.decision === "admitted"
      ? await restartedProcess.readTask(admission.taskId)
      : undefined;
  const completion = record?.evidence.find(
    (event) => event.kind === "administrative.operation.completed",
  );

  expect({
    effectCount: effectLedger.size,
    operationAttempts,
    result:
      completion?.kind === "administrative.operation.completed"
        ? completion.details.result
        : undefined,
    task: record?.task,
  }).toMatchObject({
    effectCount: 1,
    operationAttempts: [
      "administrative-operation-1",
      "administrative-operation-1",
    ],
    result: {
      effect: {
        kind: "idempotent-effect-replay",
        originallyStartedAt: "2026-10-02T15:00:00.000Z",
        replayedAt: "2026-10-02T15:01:00.000Z",
      },
      mutationProof: {
        independentRollback: {
          armedAt: "2026-10-02T15:00:00.000Z",
          rollbackDeadline: "2026-10-02T15:30:00.000Z",
        },
        mutationStartedAt: "2026-10-02T15:00:00.000Z",
      },
    },
    task: { status: "completed" },
  });

  await restartedProcess.close();
});
