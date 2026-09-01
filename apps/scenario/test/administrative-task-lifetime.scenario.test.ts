import { rm } from "node:fs/promises";

import { afterEach, expect, test } from "vitest";

import { administrativeActiveExecutionMilliseconds } from "@voice-agent/contracts";

import { createAdministrativeAutonomyScenario } from "../src/administrative-autonomy.ts";
import { createActivatedScenario } from "./administrative-autonomy.fixture.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

const target = {
  environment: "production",
  registeredCodebaseId: "voice-agent",
} as const;

test("quota-blocked time does not consume the six-hour active-execution budget", async () => {
  const clock = { current: "2026-10-02T00:00:00.000Z" };
  const { scenario } = await createActivatedScenario(
    {
      clock,
      executorPauses: ["quota-blocked"],
      now: clock.current,
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );

  // One minute of work, then the provider's quota runs out.
  clock.current = "2026-10-02T00:01:00.000Z";
  const admission = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "quota-pause-request",
    target,
  });
  const paused = await scenario.readTask("administrative-task-1");

  // Two days of quota exhaustion pass. Wall clock alone must not end the Task.
  clock.current = "2026-10-04T00:01:00.000Z";
  const resumed = await scenario.resumeTask("administrative-task-1");
  const record = await scenario.readTask("administrative-task-1");

  expect({
    admission,
    executed: scenario.executedOperations.map((request) => request.kind),
    paused: paused?.task,
    pausedEvent: paused?.evidence.find(
      (event) => event.kind === "administrative.task.paused",
    ),
    resumed,
    task: record?.task,
  }).toMatchObject({
    admission: { decision: "admitted" },
    executed: ["production.observe"],
    paused: {
      activeExecutionConsumedMilliseconds: 0,
      activeExecutionDeadline: null,
      executionPause: {
        pausedAt: "2026-10-02T00:01:00.000Z",
        reason: "quota-blocked",
      },
      status: "running",
    },
    pausedEvent: {
      details: {
        consumedMilliseconds: 0,
        reason: "quota-blocked",
        remainingMilliseconds: administrativeActiveExecutionMilliseconds,
      },
    },
    resumed: { statusCode: 200 },
    task: {
      // The whole budget survived, measured from the moment work resumed.
      activeExecutionDeadline: "2026-10-04T06:01:00.000Z",
      executionPause: null,
      status: "completed",
    },
  });

  await scenario.close();
});

test("a paused Task banks the budget it spent and resumes with the remainder", async () => {
  const clock = { current: "2026-10-02T02:00:00.000Z" };
  const { scenario } = await createActivatedScenario(
    {
      clock,
      executorPauses: ["provider-paused"],
      now: clock.current,
      // One hour of active execution before the provider pauses. The resumed
      // attempt must not rewind the clock, so it advances only once.
      onOperationStart: () => {
        if (clock.current === "2026-10-02T02:00:00.000Z") {
          clock.current = "2026-10-02T03:00:00.000Z";
        }
      },
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );

  await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "banked-budget-request",
    target,
  });
  const pausedAgain = await scenario.readTask("administrative-task-1");
  clock.current = "2026-10-05T00:00:00.000Z";
  await scenario.resumeTask("administrative-task-1");
  const record = await scenario.readTask("administrative-task-1");

  expect({
    paused: pausedAgain?.task.executionPause,
    resumedEvent: record?.evidence.find(
      (event) => event.kind === "administrative.task.resumed",
    ),
    spent: pausedAgain?.task.activeExecutionConsumedMilliseconds,
    status: record?.task.status,
  }).toMatchObject({
    paused: { reason: "provider-paused" },
    resumedEvent: {
      details: {
        // One hour was spent before the pause, five hours remain.
        consumedMilliseconds: 60 * 60 * 1_000,
        pausedFor: "provider-paused",
        remainingMilliseconds: 5 * 60 * 60 * 1_000,
      },
    },
    spent: 60 * 60 * 1_000,
    status: "completed",
  });

  await scenario.close();
});

test("a paused Task and its banked budget survive a service restart", async () => {
  const clock = { current: "2026-10-02T04:00:00.000Z" };
  const activated = await createActivatedScenario(
    {
      clock,
      executorPauses: ["owner-waiting"],
      now: clock.current,
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );
  await activated.scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "restart-pause-request",
    target,
  });
  await activated.scenario.close();

  const restarted = await createAdministrativeAutonomyScenario({
    databasePath: activated.databasePath,
    identifierNamespace: "paused-restart-",
    now: "2026-10-06T04:00:00.000Z",
    providerPlan: [{ kind: "production.observe" }],
  });
  const afterRestart = await restarted.readTask("administrative-task-1");
  await restarted.reconcileOperations();
  const afterReconcile = await restarted.readTask("administrative-task-1");
  const executedWhilePaused = [
    ...restarted.executedOperations.map((request) => request.kind),
  ];
  const resumed = await restarted.resumeTask("administrative-task-1");

  expect({
    afterReconcile: afterReconcile?.task,
    afterRestart: afterRestart?.task,
    executed: executedWhilePaused,
    resumed: { statusCode: resumed.statusCode },
    settled: (await restarted.readTask("administrative-task-1"))?.task.status,
  }).toMatchObject({
    // Recovery must not resume a paused Task on its own, and must not
    // fail it closed for a deadline it is not spending.
    afterReconcile: { executionPause: { reason: "owner-waiting" }, status: "running" },
    afterRestart: {
      activeExecutionDeadline: null,
      executionPause: { reason: "owner-waiting" },
      status: "running",
    },
    executed: [],
    resumed: { statusCode: 200 },
    settled: "completed",
  });

  await restarted.close();
});

