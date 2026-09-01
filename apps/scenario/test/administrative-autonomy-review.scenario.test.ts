import { rm } from "node:fs/promises";

import { afterEach, expect, test } from "vitest";

import {
  administrativeExecutionManifestSchema,
  administrativePlanProviderIdentitySchema,
  administrativePolicyEvidencePageSchema,
  administrativeTimestampSchema,
  type AdministrativeTimestamp,
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

test.each([
  ["provider", { provider: 2 }, { provider: 1 }],
  ["Operation executor", { executor: 2 }, { executor: 1 }],
  [
    "Live Patch rollback activator",
    { rollbackActivator: 2 },
    { rollbackActivator: 1 },
  ],
] as const)(
  "a replacement %s cannot inherit an activated manifest by claiming its old identity",
  async (_implementation, executionImplementationVersions, selfReportedVersions) => {
    const { databasePath, scenario } = await createActivatedScenario(
      {
        now: "2026-10-02T10:13:00.000Z",
        providerPlan: [{ kind: "production.observe" }],
      },
      temporaryDirectories,
    );
    await scenario.close();

    await expect(
      createAdministrativeAutonomyScenario({
        databasePath,
        executionImplementationVersions,
        identifierNamespace: "lying-implementation-",
        now: "2026-10-02T10:14:00.000Z",
        providerPlan: [{ kind: "production.observe" }],
        selfReportedExecutionImplementationVersions: selfReportedVersions,
      }),
    ).rejects.toThrow(/implementation identity does not match/u);
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

test("a verified Delegation Result completes delegated work through the public task seam", async () => {
  const { scenario } = await createActivatedScenario(
    {
      now: "2026-10-02T11:35:00.000Z",
      providerPlan: [{ kind: "delegated-worktree.change" }],
    },
    temporaryDirectories,
  );
  const admission = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The proposed change is verified in its isolated worktree.",
    outcome: "propose",
    ownerId: "owner",
    requestId: "verified-delegation-result",
    target,
  });
  const record = await scenario.readTask("administrative-task-1");
  const completion = record?.evidence.find(
    (event) => event.kind === "administrative.operation.completed",
  );

  expect({
    admission,
    completion,
    operation: scenario.executedOperations[0],
    task: record?.task,
  }).toMatchObject({
    admission: { decision: "admitted" },
    completion: {
      details: {
        result: {
          delegation: {
            branch: "administrative/administrative-operation-1",
            changedFiles: ["src/administrative-change.ts"],
            commits: ["a".repeat(40)],
            failure: null,
            risks: [],
            status: "completed",
            verification: {
              automated: [
                { command: "pnpm typecheck", outcome: "passed" },
                { command: "pnpm test", outcome: "passed" },
              ],
              candidate: {
                branch: "administrative/administrative-operation-1",
                commit: "a".repeat(40),
                worktreeId: "administrative-operation-1",
              },
            },
            worktree: {
              id: "administrative-operation-1",
              state: "completed",
            },
          },
        },
      },
      kind: "administrative.operation.completed",
    },
    operation: {
      delegation: {
        brief: {
          acceptanceCriteria: {
            automaticVerification: {
              commands: ["pnpm typecheck", "pnpm test"],
              kind: "registered-codebase-verification",
            },
            intendedState: {
              intendedState:
                "The proposed change is verified in its isolated worktree.",
              kind: "confirmed-intended-state",
            },
          },
          authorizedCapabilities: [
            "registered-source.read",
            "delegated-worktree.write",
            "verification.run",
            "verified-candidate.prepare",
          ],
          boundedContext: {
            editableScope: "registered-codebase",
            rawVoiceTranscriptIncluded: false,
            repositoryContentTrust: "untrusted-data-only",
          },
          constraints: [
            "delegated-worktree-only",
            "production-mutation-forbidden",
            "production-ref-mutation-forbidden",
            "human-merge-required",
          ],
          delegationId: "administrative-operation-1",
          registeredCodebase: { applicationId: "voice-agent", revision: 1 },
        },
      },
    },
    task: { status: "completed" },
  });

  await scenario.close();
});

test.each([
  "missing",
  "mismatched",
  "mismatched-candidate",
  "mismatched-publication",
  "failed-verification",
] as const)(
  "a %s Delegation Result cannot complete its Operation or Task",
  async (delegatedWorktreeProof) => {
    const { scenario } = await createActivatedScenario(
      {
        delegatedWorktreeProof,
        now: "2026-10-02T11:36:00.000Z",
        providerPlan: [{ kind: "delegated-worktree.change" }],
      },
      temporaryDirectories,
    );
    const admission = await scenario.confirmAndRunTask({
      confirmation: "confirmed",
      intendedState: "The proposed change is verified in its isolated worktree.",
      outcome: "propose",
      ownerId: "owner",
      requestId: `invalid-delegation-result-${delegatedWorktreeProof}`,
      target,
    });
    const record = await scenario.readTask("administrative-task-1");

    expect({
      admission,
      completedOperationEvents: record?.evidence.filter(
        (event) => event.kind === "administrative.operation.completed",
      ),
      failedOperationEvents: record?.evidence.filter(
        (event) => event.kind === "administrative.operation.failed",
      ),
      task: record?.task,
    }).toMatchObject({
      admission: {
        decision: "denied",
        reason:
          "Administrative executor returned incomplete or mismatched bounded proof",
      },
      completedOperationEvents: [],
      failedOperationEvents: [
        {
          details: {
            kind: "delegated-worktree.change",
            operationId: "administrative-operation-1",
            reason:
              "Administrative executor returned incomplete or mismatched bounded proof",
          },
        },
      ],
      task: {
        conclusion:
          "Administrative executor returned incomplete or mismatched bounded proof",
        status: "denied",
      },
    });

    await scenario.close();
  },
);

test.each([
  ["terminated", "stopped", "delegation-stopped"],
  ["failed", "failed", "delegation-failed"],
] as const)(
  "a %s Delegation persists its canonical terminal result without completing the Task",
  async (delegatedWorktreeProof, terminalStatus, publicationReason) => {
    const { databasePath, scenario } = await createActivatedScenario(
      {
        delegatedWorktreeProof,
        now: "2026-10-02T11:36:00.000Z",
        providerPlan: [{ kind: "delegated-worktree.change" }],
      },
      temporaryDirectories,
    );
    const admission = await scenario.confirmAndRunTask({
      confirmation: "confirmed",
      intendedState: "The proposed change is verified in its isolated worktree.",
      outcome: "propose",
      ownerId: "owner",
      requestId: `terminal-delegation-result-${terminalStatus}`,
      target,
    });
    await scenario.close();

    const restarted = await createAdministrativeAutonomyScenario({
      databasePath,
      identifierNamespace: `${terminalStatus}-restart-`,
      now: "2026-10-02T11:37:00.000Z",
      providerPlan: [{ kind: "delegated-worktree.change" }],
    });
    const record = await restarted.readTask("administrative-task-1");
    const terminalEvidence = record?.evidence.filter(
      (event) => event.kind === "administrative.operation.terminated",
    );

    expect({ admission, record, terminalEvidence }).toMatchObject({
      admission: {
        decision: "denied",
        reason: `Administrative Delegation ${terminalStatus}.`,
      },
      record: { task: { status: "denied" } },
      terminalEvidence: [
        {
          details: {
            result: {
              delegation: {
                changedFiles: ["src/preserved-administrative-work.ts"],
                failure:
                  terminalStatus === "failed"
                    ? { kind: "restricted-runner" }
                    : null,
                risks: ["The preserved partial work requires human review."],
                status: terminalStatus,
                termination:
                  terminalStatus === "stopped"
                    ? { kind: "owner-requested" }
                    : null,
                worktree: { dirty: true, state: terminalStatus },
              },
              publication: {
                kind: "not-published",
                productionMutation: false,
                reason: publicationReason,
              },
            },
            terminalStatus,
          },
          kind: "administrative.operation.terminated",
        },
      ],
    });
    expect(
      record?.evidence.filter(
        (event) => event.kind === "administrative.operation.completed",
      ),
    ).toEqual([]);

    await restarted.reconcileOperations();
    expect(
      (await restarted.readTask("administrative-task-1"))?.evidence.filter(
        (event) => event.kind === "administrative.operation.terminated",
      ),
    ).toHaveLength(1);
    await restarted.close();
  },
);

test("terminal Delegation settlement survives commit-response loss without duplicate evidence", async () => {
  const { databasePath, scenario } = await createActivatedScenario(
    {
      delegatedWorktreeProof: "terminated",
      loseFirstOperationSettlementResponse: true,
      now: "2026-10-02T11:36:15.000Z",
      providerPlan: [{ kind: "delegated-worktree.change" }],
    },
    temporaryDirectories,
  );
  await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The preserved partial work is available for human review.",
    outcome: "propose",
    ownerId: "owner",
    requestId: "terminal-settlement-response-loss",
    target,
  });
  await scenario.close();

  const restarted = await createAdministrativeAutonomyScenario({
    databasePath,
    identifierNamespace: "terminal-response-loss-restart-",
    now: "2026-10-02T11:37:15.000Z",
    providerPlan: [{ kind: "delegated-worktree.change" }],
  });
  await restarted.reconcileOperations();
  const record = await restarted.readTask("administrative-task-1");

  expect({
    denied: record?.evidence.filter(
      (event) => event.kind === "administrative.task.denied",
    ),
    task: record?.task,
    terminal: record?.evidence.filter(
      (event) => event.kind === "administrative.operation.terminated",
    ),
  }).toMatchObject({
    denied: [{ details: { reason: "Administrative Delegation stopped." } }],
    task: { status: "denied" },
    terminal: [
      {
        details: {
          result: {
            delegation: {
              failure: null,
              termination: { kind: "owner-requested" },
              worktree: { dirty: true, state: "stopped" },
            },
          },
          terminalStatus: "stopped",
        },
      },
    ],
  });
  await restarted.close();
});

