import {
  administrativeExecutionManifestSchema,
  administrativeExecutionManifestFingerprint,
  administrativeUnavailableExecutionManifest,
  livePatchRollbackWindowMilliseconds,
  type AdministrativeEvidenceRecord,
  type AdministrativeExecutionManifest,
  type AdministrativeOperationRequest,
  type AdministrativeOperationResult,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativeProviderPlan,
  type AdministrativeRequestedOutcome,
  type AdministrativeTaskTarget,
  type LivePatchMutationProof,
} from "@voice-agent/contracts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import {
  createAdministrativeAutonomyRuntime,
  createTaskContinuityRuntime,
  type AdministrativeTaskAdmissionResult,
} from "@voice-agent/runtime";
import {
  createSqliteAdministrativeAutonomyStore,
  createSqliteDurableTaskStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";

const scenarioOrigin = "https://voice.stephens.page";
const scenarioSession = "scenario-trusted-session";
const scenarioCsrf = "scenario-csrf-token-0001";

export interface AdministrativeAutonomyScenario {
  readonly executedOperations: AdministrativeOperationRequest[];
  readonly operationAttempts: AdministrativeOperationRequest[];
  applyEvidenceLifecyclePolicy(input: {
    readonly freshPasskey: boolean;
  }): Promise<{ readonly body: unknown; readonly statusCode: number }>;
  activatePolicy(input: {
    readonly expectedActiveRevision: number | null;
    readonly expectedExecutionManifestFingerprint?: string;
    readonly expectedStateVersion: number;
    readonly freshPasskey: boolean;
  }): Promise<{ readonly body: unknown; readonly statusCode: number }>;
  attemptPolicyActivation(input: {
    readonly expectedActiveRevision: number | null;
    readonly expectedStateVersion: number;
    readonly source: AdministrativePolicyActivationSource;
  }): ReturnType<
    ReturnType<typeof createAdministrativeAutonomyRuntime>["activatePolicy"]
  >;
  attemptOperationClaimRenewal(input: {
    readonly claimId: string;
    readonly leaseExpiresAt: string;
    readonly operationId: string;
    readonly renewedAt: string;
  }): Promise<boolean>;
  close(): Promise<void>;
  confirmAndRunTask(input: {
    readonly confirmation: "ambiguous" | "confirmed" | "declined";
    readonly intendedState: string;
    readonly outcome: AdministrativeRequestedOutcome;
    readonly ownerId: string;
    readonly requestId: string;
    readonly target: AdministrativeTaskTarget;
  }): Promise<AdministrativeTaskAdmissionResult>;
  interleavePolicyRevisionBeforePlanAdmission(): void;
  interleavePolicyRevisionAfterFirstOperation(): void;
  answerTask: ReturnType<
    typeof createAdministrativeAutonomyRuntime
  >["answerTaskConfirmation"];
  prepareTask: ReturnType<
    typeof createAdministrativeAutonomyRuntime
  >["prepareTaskConfirmation"];
  readTask(taskId: string): Promise<AdministrativeEvidenceRecord | undefined>;
  readTaskByOperationId(
    operationId: string,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  readPolicyStatus(): Promise<AdministrativePolicyStatus>;
  readAutonomyStatus(): Promise<{
    readonly body: unknown;
    readonly statusCode: number;
  }>;
  reconcileOperations(): Promise<void>;
  suspendPolicy(input: {
    readonly authenticated: boolean;
    readonly expectedRevision: number;
    readonly expectedStateVersion: number;
  }): Promise<{ readonly body: unknown; readonly statusCode: number }>;
  suspendPolicyState(): Promise<AdministrativePolicyStatus>;
}

export async function createAdministrativeAutonomyScenario(options: {
  readonly beforeOperationEffect?: (
    request: AdministrativeOperationRequest,
  ) => Promise<void>;
  readonly clock?: { readonly current: string };
  readonly crashAfterFirstEffect?: boolean;
  readonly databasePath: string;
  readonly effectLedger?: Set<string>;
  readonly executorFailures?: number;
  readonly executionAdapters?: "available" | "unavailable";
  readonly executionManifestVersion?: 1 | 2;
  readonly holdOperationUntilAbort?: boolean;
  readonly identifierNamespace?: string;
  readonly livePatchRollbackArmLeadMilliseconds?: number;
  readonly livePatchRollbackDurationMilliseconds?: number;
  readonly livePatchProofLedger?: Map<string, LivePatchMutationProof>;
  readonly now: string;
  readonly onOperationStart?: () => void;
  readonly operationLeaseMilliseconds?: number;
  readonly operationAttempts?: string[];
  readonly omitLivePatchReconciliation?: boolean;
  readonly providerAttempts?: string[];
  readonly providerFailures?: number;
  readonly providerPlan: AdministrativeProviderPlan | unknown;
  readonly reportedCompletionTime?: string;
}): Promise<AdministrativeAutonomyScenario> {
  let capabilitySequence = 0;
  let claimSequence = 0;
  let eventSequence = 0;
  let operationSequence = 0;
  let taskSequence = 0;
  let freshPasskey = false;
  let crashedAfterEffect = false;
  let revisePolicyAfterFirstOperation = false;
  let revisePolicyBeforePlanAdmission = false;
  let providerFailuresRemaining = options.providerFailures ?? 0;
  let executorFailuresRemaining = options.executorFailures ?? 0;
  const executedOperations: AdministrativeOperationRequest[] = [];
  const operationAttempts: AdministrativeOperationRequest[] = [];
  const effectLedger = options.effectLedger ?? new Set<string>();
  const livePatchProofLedger = options.livePatchProofLedger ?? new Map();
  const identifierNamespace = options.identifierNamespace ?? "";
  const currentTime = () => options.clock?.current ?? options.now;
  const store = createSqliteAdministrativeAutonomyStore(options.databasePath);
  const executionManifest =
    options.executionAdapters === "unavailable"
      ? administrativeUnavailableExecutionManifest
      : createScenarioExecutionManifest(options.executionManifestVersion ?? 1);
  let runtime: ReturnType<typeof createAdministrativeAutonomyRuntime>;
  const executor = {
    async execute(execution: {
      readonly fence: {
        readonly activeExecutionDeadline: string;
        readonly attemptStartedAt: string;
        readonly claimId: string;
        readonly initialExecutionStartedAt: string;
        readonly recovered: boolean;
        readonly signal: AbortSignal;
      };
      readonly request: AdministrativeOperationRequest;
    }) {
      const { request } = execution;
      const {
        activeExecutionDeadline,
        attemptStartedAt,
        initialExecutionStartedAt,
        signal,
      } = execution.fence;
      operationAttempts.push(request);
      options.operationAttempts?.push(request.operationId);
      options.onOperationStart?.();
      if (executorFailuresRemaining > 0) {
        executorFailuresRemaining -= 1;
        throw new Error("Simulated executor failure before the Operation effect");
      }
      if (options.holdOperationUntilAbort) await waitForAbort(signal);
      const effectWasAlreadyApplied = effectLedger.has(request.operationId);
      let livePatchProof =
        request.kind === "live-patch.apply"
          ? livePatchProofLedger.get(request.operationId)
          : undefined;
      let effectPerformedAt = attemptStartedAt;
      if (!effectWasAlreadyApplied) {
        await options.beforeOperationEffect?.(request);
        if (signal.aborted || currentTime() >= activeExecutionDeadline) {
          throw new Error("The bounded administrative execution was aborted");
        }
        effectPerformedAt = currentTime();
        if (request.kind === "live-patch.apply") {
          livePatchProof = createLivePatchProof(
            request,
            effectPerformedAt,
            options.livePatchRollbackArmLeadMilliseconds ?? 0,
            options.livePatchRollbackDurationMilliseconds ??
              livePatchRollbackWindowMilliseconds,
          );
          livePatchProofLedger.set(request.operationId, livePatchProof);
        }
        effectLedger.add(request.operationId);
        executedOperations.push(request);
        if (revisePolicyAfterFirstOperation) {
          revisePolicyAfterFirstOperation = false;
          const policy = await runtime.getPolicyStatus();
          if (policy.status !== "active") {
            throw new Error("The interleaved policy revision has no active base");
          }
          await runtime.activatePolicy({
            expectedActiveRevision: policy.revision,
            expectedExecutionManifestFingerprint:
              administrativeExecutionManifestFingerprint(executionManifest),
            expectedStateVersion: policy.stateVersion,
            source: "fresh-passkey-action",
          });
        }
        if (options.crashAfterFirstEffect && !crashedAfterEffect) {
          crashedAfterEffect = true;
          throw new Error("Simulated process loss after the Operation effect");
        }
      }
      if (request.kind === "live-patch.apply" && livePatchProof === undefined) {
        throw new Error("The fake Live Patch broker lost its durable proof");
      }
      const common = {
        completedAt: options.reportedCompletionTime ?? currentTime(),
        effect: effectWasAlreadyApplied
          ? {
              kind: "idempotent-effect-replay" as const,
              originallyStartedAt:
                livePatchProof?.mutationStartedAt ?? initialExecutionStartedAt,
              replayedAt: attemptStartedAt,
            }
          : {
              kind: "effect-performed" as const,
              startedAt: livePatchProof?.mutationStartedAt ?? effectPerformedAt,
            },
        operationId: request.operationId,
        summary: `The ${request.kind} Operation completed through the fake executor.`,
      };
      if (request.kind === "live-patch.apply") {
        const result = {
          ...common,
          kind: request.kind,
          mutationProof: livePatchProof,
        };
        if (options.omitLivePatchReconciliation) {
          const incompleteProof = {
            healthCheck: result.mutationProof.healthCheck,
            independentRollback: result.mutationProof.independentRollback,
            mutationStartedAt: result.mutationProof.mutationStartedAt,
            verification: result.mutationProof.verification,
          };
          return {
            ...result,
            mutationProof: incompleteProof,
          } as unknown as AdministrativeOperationResult;
        }
        return result;
      }
      if (request.kind === "production.observe") {
        return {
          ...common,
          kind: request.kind,
          observation: {
            kind: "registered-application-health" as const,
            status: "healthy" as const,
          },
        };
      }
      return {
        ...common,
        kind: request.kind,
        publication:
          request.publication.kind === "open-pull-request"
            ? {
                baseBranch: "registered-production-branch" as const,
                kind: "isolated-pull-request-opened" as const,
                productionMutation: false as const,
                registeredCodebaseId: request.target.registeredCodebaseId,
                state: "open" as const,
              }
            : {
                kind: "isolated-branch-prepared" as const,
                productionMutation: false as const,
              },
      };
    },
  };
  const provider = {
    async choosePlan(input: { readonly taskId: string }) {
      options.providerAttempts?.push(input.taskId);
      if (providerFailuresRemaining > 0) {
        providerFailuresRemaining -= 1;
        throw new Error("Simulated provider failure during planning");
      }
      if (revisePolicyBeforePlanAdmission) {
        revisePolicyBeforePlanAdmission = false;
        const policy = await runtime.getPolicyStatus();
        if (policy.status !== "active") {
          throw new Error("The interleaved policy revision has no active base");
        }
        await runtime.activatePolicy({
          expectedActiveRevision: policy.revision,
          expectedExecutionManifestFingerprint:
            administrativeExecutionManifestFingerprint(executionManifest),
          expectedStateVersion: policy.stateVersion,
          source: "fresh-passkey-action",
        });
      }
      return options.providerPlan;
    },
  };
  runtime = createAdministrativeAutonomyRuntime({
    ...(options.executionAdapters === "unavailable"
      ? {}
      : { executor, provider }),
    executionManifest,
    identifiers: {
      nextCapability: () =>
        `${identifierNamespace}administrative-confirmation-capability-${(capabilitySequence += 1)}`,
      nextClaimId: () =>
        `${identifierNamespace}administrative-claim-${(claimSequence += 1)}`,
      nextEventId: () =>
        `${identifierNamespace}administrative-event-${(eventSequence += 1)}`,
      nextOperationId: () =>
        `${identifierNamespace}administrative-operation-${(operationSequence += 1)}`,
      nextTaskId: () =>
        `${identifierNamespace}administrative-task-${(taskSequence += 1)}`,
    },
    now: currentTime,
    ...(options.operationLeaseMilliseconds === undefined
      ? {}
      : { operationLeaseMilliseconds: options.operationLeaseMilliseconds }),
    store,
  });
  await runtime.reconcileOperations();
  const ordinaryTaskStore = createSqliteDurableTaskStore(options.databasePath);
  const continuity = createTaskContinuityRuntime({
    administrativeEvidenceRetention: runtime,
    nextId: () =>
      `${identifierNamespace}administrative-continuity-${(eventSequence += 1)}`,
    now: currentTime,
    store: createSqliteTaskContinuityStore(options.databasePath),
    tasks: ordinaryTaskStore,
  });
  const api = createTaskApi({
    administrativeControls: runtime,
    authentication: {
      async canChangeState({ csrfToken, sessionToken }) {
        return csrfToken === scenarioCsrf && sessionToken === scenarioSession;
      },
      async canViewEvidence(sessionToken) {
        return sessionToken === scenarioSession;
      },
      async hasFreshPasskeyAction(sessionToken) {
        return sessionToken === scenarioSession && freshPasskey;
      },
    },
    completionControls: continuity,
    origin: scenarioOrigin,
    records: {
      getEvidenceRecord: (taskId) => runtime.getTask(taskId),
      listEvidenceRecords: () => runtime.listTasks(),
      async recordPolicyDenial() {},
    },
  });

  return {
    async applyEvidenceLifecyclePolicy(input) {
      freshPasskey = input.freshPasskey;
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=${scenarioSession}`,
          origin: scenarioOrigin,
        },
        method: "POST",
        payload: { csrfToken: scenarioCsrf },
        url: "/api/evidence/retention",
      });
      freshPasskey = false;
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
    async activatePolicy(input) {
      freshPasskey = input.freshPasskey;
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=${scenarioSession}`,
          origin: scenarioOrigin,
        },
        method: "POST",
        payload: {
          csrfToken: scenarioCsrf,
          expectedActiveRevision: input.expectedActiveRevision,
          expectedExecutionManifestFingerprint:
            input.expectedExecutionManifestFingerprint ??
            administrativeExecutionManifestFingerprint(executionManifest),
          expectedStateVersion: input.expectedStateVersion,
        },
        url: "/api/administrative-autonomy/activate",
      });
      freshPasskey = false;
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
    async close() {
      await api.close();
      await continuity.close();
      await ordinaryTaskStore.close();
      await runtime.close();
    },
    attemptOperationClaimRenewal: (input) =>
      store.renewOperationClaim(input),
    attemptPolicyActivation: (input) =>
      runtime.activatePolicy({
        ...input,
        expectedExecutionManifestFingerprint:
          administrativeExecutionManifestFingerprint(executionManifest),
      }),
    async confirmAndRunTask(input) {
      const prepared = await runtime.prepareTaskConfirmation({
        intendedState: input.intendedState,
        outcome: input.outcome,
        ownerId: input.ownerId,
        requestId: input.requestId,
        target: input.target,
      });
      if (prepared.decision === "denied") return prepared;
      return runtime.answerTaskConfirmation({
        confirmation: input.confirmation,
        confirmationCapability: prepared.confirmationCapability,
        ownerId: input.ownerId,
        taskId: prepared.taskId,
      });
    },
    answerTask: (input) => runtime.answerTaskConfirmation(input),
    executedOperations,
    operationAttempts,
    interleavePolicyRevisionAfterFirstOperation() {
      revisePolicyAfterFirstOperation = true;
    },
    interleavePolicyRevisionBeforePlanAdmission() {
      revisePolicyBeforePlanAdmission = true;
    },
    prepareTask: (input) => runtime.prepareTaskConfirmation(input),
    readPolicyStatus: () => runtime.getPolicyStatus(),
    async readAutonomyStatus() {
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=${scenarioSession}`,
        },
        method: "GET",
        url: "/api/administrative-autonomy",
      });
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
    readTask: (taskId) => runtime.getTask(taskId),
    readTaskByOperationId: (operationId) =>
      runtime.getTaskByOperationId(operationId),
    reconcileOperations: () => runtime.reconcileOperations(),
    async suspendPolicy(input) {
      const response = await api.inject({
        headers: {
          ...(input.authenticated
            ? { cookie: `${trustedSessionCookieName}=${scenarioSession}` }
            : {}),
          origin: scenarioOrigin,
        },
        method: "POST",
        payload: {
          csrfToken: scenarioCsrf,
          expectedRevision: input.expectedRevision,
          expectedStateVersion: input.expectedStateVersion,
        },
        url: "/api/administrative-autonomy/suspend",
      });
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
    async suspendPolicyState() {
      const policy = await store.readPolicyStatus();
      if (policy.status !== "active") {
        throw new Error("Administrative Autonomy is not active");
      }
      const suspended = await store.suspendPolicy({
        expectedRevision: policy.revision,
        expectedStateVersion: policy.stateVersion,
        suspendedAt: currentTime(),
      });
      if (suspended === undefined) {
        throw new Error("Administrative Suspension state changed concurrently");
      }
      return suspended;
    },
  };
}

function createLivePatchProof(
  request: Extract<AdministrativeOperationRequest, { kind: "live-patch.apply" }>,
  effectStartedAt: string,
  rollbackArmLeadMilliseconds: number,
  rollbackDurationMilliseconds: number,
): LivePatchMutationProof {
  const rollbackArmedAt = new Date(
    new Date(effectStartedAt).getTime() - rollbackArmLeadMilliseconds,
  ).toISOString();
  return {
    healthCheck: {
      kind: "registered-application-health",
      observedAt: rollbackArmedAt,
      status: "healthy",
    },
    independentRollback: {
      armedBeforeMutation: true,
      armedAt: rollbackArmedAt,
      kind: "independent-live-patch-rollback",
      rollbackDeadline: new Date(
        new Date(rollbackArmedAt).getTime() + rollbackDurationMilliseconds,
      ).toISOString(),
    },
    mutationStartedAt: effectStartedAt,
    reconciliation: {
      baseBranch: "registered-production-branch",
      kind: "captured-as-isolated-pull-request",
      observedAt: effectStartedAt,
      productionMutationRetained: true,
      reconciledPatch: "accepted-live-patch-diff",
      registeredCodebaseId: request.target.registeredCodebaseId,
      state: "open",
      verifiedBy: "independent-reconciliation-observer",
    },
    verification: {
      kind: "independent-application-health-proof",
      observedAt: effectStartedAt,
      status: "healthy",
    },
  };
}

function createScenarioExecutionManifest(
  version: 1 | 2,
): AdministrativeExecutionManifest {
  const offset = version === 1 ? 0 : 4;
  return administrativeExecutionManifestSchema.parse({
    operationAdapters: [
      {
        implementationDigest: String(1 + offset).repeat(64),
        kind: "production.observe",
      },
      {
        implementationDigest: String(2 + offset).repeat(64),
        kind: "delegated-worktree.change",
      },
      {
        implementationDigest: String(3 + offset).repeat(64),
        kind: "live-patch.apply",
      },
    ],
    provider: {
      implementationDigest: String(4 + offset).repeat(64),
      kind: "scenario-fake",
    },
    schemaVersion: 1,
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectForAbort = () =>
      reject(new Error("The bounded administrative execution was aborted"));
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener("abort", rejectForAbort, { once: true });
  });
}
