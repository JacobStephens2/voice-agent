import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

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

test("an activated adapter manifest cannot gain authority after Human Merge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-administrative-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const policyProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    executionAdapters: "unavailable",
    now: "2026-10-02T10:00:00.000Z",
    providerPlan: [{ kind: "production.observe" }],
  });
  await policyProcess.activatePolicy({
    expectedActiveRevision: null,
    expectedStateVersion: 0,
    freshPasskey: true,
  });
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
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-administrative-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const firstProcess = await createAdministrativeAutonomyScenario({
    databasePath,
    executorFailures: 1,
    now: "2026-10-02T11:40:00.000Z",
    providerPlan: [{ kind: "production.observe" }],
  });
  await firstProcess.activatePolicy({
    expectedActiveRevision: null,
    expectedStateVersion: 0,
    freshPasskey: true,
  });
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

test("a delayed Live Patch arms a fresh thirty-minute rollback and must reconcile before completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-administrative-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const clock = { current: "2026-10-02T12:00:00.000Z" };
  const firstProcess = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    executorFailures: 1,
    now: clock.current,
    providerPlan: [{ kind: "live-patch.apply" }],
  });
  await firstProcess.activatePolicy({
    expectedActiveRevision: null,
    expectedStateVersion: 0,
    freshPasskey: true,
  });
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
  const { scenario: armedTooEarly } = await createActivatedScenario(
    {
      beforeOperationEffect: async () => {
        rollbackClock.current = "2026-10-02T13:46:00.000Z";
      },
      clock: rollbackClock,
      livePatchRollbackArmLeadMilliseconds: 60 * 1_000,
      now: rollbackClock.current,
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  const reducedPostMutationWindow = await armedTooEarly.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "early-armed-live-patch-rollback-request",
    target,
  });
  expect(reducedPostMutationWindow).toEqual({
    decision: "denied",
    reason:
      "Administrative executor returned incomplete or mismatched bounded proof",
  });
  await armedTooEarly.close();
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

test("a Live Patch crash after its effect replays the original durable safety proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-administrative-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const clock = { current: "2026-10-02T15:00:00.000Z" };
  const effectLedger = new Set<string>();
  const livePatchProofLedger = new Map();
  const operationAttempts: string[] = [];
  const firstProcess = await createAdministrativeAutonomyScenario({
    clock,
    crashAfterFirstEffect: true,
    databasePath,
    effectLedger,
    livePatchProofLedger,
    now: clock.current,
    operationAttempts,
    providerPlan: [{ kind: "live-patch.apply" }],
  });
  await firstProcess.activatePolicy({
    expectedActiveRevision: null,
    expectedStateVersion: 0,
    freshPasskey: true,
  });
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