test("a verified Delegation completion remains valid when trusted receipt time advances", async () => {
  const clock = { current: "2026-10-02T11:36:30.000Z" };
  const { scenario } = await createActivatedScenario(
    {
      beforeExecutorResultReturn() {
        clock.current = "2026-10-02T11:36:30.025Z";
      },
      clock,
      now: clock.current,
      providerPlan: [{ kind: "delegated-worktree.change" }],
    },
    temporaryDirectories,
  );
  const admission = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The verified candidate is ready on its isolated branch.",
    outcome: "propose",
    ownerId: "owner",
    requestId: "advancing-clock-delegation",
    target,
  });
  const completion = (await scenario.readTask("administrative-task-1"))?.evidence.find(
    (event) => event.kind === "administrative.operation.completed",
  );

  expect({ admission, completion }).toMatchObject({
    admission: { decision: "admitted" },
    completion: {
      details: {
        result: {
          completedAt: "2026-10-02T11:36:30.025Z",
          delegation: { completedAt: "2026-10-02T11:36:30.000Z" },
        },
      },
    },
  });
  await scenario.close();
});

test("Administrative Tasks fail closed for unavailable, absent, expired, or drifted Registered Codebases", async () => {
  const unavailable = await createActivatedScenario(
    {
      now: "2026-10-02T11:37:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
      registeredCodebaseAvailability: "unavailable",
    },
    temporaryDirectories,
  );
  const unavailableResult = await unavailable.scenario.prepareTask({
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "registry-unavailable",
    target,
  });

  const absent = await createActivatedScenario(
    {
      now: "2026-10-02T11:37:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
    },
    temporaryDirectories,
  );
  const absentResult = await absent.scenario.prepareTask({
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "registry-absent",
    target: {
      environment: "production",
      registeredCodebaseId: "unregistered-application",
    },
  });

  const expired = await createActivatedScenario(
    {
      now: "2026-10-02T11:37:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
      registeredCodebaseExpiresAt: "2026-10-02T11:36:59.000Z",
    },
    temporaryDirectories,
  );
  const expiredResult = await expired.scenario.prepareTask({
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "registry-expired",
    target,
  });

  const drifted = await createActivatedScenario(
    {
      now: "2026-10-02T11:37:00.000Z",
      providerPlan: [{ kind: "production.observe" }],
      registeredCodebaseRevisionByLookup: [1, 2],
    },
    temporaryDirectories,
  );
  const driftedResult = await drifted.scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "Production health is understood.",
    outcome: "investigate",
    ownerId: "owner",
    requestId: "registry-drifted",
    target,
  });
  const effectClock = { current: "2026-10-02T11:37:00.000Z" };
  const expiredDuringEffect = await createActivatedScenario(
    {
      async beforeOperationEffect() {
        effectClock.current = "2026-10-02T11:39:00.000Z";
      },
      clock: effectClock,
      now: effectClock.current,
      providerPlan: [{ kind: "production.observe" }],
      registeredCodebaseExpiresAt: "2026-10-02T11:38:00.000Z",
    },
    temporaryDirectories,
  );
  const expiredDuringEffectResult =
    await expiredDuringEffect.scenario.confirmAndRunTask({
      confirmation: "confirmed",
      intendedState: "Production health is understood.",
      outcome: "investigate",
      ownerId: "owner",
      requestId: "registry-expired-during-effect",
      target,
    });

  expect({
    absent: absentResult,
    drifted: driftedResult,
    driftedEffects: drifted.scenario.executedOperations,
    expired: expiredResult,
    expiredDuringEffect: expiredDuringEffectResult,
    expiredDuringEffectEffects:
      expiredDuringEffect.scenario.executedOperations,
    unavailable: unavailableResult,
  }).toEqual({
    absent: {
      decision: "denied",
      reason: "The Registered Codebase is unavailable or not current",
    },
    drifted: {
      decision: "denied",
      reason: "The Registered Codebase registration is unavailable or stale",
    },
    driftedEffects: [],
    expired: {
      decision: "denied",
      reason: "The Registered Codebase is unavailable or not current",
    },
    expiredDuringEffect: {
      decision: "denied",
      reason: "The Registered Codebase registration is unavailable or stale",
    },
    expiredDuringEffectEffects: [],
    unavailable: {
      decision: "denied",
      reason: "The Registered Codebase is unavailable or not current",
    },
  });

  await Promise.all([
    unavailable.scenario.close(),
    absent.scenario.close(),
    expired.scenario.close(),
    drifted.scenario.close(),
    expiredDuringEffect.scenario.close(),
  ]);
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

