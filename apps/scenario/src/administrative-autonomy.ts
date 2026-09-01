import {
  administrativeExecutionManifestSchema,
  administrativeExecutionManifestFingerprint,
  administrativeOperationClaimIdSchema,
  administrativeOperationIdSchema,
  administrativeRegisteredCodebaseSchema,
  administrativeTaskIdSchema,
  administrativeTimestampSchema,
  administrativeUnavailableExecutionManifest,
  livePatchMutationProofSchema,
  livePatchRollbackActivationResultSchema,
  livePatchRollbackWindowMilliseconds,
  type AdministrativeEvidenceRecord,
  type AdministrativeExecutionManifest,
  type AdministrativeOperationRequest,
  type AdministrativeOperationResult,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativeProviderPlan,
  type AdministrativeRequestedOutcome,
  type AdministrativeTaskTargetRequest,
  type AdministrativeTimestamp,
  type LivePatchMutationProof,
  type LivePatchRollbackActivationRequest,
} from "@voice-agent/contracts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import {
  createAdministrativeAutonomyRuntime,
  createTaskContinuityRuntime,
  type AdministrativeOperationExecution,
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
    readonly target: AdministrativeTaskTargetRequest;
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
  readPolicyEvidencePage(input?: {
    readonly beforeSequence?: number;
    readonly limit?: number;
  }): Promise<{ readonly body: unknown; readonly statusCode: number }>;
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

interface ScenarioOperationResultContext {
  readonly common: Pick<
    AdministrativeOperationResult,
    "completedAt" | "effect" | "operationId" | "summary"
  >;
  readonly delegatedWorktreeProof:
    | "failed-verification"
    | "mismatched"
    | "missing"
    | "valid";
  readonly livePatchProof: LivePatchMutationProof | undefined;
  readonly omitLivePatchReconciliation: boolean;
}

type ScenarioOperationResultHandler = (
  request: AdministrativeOperationRequest,
  context: ScenarioOperationResultContext,
) => AdministrativeOperationResult;