test("Stop refuses future work, preserves evidence, and is terminal after restart", async () => {
  const clock = { current: "2026-10-02T05:00:00.000Z" };
  const activated = await createActivatedScenario(
    {
      clock,
      executorPauses: ["owner-waiting"],
      now: clock.current,
      providerPlan: [
        { kind: "production.observe" },
        { kind: "delegated-worktree.change" },
      ],
    },
    temporaryDirectories,
  );
  await activated.scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The isolated branch contains the requested change.",
    outcome: "repair",
    ownerId: "owner",
    requestId: "stop-request",
    target,
  });

  const stopped = await activated.scenario.stopTask("administrative-task-1");
  const record = await activated.scenario.readTask("administrative-task-1");
  await activated.scenario.reconcileOperations();
  const afterReconcile = await activated.scenario.readTask(
    "administrative-task-1",
  );
  await activated.scenario.close();

  const restarted = await createAdministrativeAutonomyScenario({
    databasePath: activated.databasePath,
    identifierNamespace: "stopped-restart-",
    now: "2026-10-02T05:30:00.000Z",
    providerPlan: [
      { kind: "production.observe" },
      { kind: "delegated-worktree.change" },
    ],
  });
  await restarted.reconcileOperations();
  const afterRestart = await restarted.readTask("administrative-task-1");

  expect({
    afterReconcile: afterReconcile?.task.status,
    afterRestart: afterRestart?.task.status,
    evidenceAfterStop: record?.evidence.map((event) => event.kind),
    executedAfterRestart: restarted.executedOperations,
    stopped,
    stoppedEvent: record?.evidence.find(
      (event) => event.kind === "administrative.task.stopped",
    ),
    task: record?.task,
  }).toMatchObject({
    afterReconcile: "stopped",
    afterRestart: "stopped",
    executedAfterRestart: [],
    stopped: {
      body: { decision: "stopped", task: { status: "stopped" } },
      statusCode: 200,
    },
    stoppedEvent: {
      details: {
        compensatingOperationIds: [],
        policyRevision: 1,
        preservedWorktrees: true,
        stoppedOperationIds: [
          "administrative-operation-1",
          "administrative-operation-2",
        ],
      },
    },
    task: {
      conclusion: "The owner stopped the Administrative Task.",
      status: "stopped",
    },
  });
  // Stop preserves everything the Task had already recorded.
  expect(record?.evidence.map((event) => event.kind)).toEqual(
    expect.arrayContaining([
      "administrative.confirmation.prepared",
      "administrative.confirmation.accepted",
      "administrative.plan.accepted",
      "administrative.task.stopped",
    ]),
  );

  await restarted.close();
});

test("Stop activates the armed rollback of the live mutation it interrupts", async () => {
  const rollbackActivationEffects: string[] = [];
  let runningScenario:
    | Awaited<ReturnType<typeof createActivatedScenario>>["scenario"]
    | undefined;
  const activated = await createActivatedScenario(
    {
      beforeExecutorResultReturn: async (request) => {
        if (request.kind === "live-patch.apply") {
          await runningScenario?.stopTask("administrative-task-1");
        }
      },
      now: "2026-10-02T06:00:00.000Z",
      providerPlan: [{ kind: "live-patch.apply" }],
      rollbackActivationEffects,
    },
    temporaryDirectories,
  );
  runningScenario = activated.scenario;

  await runningScenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The bounded production response is restored.",
    outcome: "repair",
    ownerId: "owner",
    requestId: "stop-live-patch-request",
    target,
  });
  const record = await runningScenario.readTask("administrative-task-1");

  expect({
    activated: record?.evidence.filter(
      (event) => event.kind === "administrative.live-patch.rollback-activated",
    ),
    rollbackActivationEffects,
    status: record?.task.status,
    stopped: record?.evidence.find(
      (event) => event.kind === "administrative.task.stopped",
    ),
  }).toMatchObject({
    activated: [{ details: { operationId: "administrative-operation-1" } }],
    rollbackActivationEffects: ["administrative-operation-1"],
    status: "stopped",
    stopped: {
      details: {
        compensatingOperationIds: ["administrative-operation-1"],
        preservedWorktrees: true,
      },
    },
  });

  await runningScenario.close();
});

