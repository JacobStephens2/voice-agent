import {
  administrativeEvidenceEventSchema,
  administrativeExecutionManifestSchema,
  administrativeExecutionManifestFingerprint,
  administrativeOperationClaimIdSchema,
  administrativeOperationIdSchema,
  administrativeOperationResultSchema,
  administrativeRegisteredCodebaseSchema,
  administrativeTaskIdSchema,
  administrativeTaskTargetBinding,
  administrativeTaskTargetFingerprint,
  administrativeTimestampSchema,
  administrativeUnavailableExecutionManifest,
  delegationIdSchema,
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
  type AdministrativeTaskTarget,
  type AdministrativeTaskTargetRequestInput,
  type AdministrativeTimestamp,
  type LivePatchMutationProof,
  type LivePatchRollbackActivationRequest,
  type RegisteredCodebaseId,
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
    readonly target: AdministrativeTaskTargetRequestInput;
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
    | "failed"
    | "failed-verification"
    | "foreign-evidence"
    | "mismatched"
    | "mismatched-candidate"
    | "mismatched-publication"
    | "missing"
    | "terminated"
    | "traversal-delegation-id"
    | "traversal-evidence"
    | "valid";
  readonly livePatchProof: LivePatchMutationProof | undefined;
  readonly omitLivePatchReconciliation: boolean;
}

type ScenarioOperationRequestFor<
  Kind extends AdministrativeOperationRequest["kind"],
> = Extract<AdministrativeOperationRequest, { readonly kind: Kind }>;

type ScenarioOperationResultFor<
  Kind extends AdministrativeOperationRequest["kind"],
> = Extract<AdministrativeOperationResult, { readonly kind: Kind }>;

type ScenarioOperationResultHandler<
  Kind extends AdministrativeOperationRequest["kind"],
> = (
  request: ScenarioOperationRequestFor<Kind>,
  context: ScenarioOperationResultContext,
) => ScenarioOperationResultFor<Kind>;

type ScenarioOperationResultHandlerRegistry = {
  [Kind in AdministrativeOperationRequest["kind"]]:
    ScenarioOperationResultHandler<Kind>;
};