test("the suspension reconciliation controller retries durable rollback failures and implementation mismatch across restart", async () => {
  const clock = { current: "2026-10-02T15:00:00.000Z" };
  const callbacks: Array<() => Promise<void>> = [];
  const schedule: string[] = [];
  const rollbackActivationAttempts: LivePatchRollbackActivationRequest[] = [];
  const rollbackActivationLedger = new Set<string>();
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      clock,
      now: clock.current,
      providerPlan: [{ kind: "live-patch.apply" }],
      reconciliationCallbacks: callbacks,
      reconciliationSchedule: schedule,
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
    requestId: "scheduled-rollback-request",
    target,
  });
  await firstProcess.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  expect(schedule).toEqual(["2026-10-02T15:00:01.000Z"]);
  clock.current = schedule[0] ?? clock.current;
  await callbacks[0]?.();
  expect(schedule).toEqual([
    "2026-10-02T15:00:01.000Z",
    "2026-10-02T15:00:03.000Z",
  ]);
  await firstProcess.close();

  clock.current = "2026-10-02T15:01:00.000Z";
  const mismatchCallbacks: Array<() => Promise<void>> = [];
  const mismatchSchedule: string[] = [];
  const mismatchProcess = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    executionImplementationVersions: {
      executor: 2,
      provider: 2,
      rollbackActivator: 2,
    },
    executionManifestVersion: 2,
    identifierNamespace: "scheduled-mismatch-",
    now: clock.current,
    providerPlan: [{ kind: "live-patch.apply" }],
    reconciliationCallbacks: mismatchCallbacks,
    reconciliationSchedule: mismatchSchedule,
    rollbackActivationAttempts,
    rollbackActivationLedger,
  });
  const mismatched = await mismatchProcess.readPolicyStatus();
  expect(mismatched).toMatchObject({
    rollbackActivations: {
      pendingActivations: [
        {
          attemptCount: 3,
          lastFailureReason: "implementation-mismatch",
          operationId: "administrative-operation-1",
        },
      ],
      pendingOperationIds: ["administrative-operation-1"],
    },
    status: "suspended",
  });
  clock.current = mismatchSchedule[0] ?? clock.current;
  await mismatchCallbacks[0]?.();
  const repeatedlyMismatched = await mismatchProcess.readPolicyStatus();
  expect(repeatedlyMismatched).toMatchObject({
    rollbackActivations: {
      pendingActivations: [
        {
          attemptCount: 4,
          lastFailureReason: "implementation-mismatch",
        },
      ],
    },
  });
  await mismatchProcess.close();

  clock.current = "2026-10-02T15:02:00.000Z";
  const recoveryProcess = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    identifierNamespace: "scheduled-recovery-",
    now: clock.current,
    providerPlan: [{ kind: "live-patch.apply" }],
    rollbackActivationAttempts,
    rollbackActivationLedger,
  });
  const recovered = await recoveryProcess.readPolicyStatus();
  const evidence = await recoveryProcess.readTask("administrative-task-1");

  expect({
    activatedEvidence: evidence?.evidence.filter(
      (event) => event.kind === "administrative.live-patch.rollback-activated",
    ),
    failureReasons: evidence?.evidence
      .filter(
        (event) =>
          event.kind ===
          "administrative.live-patch.rollback-activation-failed",
      )
      .map((event) => event.details.reason),
    recovered,
    rollbackActivationAttempts,
    rollbackActivationLedger: [...rollbackActivationLedger],
  }).toMatchObject({
    activatedEvidence: [{ details: { operationId: "administrative-operation-1" } }],
    failureReasons: [
      "transient-failure",
      "transient-failure",
      "implementation-mismatch",
      "implementation-mismatch",
    ],
    recovered: {
      rollbackActivations: {
        activatedOperationIds: ["administrative-operation-1"],
        pendingActivations: [],
        pendingOperationIds: [],
      },
      status: "suspended",
    },
    rollbackActivationLedger: ["administrative-operation-1"],
  });

  await recoveryProcess.reconcileOperations();
  const replayEvidence = await recoveryProcess.readTask("administrative-task-1");
  expect(
    replayEvidence?.evidence.filter(
      (event) => event.kind === "administrative.live-patch.rollback-activated",
    ),
  ).toHaveLength(1);
  await recoveryProcess.close();
});

