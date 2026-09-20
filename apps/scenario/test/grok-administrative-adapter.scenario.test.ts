import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  administrativeExecutionManifestFingerprint,
  administrativeOperationClaimIdSchema,
  administrativeOperationIdSchema,
  administrativePauseReasonFromGrok,
  administrativeRegisteredCodebaseSchema,
  administrativeTaskIdSchema,
  credentialCustodyBoundaryPaths,
  delegationIdSchema,
  grokRunEvidenceSchema,
  grokRunnerPinSchema,
  type GrokPauseReason,
  type GrokRunEvidence,
} from "@voice-agent/contracts";
import {
  composeDeployedAdministrativeGrokExecution,
  createAdministrativeAutonomyRuntime,
  createGrokAdministrativeAdapter,
  createHostGrokAdministrativeRunner,
  grokExecutorIdentity,
  grokPlanRunFromOutcome,
  type GrokAdministrativeRunner,
} from "@voice-agent/runtime";
import { createSqliteAdministrativeAutonomyStore } from "@voice-agent/sqlite-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

const grokPin = grokRunnerPinSchema.parse({
  configurationPath: "/etc/grok/requirements.toml",
  digest: "a".repeat(64),
  version: "1.0.13",
});

const grokEvidence: GrokRunEvidence = grokRunEvidenceSchema.parse({
  apiKeyAuthDisabled: true,
  authenticationRoute: "subscription-oauth",
  credentialAuthMode: "external",
  model: { providerReported: "grok-4.6-build", selector: "grok-4.6" },
  provider: "grok",
  requestId: "req-administrative-1",
  runner: grokPin,
  sessionId: "ses-administrative-1",
  stopReason: "end_turn",
  usage: {
    cost: { amount: 0.004, currency: "USD" },
    incomplete: false,
    inputTokens: 12,
    outputTokens: 7,
  },
});

const target = {
  environment: "production" as const,
  registeredCodebaseId: "voice-agent",
};

test("Grok pause reasons map onto the closed Administrative pause enum", () => {
  const mapping = {
    "provider-authentication": "provider-paused",
    "provider-contract-drift": "provider-paused",
    "provider-entitlement": "provider-paused",
    "provider-quota": "quota-blocked",
    "runner-identity-crossing": "provider-paused",
    "runner-pin-drift": "provider-paused",
  } as const satisfies Record<GrokPauseReason, string>;

  expect(
    Object.fromEntries(
      (Object.keys(mapping) as GrokPauseReason[]).map((reason) => [
        reason,
        administrativePauseReasonFromGrok(reason),
      ]),
    ),
  ).toEqual(mapping);
});

test("a Grok quota refusal pauses as quota-blocked rather than inventing a provider reason", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: {
      async runOperation() {
        return { reason: "provider-quota", state: "paused" };
      },
      async runPlan() {
        return {
          plan: [{ kind: "delegated-worktree.change" }],
          providerRun: grokEvidence,
          state: "completed",
        };
      },
    },
  });

  const admission = await confirmGrokTask(runtime, taskId);
  const record = await runtime.getTask(taskId);

  expect({
    admission,
    pause: record?.task.executionPause,
    pausedEvent: record?.evidence.find(
      (event) => event.kind === "administrative.task.paused",
    ),
  }).toMatchObject({
    admission: { decision: "admitted" },
    pause: { reason: "quota-blocked" },
    pausedEvent: { details: { reason: "quota-blocked" } },
  });

  await runtime.close();
});

test("an unaccepted enrollment pauses work as provider-paused instead of minting a plan", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    enrollmentActivated: false,
    runner: {
      async runOperation() {
        throw new Error("Grok must not run before enrollment is accepted");
      },
      async runPlan() {
        throw new Error("Grok must not run before enrollment is accepted");
      },
    },
  });

  const admission = await confirmGrokTask(runtime, taskId);
  const record = await runtime.getTask(taskId);

  expect({
    admission,
    pause: record?.task.executionPause,
    status: (await runtime.getStatus()).taskExecution.status,
    task: record?.task.status,
  }).toMatchObject({
    admission: { decision: "admitted" },
    pause: { reason: "provider-paused" },
    status: "execution-manifest-present",
    task: "planning",
  });

  await runtime.close();
});