const scenarioOperationResultHandlers = {
  "delegated-worktree.change": (request, context) => {
    const terminalStatus =
      context.delegatedWorktreeProof === "terminated" ||
      context.delegatedWorktreeProof === "traversal-evidence"
        ? ("stopped" as const)
        : context.delegatedWorktreeProof === "failed" ||
            context.delegatedWorktreeProof === "foreign-evidence"
          ? ("failed" as const)
          : undefined;
    const result = {
      ...context.common,
      delegation: {
        branch:
          context.delegatedWorktreeProof === "mismatched"
            ? "administrative/untrusted-provider-branch"
            : request.delegation.worktree.branch,
        changedFiles:
          terminalStatus === undefined
            ? ["src/administrative-change.ts"]
            : ["src/preserved-administrative-work.ts"],
        commits: terminalStatus === undefined ? ["a".repeat(40)] : [],
        completedAt: context.common.completedAt,
        delegationId: delegationIdSchema.parse(
          request.delegation.brief.delegationId,
        ),
        failure:
          terminalStatus === "failed"
            ? {
                evidencePaths: [
                  context.delegatedWorktreeProof === "foreign-evidence"
                    ? "/var/lib/voice-agent-evidence/administrative-operation-foreign/failure.json"
                    : `/var/lib/voice-agent-evidence/${request.operationId}/restricted-runner-failure.json`,
                ],
                kind: "restricted-runner" as const,
                message: "The bounded Delegation was terminated.",
                name: "AdministrativeDelegationTerminated",
              }
            : null,
        risks:
          terminalStatus === undefined
            ? []
            : ["The preserved partial work requires human review."],
        status: terminalStatus ?? ("completed" as const),
        termination:
          terminalStatus === "stopped"
            ? {
                evidencePaths: [
                  context.delegatedWorktreeProof === "traversal-evidence"
                    ? `/var/lib/voice-agent-evidence/${request.operationId}/../foreign/stop.json`
                    : `/var/lib/voice-agent-evidence/${request.operationId}/stop.json`,
                ],
                kind: "owner-requested" as const,
                message: "The bounded Delegation was stopped by its owner.",
              }
            : null,
        verification: {
          automated:
            request.delegation.brief.acceptanceCriteria.automaticVerification.commands.map(
              (command) => ({
                command,
                outcome:
                  context.delegatedWorktreeProof === "failed-verification"
                    ? ("failed" as const)
                    : ("passed" as const),
                summary: `${command} completed in the restricted Delegated Worktree.`,
              }),
            ),
          candidate:
            terminalStatus !== undefined
              ? null
              : {
                  branch: request.delegation.worktree.branch,
                  commit:
                    context.delegatedWorktreeProof === "mismatched-candidate"
                      ? "b".repeat(40)
                      : "a".repeat(40),
                  worktreeId: request.delegation.worktree.id,
                },
        },
        worktree: {
          ...request.delegation.worktree,
          dirty: terminalStatus !== undefined,
          state: terminalStatus ?? ("completed" as const),
        },
      },
      kind: request.kind,
      publication:
        terminalStatus !== undefined
          ? {
              kind: "not-published" as const,
              productionMutation: false as const,
              reason:
                terminalStatus === "failed"
                  ? ("delegation-failed" as const)
                  : ("delegation-stopped" as const),
            }
          : request.publication.kind === "open-pull-request"
          ? {
              baseBranch: "registered-production-branch" as const,
              headBranch: request.delegation.worktree.branch,
              headCommit:
                context.delegatedWorktreeProof === "mismatched-publication"
                  ? "b".repeat(40)
                  : "a".repeat(40),
              kind: "isolated-pull-request-opened" as const,
              productionMutation: false as const,
              registeredCodebaseId: request.target.registeredCodebaseId,
              state: "open" as const,
              url: `https://github.com/${request.target.registeredCodebase.repository}/pull/83`,
            }
          : {
              branch: request.delegation.worktree.branch,
              headCommit:
                context.delegatedWorktreeProof === "mismatched-publication"
                  ? "b".repeat(40)
                  : "a".repeat(40),
              kind: "isolated-branch-prepared" as const,
              productionMutation: false as const,
            },
    };
    if (context.delegatedWorktreeProof === "missing") {
      const { delegation: _delegation, ...missingProof } = result;
      return missingProof as unknown as ScenarioOperationResultFor<"delegated-worktree.change">;
    }
    if (context.delegatedWorktreeProof === "traversal-delegation-id") {
      return {
        ...result,
        delegation: { ...result.delegation, delegationId: ".." },
      } as unknown as ScenarioOperationResultFor<"delegated-worktree.change">;
    }
    return result;
  },
  "live-patch.apply": (request, context) => {
    if (context.livePatchProof === undefined) {
      throw new Error("The scenario Live Patch proof is unavailable");
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
    } as unknown as ScenarioOperationResultFor<"live-patch.apply">;
  },
  "production.observe": (request, context) => {
    return {
      ...context.common,
      kind: request.kind,
      observation: {
        kind: "registered-application-health" as const,
        status: "healthy" as const,
      },
    };
  },
} satisfies ScenarioOperationResultHandlerRegistry;

function scenarioOperationResult(
  request: AdministrativeOperationRequest,
  context: ScenarioOperationResultContext,
): AdministrativeOperationResult {
  const handler = scenarioOperationResultHandlers[request.kind] as (
    correlatedRequest: AdministrativeOperationRequest,
    correlatedContext: ScenarioOperationResultContext,
  ) => AdministrativeOperationResult;
  return handler(request, context);
}