test("a hanging rollback activator is aborted, evidenced, scheduled, and retried", async () => {
  const clock = { current: "2026-10-02T15:15:00.000Z" };
  const deadlineCallbacks: Array<() => void> = [];
  const attemptDeadlines: AdministrativeTimestamp[] = [];
  const reconciliationCallbacks: Array<() => Promise<void>> = [];
  const reconciliationSchedule: string[] = [];
  const signals: AbortSignal[] = [];
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { scenario } = await createActivatedScenario(
    {
      clock,
      now: clock.current,
      onRollbackActivationStart: () => markStarted?.(),
      providerPlan: [{ kind: "live-patch.apply" }],
      reconciliationCallbacks,
      reconciliationSchedule,
      rollbackActivationAttemptDeadlines: attemptDeadlines,
      rollbackActivationDeadlineCallbacks: deadlineCallbacks,
      rollbackActivationHangs: 1,
      rollbackActivationSignals: signals,
    },
    temporaryDirectories,
  );
  await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "hanging-rollback-activator",
    target,
  });

  const suspension = scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  await started;
  expect(deadlineCallbacks).toHaveLength(1);
  deadlineCallbacks[0]?.();
  await suspension;
  const pending = await scenario.readPolicyStatus();
  const failedEvidence = (
    await scenario.readTask("administrative-task-1")
  )?.evidence.filter(
    (event) =>
      event.kind === "administrative.live-patch.rollback-activation-failed",
  );

  expect({ attemptDeadlines, failedEvidence, pending, schedule: reconciliationSchedule, signals }).toMatchObject({
    attemptDeadlines: ["2026-10-02T15:15:30.000Z"],
    failedEvidence: [
      { details: { attemptCount: 1, reason: "transient-failure" } },
    ],
    pending: {
      rollbackActivations: {
        pendingActivations: [{ attemptCount: 1 }],
        pendingOperationIds: ["administrative-operation-1"],
      },
      status: "suspended",
    },
    schedule: ["2026-10-02T15:15:01.000Z"],
  });
  expect(signals[0]?.aborted).toBe(true);

  clock.current = reconciliationSchedule[0] ?? clock.current;
  await reconciliationCallbacks[0]?.();
  expect(await scenario.readPolicyStatus()).toMatchObject({
    rollbackActivations: {
      activatedOperationIds: ["administrative-operation-1"],
      pendingOperationIds: [],
    },
    status: "suspended",
  });
  await scenario.close();
});