test("Grok planning usage is recorded on the plan Evidence Event", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: completingGrokRunner(),
  });

  await confirmGrokTask(runtime, taskId);
  const record = await runtime.getTask(taskId);
  const plan = record?.evidence.find(
    (event) => event.kind === "administrative.plan.accepted",
  );

  expect(plan).toMatchObject({
    details: {
      operations: ["delegated-worktree.change"],
      providerRun: {
        apiKeyAuthDisabled: true,
        authenticationRoute: "subscription-oauth",
        credentialAuthMode: "external",
        model: { providerReported: "grok-4.6-build", selector: "grok-4.6" },
        requestId: "req-administrative-1",
        runner: { version: "1.0.13" },
        sessionId: "ses-administrative-1",
        stopReason: "end_turn",
        usage: grokEvidence.usage,
      },
      usage: grokEvidence.usage,
    },
    kind: "administrative.plan.accepted",
  });

  await runtime.close();
});

test("Grok operation usage is recorded on the completed Operation Evidence Event", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: completingGrokRunner(),
  });

  await confirmGrokTask(runtime, taskId);
  const record = await runtime.getTask(taskId);
  const completed = record?.evidence.find(
    (event) => event.kind === "administrative.operation.completed",
  );

  expect(completed).toMatchObject({
    details: {
      kind: "delegated-worktree.change",
      result: {
        providerRun: {
          apiKeyAuthDisabled: true,
          authenticationRoute: "subscription-oauth",
          credentialAuthMode: "external",
          model: { providerReported: "grok-4.6-build" },
          requestId: "req-administrative-1",
          sessionId: "ses-administrative-1",
          stopReason: "end_turn",
          usage: grokEvidence.usage,
        },
        usage: grokEvidence.usage,
      },
    },
    kind: "administrative.operation.completed",
  });

  await runtime.close();
});

test("a pinned Grok Administrative Execution Manifest lets a confirmed Durable Task exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-grok-compose-"));
  temporaryDirectories.push(directory);
  const pinPath = join(directory, "runner-pin.json");
  await writeFile(pinPath, JSON.stringify(grokPin));

  const composed = await composeDeployedAdministrativeGrokExecution({
    pinPath,
    runner: completingGrokRunner(),
  });

  expect(composed).toMatchObject({
    executionManifest: {
      provider: {
        kind: "grok-build",
        runnerPin: grokPin,
      },
    },
    kind: "grok-build",
  });
  if (composed.kind !== "grok-build") {
    throw new Error("Grok composition did not bind the reviewed pin");
  }

  const { runtime, taskId } = await createGrokAdministrativeWorld({
    adapter: composed.adapter,
  });
  const prepared = await runtime.prepareTaskConfirmation({
    intendedState: "The isolated branch contains the requested change.",
    outcome: "propose",
    ownerId: "owner",
    requestId: "grok-composed-task",
    target,
  });

  expect({
    prepared: prepared.decision,
    status: (await runtime.getStatus()).taskExecution.status,
    taskId: prepared.decision === "prepared" ? prepared.taskId : undefined,
  }).toMatchObject({
    prepared: "prepared",
    status: "execution-manifest-present",
    taskId,
  });

  await runtime.close();
});

test("an absent Runner Pin keeps the deployed execution manifest unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-grok-missing-pin-"));
  temporaryDirectories.push(directory);

  const composed = await composeDeployedAdministrativeGrokExecution({
    pinPath: join(directory, "missing-runner-pin.json"),
  });

  expect(composed).toMatchObject({
    executionManifest: { provider: { kind: "unavailable" } },
    kind: "unavailable",
  });
});

test("Grok planning output that is not a typed plan fails rather than widening kinds", () => {
  expect(
    grokPlanRunFromOutcome(
      {
        evidence: grokEvidence,
        report: {
          risks: [],
          status: "completed",
          summary: "Chose an Operation plan.",
        },
        state: "completed",
      },
      { status: "completed", summary: "shell.root" },
    ),
  ).toMatchObject({
    reason: "malformed-output",
    state: "failed",
  });
});

test("a named Grok planning failure fails the Durable Task instead of retrying", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: {
      async runOperation() {
        throw new Error("Grok must not execute after a named planning failure");
      },
      async runPlan() {
        return {
          detail:
            "The provider returned a final result that does not match the reviewed structured schema.",
          reason: "malformed-output",
          state: "failed",
        };
      },
    },
  });

  const admission = await confirmGrokTask(runtime, taskId);
  await runtime.reconcileOperations();
  const record = await runtime.getTask(taskId);

  expect({
    admission,
    denied: record?.evidence.find(
      (event) => event.kind === "administrative.task.denied",
    ),
    status: record?.task.status,
  }).toMatchObject({
    admission: { decision: "denied", reason: "malformed-output" },
    denied: { details: { reason: "malformed-output" } },
    status: "denied",
  });

  await runtime.close();
});