const scenarioOperationResultHandlers = {
  "delegated-worktree.change": (request, context) => {
    if (request.kind !== "delegated-worktree.change") {
      throw new Error("The scenario Delegated Worktree handler was cross-wired");
    }
    const result = {
      ...context.common,
      delegation: {
        branch:
          context.delegatedWorktreeProof === "mismatched"
            ? "administrative/untrusted-provider-branch"
            : request.delegation.worktree.branch,
        changedFiles: ["src/administrative-change.ts"],
        commits: ["a".repeat(40)],
        completedAt: context.common.completedAt,
        delegationId: request.delegation.delegationId,
        failure: null,
        risks: [],
        status: "completed" as const,
        verification: {
          automated: request.delegation.verificationCommands.map((command) => ({
            command,
            outcome:
              context.delegatedWorktreeProof === "failed-verification"
                ? ("failed" as const)
                : ("passed" as const),
            summary: `${command} completed in the restricted Delegated Worktree.`,
          })),
        },
        worktree: {
          ...request.delegation.worktree,
          dirty: false,
          state: "completed" as const,
        },
      },
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
    if (context.delegatedWorktreeProof === "missing") {
      const { delegation: _delegation, ...missingProof } = result;
      return missingProof as unknown as AdministrativeOperationResult;
    }
    return result;
  },
  "live-patch.apply": (request, context) => {
    if (request.kind !== "live-patch.apply" || context.livePatchProof === undefined) {
      throw new Error("The scenario Live Patch handler was cross-wired");
    }
    const result = {
      ...context.common,
      kind: request.kind,
      mutationProof: context.livePatchProof,
    };
    if (!context.omitLivePatchReconciliation) return result;
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
  },
  "production.observe": (request, context) => {
    if (request.kind !== "production.observe") {
      throw new Error("The scenario observation handler was cross-wired");
    }
    return {
      ...context.common,
      kind: request.kind,
      observation: {
        kind: "registered-application-health" as const,
        status: "healthy" as const,
      },
    };
  },
} satisfies Record<
  AdministrativeOperationRequest["kind"],
  ScenarioOperationResultHandler
>;

export async function createAdministrativeAutonomyScenario(options: {
  readonly beforeOperationEffect?: (
    request: AdministrativeOperationRequest,
  ) => Promise<void>;
  readonly beforeProviderPlanReturn?: (input: {
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly afterLivePatchRollbackArmed?: (
    request: Extract<
      AdministrativeOperationRequest,
      { kind: "live-patch.apply" }
    >,
  ) => Promise<void>;
  readonly clock?: { readonly current: string };
  readonly crashAfterFirstRollbackActivation?: boolean;
  readonly crashAfterFirstEffect?: boolean;
  readonly databasePath: string;
  readonly effectLedger?: Set<string>;
  readonly executorFailures?: number;
  readonly executionAdapters?: "available" | "unavailable";
  readonly executionImplementationVersions?: {
    readonly executor?: 1 | 2;
    readonly provider?: 1 | 2;
    readonly rollbackActivator?: 1 | 2;
  };
  /** Deliberately untrusted claims exposed by fake implementation objects. */
  readonly selfReportedExecutionImplementationVersions?: {
    readonly executor?: 1 | 2;
    readonly provider?: 1 | 2;
    readonly rollbackActivator?: 1 | 2;
  };
  readonly executionManifestVersion?: 1 | 2;
  readonly holdOperationUntilAbort?: boolean;
  readonly identifierNamespace?: string;
  readonly livePatchRollbackArmLeadMilliseconds?: number;
  readonly livePatchRollbackDurationMilliseconds?: number;
  readonly livePatchProofLedger?: Map<string, LivePatchMutationProof>;
  readonly now: string;
  readonly onOperationStart?: () => void;
  readonly onProviderPlanStart?: () => void;
  readonly operationLeaseMilliseconds?: number;
  readonly operationAttempts?: string[];
  readonly omitLivePatchReconciliation?: boolean;
  readonly providerAttempts?: string[];
  readonly providerFailures?: number;
  readonly planningDeadlineCallbacks?: Array<() => void>;
  readonly providerPlan: AdministrativeProviderPlan | unknown;
  readonly providerSignals?: Array<AbortSignal | undefined>;
  readonly reconciliationCallbacks?: Array<() => Promise<void>>;
  readonly reconciliationSchedule?: string[];
  readonly reportedCompletionTime?: string;
  readonly rollbackActivationAttempts?: LivePatchRollbackActivationRequest[];
  readonly rollbackActivationEffects?: string[];
  readonly rollbackActivationFailures?: number;
  readonly rollbackActivationLedger?: Set<string>;
  readonly rollbackActivationTimeLedger?: Map<
    string,
    AdministrativeTimestamp
  >;
  readonly delegatedWorktreeProof?:
    | "failed-verification"
    | "mismatched"
    | "missing"
    | "valid";
  readonly registeredCodebaseAvailability?: "available" | "unavailable";
  readonly registeredCodebaseExpiresAt?: string;
  readonly registeredCodebaseRevisionByLookup?: readonly number[];
}): Promise<AdministrativeAutonomyScenario> {
  let capabilitySequence = 0;
  let claimSequence = 0;
  let eventSequence = 0;
  let operationSequence = 0;
  let taskSequence = 0;
  let freshPasskey = false;
  let crashedAfterEffect = false;
  let crashedAfterRollbackActivation = false;
  let revisePolicyAfterFirstOperation = false;
  let revisePolicyBeforePlanAdmission = false;
  let providerFailuresRemaining = options.providerFailures ?? 0;
  let executorFailuresRemaining = options.executorFailures ?? 0;
  let rollbackActivationFailuresRemaining =
    options.rollbackActivationFailures ?? 0;
  const executedOperations: AdministrativeOperationRequest[] = [];
  const operationAttempts: AdministrativeOperationRequest[] = [];
  const effectLedger = options.effectLedger ?? new Set<string>();
  const livePatchProofLedger = options.livePatchProofLedger ?? new Map();
  const rollbackActivationLedger = options.rollbackActivationLedger ?? new Set();
  const rollbackActivationTimeLedger =
    options.rollbackActivationTimeLedger ?? new Map();
  const identifierNamespace = options.identifierNamespace ?? "";
  const currentTime = () => options.clock?.current ?? options.now;
  let registeredCodebaseLookup = 0;
  const store = createSqliteAdministrativeAutonomyStore(options.databasePath);
  const executionManifest =
    options.executionAdapters === "unavailable"
      ? administrativeUnavailableExecutionManifest
      : createScenarioExecutionManifest(options.executionManifestVersion ?? 1);
  const implementationVersion = options.executionManifestVersion ?? 1;
  const executorManifest = createScenarioExecutionManifest(
    options.executionImplementationVersions?.executor ?? implementationVersion,
  );
  const providerManifest = createScenarioExecutionManifest(
    options.executionImplementationVersions?.provider ?? implementationVersion,
  );
  const rollbackActivatorManifest = createScenarioExecutionManifest(
    options.executionImplementationVersions?.rollbackActivator ??
      implementationVersion,
  );
  const selfReportedExecutorManifest = createScenarioExecutionManifest(
    options.selfReportedExecutionImplementationVersions?.executor ??
      options.executionImplementationVersions?.executor ??
      implementationVersion,
  );
  const selfReportedProviderManifest = createScenarioExecutionManifest(
    options.selfReportedExecutionImplementationVersions?.provider ??
      options.executionImplementationVersions?.provider ??
      implementationVersion,
  );
  const selfReportedRollbackActivatorManifest = createScenarioExecutionManifest(
    options.selfReportedExecutionImplementationVersions?.rollbackActivator ??
      options.executionImplementationVersions?.rollbackActivator ??
      implementationVersion,
  );
  if (providerManifest.provider.kind !== "scenario-fake") {
    throw new Error("The scenario provider identity is unavailable");
  }
  if (selfReportedProviderManifest.provider.kind !== "scenario-fake") {
    throw new Error("The self-reported scenario provider identity is unavailable");
  }
  const providerIdentity = selfReportedProviderManifest.provider;
  const rollbackActivatorImplementation =
    rollbackActivatorManifest.operationAdapters.find(
      (adapter) => adapter.kind === "live-patch.apply",
    );
  if (rollbackActivatorImplementation === undefined) {
    throw new Error("The scenario rollback activator identity is unavailable");
  }
  const selfReportedRollbackActivatorImplementation =
    selfReportedRollbackActivatorManifest.operationAdapters.find(
      (adapter) => adapter.kind === "live-patch.apply",
    );
  if (selfReportedRollbackActivatorImplementation === undefined) {
    throw new Error(
      "The self-reported scenario rollback activator identity is unavailable",
    );
  }
  let runtime: ReturnType<typeof createAdministrativeAutonomyRuntime>;
  const executor = {
    identity: {
      operationAdapters: selfReportedExecutorManifest.operationAdapters.map(
        ({ implementationDigest, kind }) => ({ implementationDigest, kind }),
      ),
    },
    async execute(execution: AdministrativeOperationExecution) {
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
        effectPerformedAt = administrativeTimestampSchema.parse(currentTime());
        if (request.kind === "live-patch.apply") {
          const armedAt = administrativeTimestampSchema.parse(
            new Date(
              new Date(effectPerformedAt).getTime() -
                (options.livePatchRollbackArmLeadMilliseconds ?? 0),
            ).toISOString(),
          );
          const rollbackDuration =
            options.livePatchRollbackDurationMilliseconds ??
            livePatchRollbackWindowMilliseconds;
          const initialRollbackDeadline = administrativeTimestampSchema.parse(
            new Date(
              new Date(armedAt).getTime() + rollbackDuration,
            ).toISOString(),
          );
          await execution.fence.armLivePatchRollback({
            armedAt,
            rollbackDeadline: initialRollbackDeadline,
          });
          await options.afterLivePatchRollbackArmed?.(request);
          effectPerformedAt = administrativeTimestampSchema.parse(currentTime());
          const rollbackDeadline = administrativeTimestampSchema.parse(
            new Date(
              new Date(effectPerformedAt).getTime() + rollbackDuration,
            ).toISOString(),
          );
          livePatchProof = createLivePatchProof(
            request,
            armedAt,
            effectPerformedAt,
            rollbackDeadline,
          );
          await execution.fence.activateLivePatchRollbackWindow({
            armedAt,
            mutationStartedAt: effectPerformedAt,
            rollbackDeadline,
          });
          livePatchProofLedger.set(request.operationId, livePatchProof);
        } else {
          await execution.fence.recheckEffectAuthority();
        }
        if (signal.aborted || currentTime() >= activeExecutionDeadline) {
          throw new Error("The bounded administrative execution was aborted");
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
            expectation: {
              expectedActiveRevision: policy.revision,
              expectedExecutionManifestFingerprint:
                administrativeExecutionManifestFingerprint(executionManifest),
              expectedStateVersion: policy.stateVersion,
            },
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
        completedAt: administrativeTimestampSchema.parse(
          options.reportedCompletionTime ?? currentTime(),
        ),
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
      return scenarioOperationResultHandlers[request.kind](request, {
        common,
        delegatedWorktreeProof: options.delegatedWorktreeProof ?? "valid",
        livePatchProof,
        omitLivePatchReconciliation:
          options.omitLivePatchReconciliation ?? false,
      });
    },
  };
  const provider = {
    identity: providerIdentity,
    async choosePlan(input: {
      readonly signal?: AbortSignal;
      readonly taskId: string;
    }) {
      options.providerAttempts?.push(input.taskId);
      options.providerSignals?.push(input.signal);
      options.onProviderPlanStart?.();
      await options.beforeProviderPlanReturn?.(
        input.signal === undefined ? {} : { signal: input.signal },
      );
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
          expectation: {
            expectedActiveRevision: policy.revision,
            expectedExecutionManifestFingerprint:
              administrativeExecutionManifestFingerprint(executionManifest),
            expectedStateVersion: policy.stateVersion,
          },
          source: "fresh-passkey-action",
        });
      }
      return options.providerPlan;
    },
  };
  const rollbackActivator = {
    identity: {
      implementationDigest:
        selfReportedRollbackActivatorImplementation.rollbackActivationImplementationDigest,
      kind: "live-patch.apply" as const,
    },
    async activate(request: LivePatchRollbackActivationRequest) {
      options.rollbackActivationAttempts?.push(request);
      if (rollbackActivationFailuresRemaining > 0) {
        rollbackActivationFailuresRemaining -= 1;
        throw new Error("Simulated Live Patch rollback activation failure");
      }
      const existingActivation = rollbackActivationTimeLedger.get(
        request.operationId,
      );
      if (
        rollbackActivationLedger.has(request.operationId) &&
        existingActivation === undefined
      ) {
        throw new Error("The rollback activator lost its durable proof");
      }
      const activatedAt =
        existingActivation ?? administrativeTimestampSchema.parse(currentTime());
      if (existingActivation === undefined) {
        rollbackActivationLedger.add(request.operationId);
        rollbackActivationTimeLedger.set(request.operationId, activatedAt);
        options.rollbackActivationEffects?.push(request.operationId);
        if (
          options.crashAfterFirstRollbackActivation &&
          !crashedAfterRollbackActivation
        ) {
          crashedAfterRollbackActivation = true;
          throw new Error(
            "Simulated process loss after Live Patch rollback activation",
          );
        }
      }
      return livePatchRollbackActivationResultSchema.parse({
        activatedAt,
        kind: "live-patch-rollback-activated",
        operationId: request.operationId,
        outcome:
          existingActivation === undefined ? "activated" : "already-activated",
        productionMutationRetained: false,
        target: request.target,
        taskId: request.taskId,
        verifiedBy: "independent-live-patch-rollback-controller",
      });
    },
  };
  try {
    runtime = createAdministrativeAutonomyRuntime({
      ...(options.executionAdapters === "unavailable"
        ? {}
        : {
            executor,
            implementationCatalog: {
              identifyExecutor(implementation) {
                if (implementation !== executor) return undefined;
                return {
                  operationAdapters: executorManifest.operationAdapters.map(
                    ({ implementationDigest, kind }) => ({
                      implementationDigest,
                      kind,
                    }),
                  ),
                };
              },
              identifyProvider(implementation) {
                return implementation === provider
                  ? providerManifest.provider
                  : undefined;
              },
              identifyRollbackActivator(implementation) {
                return implementation === rollbackActivator
                  ? {
                      implementationDigest:
                        rollbackActivatorImplementation.rollbackActivationImplementationDigest,
                      kind: "live-patch.apply" as const,
                    }
                  : undefined;
              },
            },
            provider,
            registeredCodebases: {
              async findRegisteredCodebase(registeredCodebaseId: string) {
                if (
                  options.registeredCodebaseAvailability === "unavailable"
                ) {
                  throw new Error("Registered Codebase registry unavailable");
                }
                if (registeredCodebaseId !== "voice-agent") return undefined;
                const revisions = options.registeredCodebaseRevisionByLookup;
                const revision =
                  revisions?.[
                    Math.min(registeredCodebaseLookup, revisions.length - 1)
                  ] ?? 1;
                registeredCodebaseLookup += 1;
                return administrativeRegisteredCodebaseSchema.parse({
                  applicationId: "voice-agent",
                  expiresAt:
                    options.registeredCodebaseExpiresAt ??
                    "2100-01-01T00:00:00.000Z",
                  initialProductionCommit: "1".repeat(40),
                  liveCheckoutPath: "/srv/voice-agent",
                  productionBranch: "main",
                  registeredAt: "1990-01-01T00:00:00.000Z",
                  repository: "JacobStephens2/voice-agent",
                  revision,
                  sourceCheckoutRoot: "/srv/source/voice-agent",
                  verificationCommands: ["pnpm typecheck", "pnpm test"],
                  worktreeRoot: "/var/lib/voice-agent/worktrees/voice-agent",
                });
              },
            },
            rollbackActivator,
          }),
      executionManifest,
      identifiers: {
        nextCapability: () =>
          `${identifierNamespace}administrative-confirmation-capability-${(capabilitySequence += 1)}`,
        nextClaimId: () =>
          administrativeOperationClaimIdSchema.parse(
            `${identifierNamespace}administrative-claim-${(claimSequence += 1)}`,
          ),
        nextEventId: () =>
          `${identifierNamespace}administrative-event-${(eventSequence += 1)}`,
        nextOperationId: () =>
          administrativeOperationIdSchema.parse(
            `${identifierNamespace}administrative-operation-${(operationSequence += 1)}`,
          ),
        nextTaskId: () =>
          administrativeTaskIdSchema.parse(
            `${identifierNamespace}administrative-task-${(taskSequence += 1)}`,
          ),
      },
      now: currentTime,
      ...(options.operationLeaseMilliseconds === undefined
        ? {}
        : { operationLeaseMilliseconds: options.operationLeaseMilliseconds }),
      ...(options.planningDeadlineCallbacks === undefined
        ? {}
        : {
            planningDeadlineTimer: {
              arm(_deadline: AdministrativeTimestamp, onDeadline: () => void) {
                let armed = true;
                options.planningDeadlineCallbacks?.push(() => {
                  if (armed) onDeadline();
                });
                return () => {
                  armed = false;
                };
              },
            },
          }),
      ...(options.reconciliationCallbacks === undefined
        ? {}
        : {
            reconciliationScheduler: {
              schedule(
                at: AdministrativeTimestamp,
                reconcile: () => Promise<void>,
              ) {
                let scheduled = true;
                options.reconciliationSchedule?.push(at);
                options.reconciliationCallbacks?.push(async () => {
                  if (!scheduled) return;
                  scheduled = false;
                  await reconcile();
                });
                return () => {
                  scheduled = false;
                };
              },
            },
          }),
      store,
    });
  } catch (error) {
    await store.close();
    throw error;
  }
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
      getEvidenceRecord: (taskId) => {
        const administrativeTaskId = administrativeTaskIdSchema.safeParse(taskId);
        return administrativeTaskId.success
          ? runtime.getTask(administrativeTaskId.data)
          : Promise.resolve(undefined);
      },
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
          expectation: {
            expectedActiveRevision: input.expectedActiveRevision,
            expectedExecutionManifestFingerprint:
              input.expectedExecutionManifestFingerprint ??
              administrativeExecutionManifestFingerprint(executionManifest),
            expectedStateVersion: input.expectedStateVersion,
          },
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
      store.renewOperationClaim({
        claimId: administrativeOperationClaimIdSchema.parse(input.claimId),
        leaseExpiresAt: administrativeTimestampSchema.parse(
          input.leaseExpiresAt,
        ),
        operationId: administrativeOperationIdSchema.parse(input.operationId),
        renewedAt: administrativeTimestampSchema.parse(input.renewedAt),
      }),
    attemptPolicyActivation: (input) =>
      runtime.activatePolicy({
        expectation: {
          expectedActiveRevision: input.expectedActiveRevision,
          expectedExecutionManifestFingerprint:
            administrativeExecutionManifestFingerprint(executionManifest),
          expectedStateVersion: input.expectedStateVersion,
        },
        source: input.source,
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
    async readPolicyEvidencePage(input = {}) {
      const query = new URLSearchParams();
      if (input.beforeSequence !== undefined) {
        query.set("beforeSequence", String(input.beforeSequence));
      }
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=${scenarioSession}`,
        },
        method: "GET",
        url: `/api/administrative-autonomy/policy-evidence?${query.toString()}`,
      });
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
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
    readTask: (taskId) =>
      runtime.getTask(administrativeTaskIdSchema.parse(taskId)),
    readTaskByOperationId: (operationId) =>
      runtime.getTaskByOperationId(
        administrativeOperationIdSchema.parse(operationId),
      ),
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
          expectation: {
            expectedRevision: input.expectedRevision,
            expectedStateVersion: input.expectedStateVersion,
          },
        },
        url: "/api/administrative-autonomy/suspend",
      });
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
    async suspendPolicyState() {
      const policy = await runtime.getPolicyStatus();
      if (policy.status !== "active") {
        throw new Error("Administrative Autonomy is not active");
      }
      const suspended = await runtime.suspendPolicy({
        expectation: {
          expectedRevision: policy.revision,
          expectedStateVersion: policy.stateVersion,
        },
      });
      if (suspended.decision === "denied") {
        throw new Error("Administrative Suspension state changed concurrently");
      }
      return suspended.policy;
    },
  };
}

function createLivePatchProof(
  request: Extract<AdministrativeOperationRequest, { kind: "live-patch.apply" }>,
  armedAt: AdministrativeTimestamp,
  mutationStartedAt: AdministrativeTimestamp,
  rollbackDeadline: AdministrativeTimestamp,
): LivePatchMutationProof {
  return livePatchMutationProofSchema.parse({
    healthCheck: {
      kind: "registered-application-health",
      observedAt: armedAt,
      status: "healthy",
    },
    independentRollback: {
      armedBeforeMutation: true,
      armedAt,
      kind: "independent-live-patch-rollback",
      rollbackDeadline,
    },
    mutationStartedAt,
    reconciliation: {
      baseBranch: "registered-production-branch",
      kind: "captured-as-isolated-pull-request",
      observedAt: mutationStartedAt,
      productionMutationRetained: true,
      reconciledPatch: "accepted-live-patch-diff",
      registeredCodebaseId: request.target.registeredCodebaseId,
      state: "open",
      verifiedBy: "independent-reconciliation-observer",
    },
    verification: {
      kind: "independent-application-health-proof",
      observedAt: mutationStartedAt,
      status: "healthy",
    },
  });
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
        rollbackActivationImplementationDigest: String(4 + offset).repeat(64),
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