test("a rollback activation result that arrives after its trusted deadline fails closed and replays", async () => {
  const clock = { current: "2026-10-02T15:20:00.000Z" };
  const deadlineCallbacks: Array<() => void> = [];
  const reconciliationCallbacks: Array<() => Promise<void>> = [];
  const reconciliationSchedule: string[] = [];
  let advanceFirstResult = true;
  const { scenario } = await createActivatedScenario(
    {
      beforeRollbackActivationResultReturn() {
        if (!advanceFirstResult) return;
        advanceFirstResult = false;
        clock.current = "2026-10-02T15:20:31.000Z";
      },
      clock,
      now: clock.current,
      providerPlan: [{ kind: "live-patch.apply" }],
      reconciliationCallbacks,
      reconciliationSchedule,
      rollbackActivationDeadlineCallbacks: deadlineCallbacks,
    },
    temporaryDirectories,
  );
  await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "late-rollback-activation-result",
    target,
  });
  await scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  const pendingRecord = await scenario.readTask("administrative-task-1");

  expect({
    activated: pendingRecord?.evidence.filter(
      (event) => event.kind === "administrative.live-patch.rollback-activated",
    ),
    failed: pendingRecord?.evidence.filter(
      (event) =>
        event.kind === "administrative.live-patch.rollback-activation-failed",
    ),
    schedule: reconciliationSchedule,
  }).toMatchObject({
    activated: [],
    failed: [{ details: { reason: "transient-failure" } }],
    schedule: ["2026-10-02T15:20:32.000Z"],
  });

  clock.current = reconciliationSchedule[0] ?? clock.current;
  await reconciliationCallbacks[0]?.();
  const recoveredRecord = await scenario.readTask("administrative-task-1");
  expect({
    activated: recoveredRecord?.evidence.filter(
      (event) => event.kind === "administrative.live-patch.rollback-activated",
    ),
    status: await scenario.readPolicyStatus(),
  }).toMatchObject({
    activated: [
      { details: { result: { outcome: "already-activated" } } },
    ],
    status: {
      rollbackActivations: { pendingOperationIds: [] },
      status: "suspended",
    },
  });
  await scenario.close();
});