test("a named Grok planning stop Stops the Durable Task instead of retrying", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: {
      async runOperation() {
        throw new Error("Grok must not execute after a named planning stop");
      },
      async runPlan() {
        return {
          detail:
            "Execution stopped at the owner's request; completed commits and unfinished work were left in place.",
          state: "stopped",
        };
      },
    },
  });

  const admission = await confirmGrokTask(runtime, taskId);
  await runtime.reconcileOperations();
  const record = await runtime.getTask(taskId);

  expect({
    admission: admission.decision,
    status: record?.task.status,
    stopped: record?.evidence.find(
      (event) => event.kind === "administrative.task.stopped",
    ),
  }).toMatchObject({
    admission: "admitted",
    status: "stopped",
    stopped: {
      kind: "administrative.task.stopped",
      summary:
        "Execution stopped at the owner's request; completed commits and unfinished work were left in place.",
    },
  });

  await runtime.close();
});

test("a named Grok operation failure fails the Durable Task instead of retrying", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: {
      async runOperation() {
        return {
          detail: "The run passed its time bound and its process group was stopped.",
          reason: "timeout",
          state: "failed",
        };
      },
      async runPlan() {
        return {
          plan: [{ kind: "delegated-worktree.change" }],
          providerRun: grokEvidence,
          state: "completed",
        };
      },
    },
  });

  const admission = await confirmGrokTask(runtime, taskId);
  await runtime.reconcileOperations();
  const record = await runtime.getTask(taskId);

  expect({
    admission,
    denied: record?.evidence.find(
      (event) => event.kind === "administrative.task.denied",
    ),
    failedOperation: record?.evidence.find(
      (event) => event.kind === "administrative.operation.failed",
    ),
    status: record?.task.status,
  }).toMatchObject({
    admission: { decision: "denied", reason: "timeout" },
    denied: { details: { reason: "timeout" } },
    failedOperation: { details: { reason: "timeout" } },
    status: "denied",
  });

  await runtime.close();
});

test("a named Grok operation stop Stops the Durable Task instead of retrying", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: {
      async runOperation() {
        return {
          detail:
            "Execution stopped at the owner's request; completed commits and unfinished work were left in place.",
          state: "stopped",
        };
      },
      async runPlan() {
        return {
          plan: [{ kind: "delegated-worktree.change" }],
          providerRun: grokEvidence,
          state: "completed",
        };
      },
    },
  });

  const admission = await confirmGrokTask(runtime, taskId);
  await runtime.reconcileOperations();
  const record = await runtime.getTask(taskId);

  expect({
    admission: admission.decision,
    status: record?.task.status,
    stopped: record?.evidence.find(
      (event) => event.kind === "administrative.task.stopped",
    ),
    stoppedOperation: record?.evidence.find(
      (event) => event.kind === "administrative.operation.failed",
    ),
  }).toMatchObject({
    admission: "admitted",
    status: "stopped",
    stopped: {
      kind: "administrative.task.stopped",
      summary:
        "Execution stopped at the owner's request; completed commits and unfinished work were left in place.",
    },
    stoppedOperation: {
      summary:
        "The outstanding delegated-worktree.change Operation stopped with its Task.",
    },
  });

  await runtime.close();
});

test("the host runner pauses a missing voice-grok identity rather than as contract-drift", async () => {
  const runner = createHostGrokAdministrativeRunner({
    executorIdentity: "voice-agent",
  });
  const plan = await runner.runPlan(unusedGrokPlanInput());
  const operation = await runner.runOperation(unusedGrokOperationInput());

  expect({ operation, plan }).toEqual({
    operation: { reason: "runner-identity-crossing", state: "paused" },
    plan: { reason: "runner-identity-crossing", state: "paused" },
  });
});

test("the host runner invokes the reviewed Grok contract path as voice-grok", async () => {
  const runner = createHostGrokAdministrativeRunner({
    executorIdentity: grokExecutorIdentity,
    runContract: completingGrokRunner(),
  });
  const plan = await runner.runPlan(unusedGrokPlanInput());

  expect(plan).toMatchObject({
    plan: [{ kind: "delegated-worktree.change" }],
    state: "completed",
  });
});