export async function createAdministrativeAutonomyScenario(options: {
  readonly beforeOperationEffect?: (
    request: AdministrativeOperationRequest,
  ) => Promise<void>;
  readonly beforeExecutorResultReturn?: () => Promise<void> | void;
  readonly beforeProviderPlanReturn?: (input: {
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly beforeRollbackActivationResultReturn?: () => Promise<void> | void;
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
  readonly operationCompletionEvidenceForgery?:
    | "details-kind"
    | "event-kind"
    | "occurred-at"
    | "operation-id"
    | "result";
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
  readonly loseFirstOperationSettlementResponse?: boolean;
  readonly now: string;
  readonly onOperationStart?: () => void;
  readonly onProviderPlanStart?: () => void;
  readonly onRollbackActivationStart?: () => void;
  readonly operationLeaseMilliseconds?: number;
  readonly operationAttempts?: string[];
  readonly operationCompletionReplay?: "exact" | "forged";
  readonly operationCompletionReplayOutcomes?: boolean[];
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
  readonly rollbackActivationAttemptDeadlines?: AdministrativeTimestamp[];
  readonly rollbackActivationDeadlineCallbacks?: Array<() => void>;
  readonly rollbackActivationEffects?: string[];
  readonly rollbackActivationFailures?: number;
  readonly rollbackActivationHangs?: number;
  readonly rollbackActivationLedger?: Set<string>;
  readonly rollbackActivationSignals?: AbortSignal[];
  readonly rollbackActivationResultTargetMutation?: (
    target: AdministrativeTaskTarget,
  ) => AdministrativeTaskTarget;
  readonly rollbackActivationTimeLedger?: Map<
    string,
    AdministrativeTimestamp
  >;
  readonly delegatedWorktreeProof?:
    | "failed"
    | "failed-verification"
    | "foreign-evidence"
    | "mismatched"
    | "mismatched-candidate"
    | "mismatched-publication"
    | "missing"
    | "terminated"
    | "traversal-delegation-id"
    | "traversal-evidence"
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
  let lostOperationSettlementResponse = false;
  let forgedOperationCompletionEvidence = false;
  let revisePolicyAfterFirstOperation = false;
  let revisePolicyBeforePlanAdmission = false;
  let providerFailuresRemaining = options.providerFailures ?? 0;
  let executorFailuresRemaining = options.executorFailures ?? 0;
  let rollbackActivationFailuresRemaining =
    options.rollbackActivationFailures ?? 0;
  let rollbackActivationHangsRemaining = options.rollbackActivationHangs ?? 0;
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
  const runtimeStore: ReturnType<
    typeof createSqliteAdministrativeAutonomyStore
  > = {
    ...store,
    ...(options.loseFirstOperationSettlementResponse === true
      ? {
          async settleClaimedOperationAndDenyTask(input) {
            const record = await store.settleClaimedOperationAndDenyTask(input);
            if (!lostOperationSettlementResponse) {
              lostOperationSettlementResponse = true;
              throw new Error(
                "Simulated process loss after atomic Operation settlement",
              );
            }
            return record;
          },
        }
      : {}),
    ...(options.operationCompletionEvidenceForgery !== undefined ||
    options.operationCompletionReplay !== undefined
      ? {
          async completeOperation(input) {
            if (
              input.completedEvent.kind !==
              "administrative.operation.completed"
            ) {
              throw new Error(
                "Administrative Operation completion requires completion evidence",
              );
            }
            const forgedResult = forgeAdministrativeOperationResult(
              input.result,
            );
            const submittedInput =
              options.operationCompletionEvidenceForgery !== undefined &&
              !forgedOperationCompletionEvidence
                ? {
                    ...input,
                    completedEvent: forgeAdministrativeCompletionEvent(
                      input.completedEvent,
                      forgedResult,
                      options.operationCompletionEvidenceForgery,
                    ),
                  }
                : input;
            forgedOperationCompletionEvidence = true;
            const record = await store.completeOperation(submittedInput);
            if (options.operationCompletionReplay !== undefined) {
              try {
                const replayResult =
                  options.operationCompletionReplay === "exact"
                    ? input.result
                    : forgedResult;
                await store.completeOperation({
                  ...input,
                  completedEvent: {
                    ...input.completedEvent,
                    details: {
                      ...input.completedEvent.details,
                      result: replayResult,
                    },
                  },
                  result: replayResult,
                });
                options.operationCompletionReplayOutcomes?.push(true);
              } catch {
                options.operationCompletionReplayOutcomes?.push(false);
              }
            }
            return record;
          },
        }
      : {}),
  };
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
      await options.beforeExecutorResultReturn?.();
      return scenarioOperationResult(request, {
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
    async activate(input: {
      readonly attemptDeadline: AdministrativeTimestamp;
      readonly request: LivePatchRollbackActivationRequest;
      readonly signal: AbortSignal;
    }) {
      const { attemptDeadline, request, signal } = input;
      options.rollbackActivationAttempts?.push(request);
      options.rollbackActivationAttemptDeadlines?.push(attemptDeadline);
      options.rollbackActivationSignals?.push(signal);
      options.onRollbackActivationStart?.();
      if (rollbackActivationHangsRemaining > 0) {
        rollbackActivationHangsRemaining -= 1;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("Simulated hanging rollback activation was aborted");
      }
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
      await options.beforeRollbackActivationResultReturn?.();
      const resultTarget =
        options.rollbackActivationResultTargetMutation?.(request.target) ??
        request.target;
      return livePatchRollbackActivationResultSchema.parse({
        activatedAt,
        kind: "live-patch-rollback-activated",
        operationId: request.operationId,
        outcome:
          existingActivation === undefined ? "activated" : "already-activated",
        productionMutationRetained: false,
        ...administrativeTaskTargetBinding(resultTarget),
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
              async findRegisteredCodebase(
                registeredCodebaseId: RegisteredCodebaseId,
              ) {
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
                  expiresAt:
                    options.registeredCodebaseExpiresAt ??
                    "2100-01-01T00:00:00.000Z",
                  initialProductionCommit: "1".repeat(40),
                  liveCheckoutPath: "/srv/voice-agent",
                  productionBranch: "main",
                  registeredAt: "1990-01-01T00:00:00.000Z",
                  registeredCodebaseId: "voice-agent",
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
      ...(options.rollbackActivationDeadlineCallbacks === undefined
        ? {}
        : {
            rollbackActivationDeadlineTimer: {
              arm(_deadline: AdministrativeTimestamp, onDeadline: () => void) {
                let armed = true;
                options.rollbackActivationDeadlineCallbacks?.push(() => {
                  if (armed) onDeadline();
                });
                return () => {
                  armed = false;
                };
              },
            },
          }),
      store: runtimeStore,
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
      targetFingerprint: administrativeTaskTargetFingerprint(request.target),
      verifiedBy: "independent-reconciliation-observer",
    },
    verification: {
      kind: "independent-application-health-proof",
      observedAt: mutationStartedAt,
      status: "healthy",
    },
  });
}

function forgeAdministrativeOperationResult(
  result: AdministrativeOperationResult,
): AdministrativeOperationResult {
  if (result.kind !== "live-patch.apply") return result;
  return administrativeOperationResultSchema.parse({
    ...result,
    mutationProof: {
      ...result.mutationProof,
      reconciliation: {
        ...result.mutationProof.reconciliation,
        targetFingerprint: "0".repeat(64),
      },
    },
  });
}

function forgeAdministrativeCompletionEvent(
  event: Extract<
    Parameters<
      ReturnType<
        typeof createSqliteAdministrativeAutonomyStore
      >["completeOperation"]
    >[0]["completedEvent"],
    { readonly kind: "administrative.operation.completed" }
  >,
  forgedResult: AdministrativeOperationResult,
  forgery:
    | "details-kind"
    | "event-kind"
    | "occurred-at"
    | "operation-id"
    | "result",
): Parameters<
  ReturnType<
    typeof createSqliteAdministrativeAutonomyStore
  >["completeOperation"]
>[0]["completedEvent"] {
  const changed =
    forgery === "event-kind"
      ? {
          ...event,
          details: {
            kind: event.details.kind,
            operationId: event.details.operationId,
            reason: "forged terminal state",
          },
          kind: "administrative.operation.failed",
        }
      : {
          ...event,
          details: {
            ...event.details,
            ...(forgery === "details-kind"
              ? { kind: "production.observe" }
              : {}),
            ...(forgery === "operation-id"
              ? {
                  operationId:
                    administrativeOperationIdSchema.parse("forged-operation"),
                }
              : {}),
            ...(forgery === "result" ? { result: forgedResult } : {}),
          },
          ...(forgery === "occurred-at"
            ? {
                occurredAt: administrativeTimestampSchema.parse(
                  "2099-01-01T00:00:00.000Z",
                ),
              }
            : {}),
        };
  const parsed = administrativeEvidenceEventSchema.parse({
    ...changed,
    sequence: 1,
  });
  if (
    parsed.kind !== "administrative.operation.completed" &&
    parsed.kind !== "administrative.operation.failed"
  ) {
    throw new Error("Unexpected forged Administrative Evidence Event kind");
  }
  const { sequence: _sequence, ...unsequenced } = parsed;
  return unsequenced;
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