test("repeated rollback attempts remain append-only behind a truthful bounded Evidence Record", async () => {
  const clock = { current: "2026-10-02T15:30:00.000Z" };
  const callbacks: Array<() => Promise<void>> = [];
  const schedule: string[] = [];
  const { scenario } = await createActivatedScenario(
    {
      clock,
      now: clock.current,
      providerPlan: [{ kind: "live-patch.apply" }],
      reconciliationCallbacks: callbacks,
      reconciliationSchedule: schedule,
      rollbackActivationFailures: 105,
    },
    temporaryDirectories,
  );
  await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "bounded-rollback-evidence",
    target,
  });
  await scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  for (let attempt = 0; attempt < 104; attempt += 1) {
    clock.current = schedule[attempt] ?? clock.current;
    await callbacks[attempt]?.();
  }
  const record = await scenario.readTask("administrative-task-1");
  const status = await scenario.readPolicyStatus();

  expect({
    evidenceKinds: record?.evidence.map((event) => event.kind),
    evidenceTotalCount: record?.evidenceTotalCount,
    evidenceTruncated: record?.evidenceTruncated,
    pending: status.status === "suspended"
      ? status.rollbackActivations.pendingActivations
      : [],
  }).toMatchObject({
    evidenceTotalCount: 111,
    evidenceTruncated: true,
    pending: [{ attemptCount: 105, lastFailureReason: "transient-failure" }],
  });
  expect(record?.evidence).toHaveLength(100);
  expect(
    record?.evidence.every(
      (event) =>
        event.kind ===
        "administrative.live-patch.rollback-activation-failed",
    ),
  ).toBe(true);

  await scenario.close();
});