test("an accepted enrollment with the API identity still pauses as provider-paused", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: createHostGrokAdministrativeRunner({
      executorIdentity: "voice-agent",
    }),
  });

  const admission = await confirmGrokTask(runtime, taskId);
  const record = await runtime.getTask(taskId);

  expect({
    admission,
    pause: record?.task.executionPause,
    task: record?.task.status,
  }).toMatchObject({
    admission: { decision: "admitted" },
    pause: { reason: "provider-paused" },
    task: "planning",
  });

  await runtime.close();
});

test("Grok enrollment binds delegated-worktree.change and not production.observe", async () => {
  const adapter = createGrokAdministrativeAdapter({
    enrollmentCampaignId: "grok-enrollment",
    implementationDigest: "1".repeat(64),
    runner: completingGrokRunner(),
    runnerPin: grokPin,
  });

  expect(adapter.executionManifest.operationAdapters).toEqual([
    {
      implementationDigest: "1".repeat(64),
      kind: "delegated-worktree.change",
    },
  ]);
});

test("a Grok plan that names production.observe is refused rather than observed", async () => {
  const { runtime, taskId } = await createGrokAdministrativeWorld({
    runner: {
      async runOperation() {
        throw new Error("Grok must not observe production");
      },
      async runPlan() {
        return {
          plan: [{ kind: "production.observe" }],
          providerRun: grokEvidence,
          state: "completed",
        };
      },
    },
  });

  const admission = await confirmGrokTask(runtime, taskId);
  const record = await runtime.getTask(taskId);

  expect({
    admission,
    denied: record?.evidence.find(
      (event) => event.kind === "administrative.task.denied",
    ),
    status: record?.task.status,
  }).toMatchObject({
    admission: {
      decision: "denied",
      reason:
        "production.observe is not present in the activated execution manifest",
    },
    denied: {
      details: {
        reason:
          "production.observe is not present in the activated execution manifest",
      },
    },
    status: "denied",
  });

  await runtime.close();
});

function completingGrokRunner(): GrokAdministrativeRunner {
  return {
    async runOperation(execution) {
      if (execution.request.kind !== "delegated-worktree.change") {
        throw new Error(
          `Grok enrollment does not bind ${execution.request.kind}`,
        );
      }
      const request = execution.request;
      const completedAt = execution.fence.attemptStartedAt;
      const headCommit = "a".repeat(40);
      const worktree = {
        ...request.delegation.worktree,
        dirty: false,
        state: "completed" as const,
      };
      return {
        providerRun: grokEvidence,
        result: {
          completedAt,
          delegation: {
            branch: worktree.branch,
            changedFiles: ["src/administrative-change.ts"],
            commits: [headCommit],
            completedAt,
            delegationId: delegationIdSchema.parse(
              request.delegation.brief.delegationId,
            ),
            failure: null,
            risks: [],
            status: "completed",
            termination: null,
            verification: {
              automated:
                request.delegation.brief.acceptanceCriteria.automaticVerification.commands.map(
                  (command) => ({
                    command,
                    outcome: "passed" as const,
                    summary: `${command} completed in the restricted Delegated Worktree.`,
                  }),
                ),
              candidate: {
                branch: worktree.branch,
                commit: headCommit,
                worktreeId: worktree.id,
              },
            },
            worktree,
          },
          effect: {
            kind: "effect-performed",
            startedAt: completedAt,
          },
          kind: "delegated-worktree.change",
          operationId: request.operationId,
          providerRun: grokEvidence,
          publication: {
            branch: worktree.branch,
            headCommit,
            kind: "isolated-branch-prepared",
            productionMutation: false,
          },
          summary:
            "The delegated-worktree.change Operation completed through Grok.",
          usage: grokEvidence.usage,
        },
        state: "completed",
      };
    },
    async runPlan() {
      return {
        plan: [{ kind: "delegated-worktree.change" }],
        providerRun: grokEvidence,
        state: "completed",
      };
    },
  };
}

function unusedGrokPlanInput(): Parameters<GrokAdministrativeRunner["runPlan"]>[0] {
  return {
    activeExecutionDeadline: "2026-10-02T16:00:00.000Z",
    intendedState: "The isolated branch contains the requested change.",
    outcome: "proposal",
    signal: new AbortController().signal,
    target: {
      environment: "production",
      registeredCodebaseId: "voice-agent",
    },
    taskId: administrativeTaskIdSchema.parse("grok-administrative-task-1"),
  } as Parameters<GrokAdministrativeRunner["runPlan"]>[0];
}

function unusedGrokOperationInput(): Parameters<
  GrokAdministrativeRunner["runOperation"]
>[0] {
  return {} as Parameters<GrokAdministrativeRunner["runOperation"]>[0];
}