test("Stop and resume refuse an unauthenticated caller and a forged CSRF token", async () => {
  const { scenario } = await createActivatedScenario(
    {
      executorPauses: ["owner-waiting"],
      now: "2026-10-02T07:00:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );
  await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "stop-authorization-request",
    target,
  });

  expect({
    resumeUnauthenticated: (
      await scenario.resumeTask("administrative-task-1", "unauthenticated")
    ).statusCode,
    stopUnauthenticated: (
      await scenario.stopTask("administrative-task-1", "unauthenticated")
    ).statusCode,
    stopWrongCsrf: (
      await scenario.stopTask("administrative-task-1", "wrong-csrf")
    ).statusCode,
    stopWrongSession: (
      await scenario.stopTask("administrative-task-1", "wrong-session")
    ).statusCode,
    task: (await scenario.readTask("administrative-task-1"))?.task.status,
  }).toMatchObject({
    resumeUnauthenticated: 401,
    stopUnauthenticated: 401,
    stopWrongCsrf: 403,
    stopWrongSession: 403,
    task: "running",
  });

  await scenario.close();
});

test("Stop is idempotent and refuses a Task that already finished", async () => {
  const { scenario } = await createActivatedScenario(
    {
      now: "2026-10-02T08:00:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );
  await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "stop-completed-request",
    target,
  });

  const stopCompleted = await scenario.stopTask("administrative-task-1");
  const resumeRunning = await scenario.resumeTask("administrative-task-1");

  expect({ resumeRunning, stopCompleted }).toMatchObject({
    resumeRunning: {
      body: { decision: "denied", reason: "The Administrative Task is not running" },
      statusCode: 409,
    },
    stopCompleted: {
      body: {
        decision: "denied",
        reason: "The Administrative Task is not running",
      },
      statusCode: 409,
    },
  });

  await scenario.close();
});

test("Administrative Suspension needs the authenticated PWA session and blocks new work", async () => {
  const { scenario } = await createActivatedScenario(
    {
      now: "2026-10-02T09:00:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );

  const unauthenticated = await scenario.suspendPolicy({
    authenticated: false,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const suspended = await scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const blocked = await scenario.prepareTask({
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "suspended-blocked-request",
    target,
  });
  const withoutFreshPasskey = await scenario.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 2,
    freshPasskey: false,
  });
  const withFreshPasskey = await scenario.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 2,
    freshPasskey: true,
  });

  expect({
    blocked,
    suspended,
    unauthenticated: unauthenticated.statusCode,
    withFreshPasskey,
    withoutFreshPasskey,
  }).toMatchObject({
    blocked: {
      decision: "denied",
      reason: "Administrative Autonomy is not active",
    },
    suspended: {
      body: { revision: 1, stateVersion: 2, status: "suspended" },
      statusCode: 200,
    },
    unauthenticated: 401,
    withFreshPasskey: {
      body: { revision: 2, status: "active" },
      statusCode: 200,
    },
    withoutFreshPasskey: {
      body: { error: "Fresh Passkey Action required" },
      statusCode: 403,
    },
  });

  await scenario.close();
});

test("read-only observation runs while a mutation holds the global lane", async () => {
  let releaseMutation!: () => void;
  let reportMutation!: () => void;
  const mutationStarted = new Promise<void>((resolve) => {
    reportMutation = resolve;
  });
  const mutationRelease = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const { scenario } = await createActivatedScenario(
    {
      beforeOperationEffect: async (request) => {
        if (request.kind !== "delegated-worktree.change") return;
        reportMutation();
        await mutationRelease;
      },
      now: "2026-10-02T10:00:00.000Z",
      providerPlan: [{ kind: "delegated-worktree.change" }],
      providerPlanByTaskId: {
        "administrative-task-2": [{ kind: "production.observe" }],
      },
    },
    temporaryDirectories,
  );

  const mutation = scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The isolated branch contains the requested change.",
    outcome: "repair",
    ownerId: "owner",
    requestId: "concurrent-mutation-request",
    target,
  });
  await mutationStarted;
  // Research is read-only, so it must not queue behind the mutation lane.
  const research = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "concurrent-research-request",
    target,
  });
  const researchTask = await scenario.readTask("administrative-task-2");
  releaseMutation();
  await mutation;

  expect({
    mutation: (await scenario.readTask("administrative-task-1"))?.task.status,
    research,
    researchStatus: researchTask?.task.status,
  }).toMatchObject({
    mutation: "completed",
    research: { decision: "admitted" },
    researchStatus: "completed",
  });

  await scenario.close();
});

test("an executor cannot invent a pause reason to hold the budget open", async () => {
  const { scenario } = await createActivatedScenario(
    {
      executorPauseForgery: "quota-blocked; token sk-live-CANARY",
      now: "2026-10-02T11:00:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );

  const admission = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The production application health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "forged-pause-request",
    target,
  });
  const record = await scenario.readTask("administrative-task-1");

  expect({
    admission: admission.decision,
    paused: record?.task.executionPause,
    pauseEvents: record?.evidence.filter(
      (event) => event.kind === "administrative.task.paused",
    ),
  }).toMatchObject({
    admission: "admitted",
    paused: null,
    pauseEvents: [],
  });
  expect(JSON.stringify(record)).not.toContain("sk-live-CANARY");

  await scenario.close();
});