test("a matured Live Patch rollback window is durably disarmed before a racing direct revision", async () => {
  const clock = { current: "2026-10-02T16:00:00.000Z" };
  const { databasePath, scenario: firstProcess } = await createActivatedScenario(
    {
      clock,
      now: clock.current,
      providerPlan: [{ kind: "live-patch.apply" }],
    },
    temporaryDirectories,
  );
  await firstProcess.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "matured-window-request",
    target,
  });
  const beforeDeadline = await firstProcess.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 1,
    freshPasskey: true,
  });
  await firstProcess.close();

  clock.current = "2026-10-02T16:30:00.000Z";
  const restarted = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    identifierNamespace: "matured-window-restart-",
    now: clock.current,
    providerPlan: [{ kind: "live-patch.apply" }],
  });
  const raced = await Promise.all([
    restarted.attemptPolicyActivation({
      expectedActiveRevision: 1,
      expectedStateVersion: 1,
      source: "fresh-passkey-action",
    }),
    restarted.attemptPolicyActivation({
      expectedActiveRevision: 1,
      expectedStateVersion: 1,
      source: "fresh-passkey-action",
    }),
  ]);
  const status = await restarted.readPolicyStatus();
  const expiryEvidence = (
    await restarted.readTask("administrative-task-1")
  )?.evidence.filter(
    (event) =>
      event.kind === "administrative.live-patch.rollback-window-expired",
  );

  expect({ beforeDeadline, expiryEvidence, raced, status }).toMatchObject({
    beforeDeadline: {
      body: {
        error:
          "Administrative Autonomy has unresolved Live Patch rollback windows",
      },
      statusCode: 409,
    },
    expiryEvidence: [
      {
        details: {
          operationId: "administrative-operation-1",
          reconciledAt: "2026-10-02T16:30:00.000Z",
          rollbackDeadline: "2026-10-02T16:30:00.000Z",
        },
      },
    ],
    status: { revision: 2, stateVersion: 2, status: "active" },
  });
  expect(raced.filter((result) => result.decision === "activated")).toHaveLength(1);
  expect(raced.filter((result) => result.decision === "denied")).toHaveLength(1);

  await restarted.close();
});

test("an unfinished Live Patch cannot expire its rollback window after the mutation crash window", async () => {
  const clock = { current: "2026-10-02T16:45:00.000Z" };
  const reconciliationCallbacks: Array<() => Promise<void>> = [];
  const { databasePath, scenario } = await createActivatedScenario(
    {
      clock,
      crashAfterFirstEffect: true,
      now: clock.current,
      providerPlan: [{ kind: "live-patch.apply" }],
      reconciliationCallbacks,
    },
    temporaryDirectories,
  );
  const admission = await scenario.confirmAndRunTask({
    confirmation: "confirmed",
    intendedState: "The urgent production behavior is restored.",
    outcome: "restore",
    ownerId: "owner",
    requestId: "unfinished-live-patch-expiry",
    target,
  });

  clock.current = "2026-10-02T17:16:00.000Z";
  const reactivation = await scenario.activatePolicy({
    expectedActiveRevision: 1,
    expectedStateVersion: 1,
    freshPasskey: true,
  });
  const beforeSuspension = await scenario.readTask("administrative-task-1");
  const suspension = await scenario.suspendPolicy({
    authenticated: true,
    expectedRevision: 1,
    expectedStateVersion: 1,
  });
  await scenario.close();

  const restarted = await createAdministrativeAutonomyScenario({
    clock,
    databasePath,
    identifierNamespace: "unfinished-live-patch-restart-",
    now: clock.current,
    providerPlan: [{ kind: "live-patch.apply" }],
  });
  const recovered = await restarted.readPolicyStatus();

  expect({ admission, beforeSuspension, reactivation, recovered, suspension }).toMatchObject({
    admission: { decision: "admitted" },
    beforeSuspension: { task: { status: "running" } },
    reactivation: {
      body: {
        error:
          "Administrative Autonomy has unresolved Live Patch rollback windows",
      },
      statusCode: 409,
    },
    recovered: {
      rollbackActivations: {
        activatedOperationIds: ["administrative-operation-1"],
        pendingOperationIds: [],
      },
      status: "suspended",
    },
    suspension: { body: { status: "suspended" }, statusCode: 200 },
  });
  expect(
    beforeSuspension?.evidence.filter(
      (event) => event.kind === "administrative.live-patch.rollback-window-expired",
    ),
  ).toEqual([]);
  await restarted.close();
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
      body: {
        error:
          "Administrative Autonomy has unresolved Live Patch rollback windows",
      },
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