async function confirmGrokTask(
  runtime: ReturnType<typeof createAdministrativeAutonomyRuntime>,
  taskId: ReturnType<typeof administrativeTaskIdSchema.parse>,
) {
  const prepared = await runtime.prepareTaskConfirmation({
    intendedState: "The isolated branch contains the requested change.",
    outcome: "propose",
    ownerId: "owner",
    requestId: `grok-${taskId}`,
    target,
  });
  if (prepared.decision !== "prepared") {
    throw new Error(`Grok Task Confirmation was not prepared: ${prepared.reason}`);
  }
  return runtime.answerTaskConfirmation({
    confirmation: "confirmed",
    confirmationCapability: prepared.confirmationCapability,
    ownerId: "owner",
    taskId: prepared.taskId,
  });
}

async function createGrokAdministrativeWorld(options: {
  readonly adapter?: ReturnType<typeof createGrokAdministrativeAdapter>;
  readonly enrollmentActivated?: boolean;
  readonly runner?: GrokAdministrativeRunner;
}) {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-grok-admin-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "db"), { recursive: true });
  const adapter =
    options.adapter ??
    createGrokAdministrativeAdapter({
      enrollmentCampaignId: "grok-enrollment",
      evaluateEnrollment: async () => ({
        activated: options.enrollmentActivated ?? true,
      }),
      implementationDigest: "1".repeat(64),
      runner: options.runner ?? completingGrokRunner(),
      runnerPin: grokPin,
    });
  const store = createSqliteAdministrativeAutonomyStore(
    join(directory, "db", "voice-agent.sqlite"),
  );
  let capabilitySequence = 0;
  let claimSequence = 0;
  let eventSequence = 0;
  let operationSequence = 0;
  let taskSequence = 0;
  const runtime = createAdministrativeAutonomyRuntime({
    executionManifest: adapter.executionManifest,
    executor: adapter.executor,
    identifiers: {
      nextCapability: () =>
        `grok-administrative-confirmation-capability-${(capabilitySequence += 1)}`,
      nextClaimId: () =>
        administrativeOperationClaimIdSchema.parse(
          `grok-administrative-claim-${(claimSequence += 1)}`,
        ),
      nextEventId: () =>
        `grok-administrative-event-${(eventSequence += 1)}`,
      nextOperationId: () =>
        administrativeOperationIdSchema.parse(
          `grok-administrative-operation-${(operationSequence += 1)}`,
        ),
      nextTaskId: () =>
        administrativeTaskIdSchema.parse(
          `grok-administrative-task-${(taskSequence += 1)}`,
        ),
    },
    implementationCatalog: adapter.catalog,
    now: () => "2026-10-02T10:00:00.000Z",
    provider: adapter.provider,
    registeredCodebasePathAuthority: {
      allowedRoots: {
        liveCheckoutPath: ["/srv"],
        sourceCheckoutRoot: ["/srv/source"],
        worktreeRoot: ["/var/lib/voice-agent-worktrees"],
      },
      credentialCustodyBoundaryPaths,
      async resolvePath(path) {
        return path;
      },
    },
    registeredCodebases: {
      async findRegisteredCodebase(registeredCodebaseId) {
        if (registeredCodebaseId !== "voice-agent") return undefined;
        return administrativeRegisteredCodebaseSchema.parse({
          expiresAt: "2100-01-01T00:00:00.000Z",
          initialProductionCommit: "1".repeat(40),
          liveCheckoutPath: "/srv/voice-agent",
          productionBranch: "main",
          registeredAt: "1990-01-01T00:00:00.000Z",
          registeredCodebaseId: "voice-agent",
          repository: "JacobStephens2/voice-agent",
          revision: 1,
          sourceCheckoutRoot: "/srv/source/voice-agent",
          verificationCommands: ["pnpm typecheck", "pnpm test"],
          worktreeRoot: "/var/lib/voice-agent-worktrees/voice-agent",
        });
      },
    },
    store,
  });
  const activated = await runtime.activatePolicy({
    expectation: {
      expectedActiveRevision: null,
      expectedExecutionManifestFingerprint:
        administrativeExecutionManifestFingerprint(adapter.executionManifest),
      expectedStateVersion: 0,
    },
    source: "fresh-passkey-action",
  });
  if (activated.decision !== "activated") {
    throw new Error(`Grok policy did not activate: ${activated.reason}`);
  }
  return {
    runtime,
    taskId: administrativeTaskIdSchema.parse("grok-administrative-task-1"),
  };
}
