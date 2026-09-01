import { createHash } from "node:crypto";
import { posix as path } from "node:path";

import {
  administrativeActiveExecutionMilliseconds,
  administrativeAuthoritySnapshotSchema,
  administrativeExecutionManifestFingerprint,
  administrativeExecutionManifestSchema,
  administrativeOperationRequestSchema,
  administrativeOperationRecoveryResultSchema,
  administrativeOperationResultSchema,
  administrativeOperationClaimIdSchema,
  administrativeOperationExecutorIdentitySchema,
  administrativeOperationIdSchema,
  administrativePlanProviderIdentitySchema,
  administrativeProviderPlanSchema,
  administrativeIntendedStateSchema,
  administrativeRequestedOutcomeSchema,
  administrativeRegisteredCodebaseSchema,
  administrativeTimestampSchema,
  administrativeTaskIdSchema,
  administrativeTaskAuthoritySnapshot,
  administrativeTaskTargetBinding,
  administrativeTaskTargetSchema,
  administrativeTaskTargetRequestSchema,
  livePatchRollbackActivationRequestSchema,
  livePatchRollbackActivationResultSchema,
  livePatchRollbackActivationAttemptMilliseconds,
  isLivePatchMutationProofBoundToRequest,
  administrativeLivePatchRollbackActivatorIdentitySchema,
  livePatchRollbackWindowMilliseconds,
  sameAdministrativeExecutionManifest,
  sameAdministrativeRegisteredCodebase,
  sameAdministrativeTaskTargetBinding,
  sameGrokRunnerPin,
  validateAdministrativeDelegatedWorktreeResultBinding,
  type AdministrativeEvidenceRecord,
  type AdministrativeAutonomyStatus,
  type AdministrativeAuthoritySnapshot,
  type AdministrativeExecutionManifest,
  type AdministrativeOperationRequest,
  type AdministrativeOperationClaimId,
  type AdministrativeOperationId,
  type AdministrativeOperationResult,
  type AdministrativeOperationExecutorIdentity,
  type AdministrativePlanProviderIdentity,
  type AdministrativePolicyActivationExpectation,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyEvidencePage,
  type AdministrativePolicyEvidencePageRequest,
  type AdministrativePolicyStatus,
  type AdministrativePolicySuspensionExpectation,
  type AdministrativePublicationIntent,
  type AdministrativeRequestedOutcome,
  type AdministrativeRegisteredCodebase,
  type RegisteredCodebaseId,
  type AdministrativeTask,
  type AdministrativeTaskId,
  type AdministrativeTaskOutcome,
  type AdministrativeTaskTarget,
  type AdministrativeTaskTargetRequestInput,
  type AdministrativeTimestamp,
  type LivePatchRollbackActivationRequest,
  type AdministrativeLivePatchRollbackActivatorIdentity,
} from "@voice-agent/contracts";
import type {
  AdministrativeAutonomyStore,
  AdministrativeOperationClaim,
} from "@voice-agent/durable-store";
import {
  administrativeAutonomyPolicyDefinition,
  authorizeAdministrativePlan,
  authorizeAdministrativePolicyActivation,
  authorizeAdministrativeTaskConfirmation,
  canonicalAdministrativeIntent,
} from "@voice-agent/policy";

export interface AdministrativePlanProvider {
  /**
   * taskId is the durable planning idempotency key. A provider may receive the
   * same accepted task again after a transient failure or process restart.
   */
  choosePlan(input: {
    readonly activeExecutionDeadline: AdministrativeTimestamp;
    readonly outcome: AdministrativeTaskOutcome;
    readonly intendedState: string;
    readonly signal: AbortSignal;
    readonly target: AdministrativeTaskTarget;
    readonly taskId: AdministrativeTaskId;
  }): Promise<unknown>;
}

/** Trusted, composition-owned Registered Codebase lookup. */
export interface AdministrativeRegisteredCodebaseRegistry {
  findRegisteredCodebase(
    registeredCodebaseId: RegisteredCodebaseId,
  ): Promise<unknown>;
}

/** Composition-owned filesystem authority for trusted registration snapshots. */
export interface AdministrativeRegisteredCodebasePathAuthority {
  readonly allowedRoots: {
    readonly liveCheckoutPath: readonly string[];
    readonly sourceCheckoutRoot: readonly string[];
    readonly worktreeRoot: readonly string[];
  };
  readonly credentialCustodyBoundaryPaths: readonly string[];
  resolvePath(path: string): Promise<string>;
}

export interface AdministrativePlanningDeadlineTimer {
  arm(
    deadline: AdministrativeTimestamp,
    onDeadline: () => void,
  ): () => void;
}

export interface AdministrativeReconciliationScheduler {
  schedule(
    at: AdministrativeTimestamp,
    reconcile: () => Promise<void>,
  ): () => void;
}

export interface AdministrativeOperationExecutor {
  /**
   * The adapter must use request.operationId as its idempotency key, carry the
   * claim ID and deadline into its typed broker fence, and stop and settle
   * before performing any further effect when signal aborts. The real broker
   * adapter remains downstream; production exposes no executor until one can
   * honor this contract.
   */
  execute(
    execution: AdministrativeOperationExecution,
  ): Promise<AdministrativeOperationResult>;
  /**
   * Reads a result already durably owned by the idempotent broker without
   * exposing any effect-authority callback. This is the only path available
   * when a policy transition follows the effect but precedes settlement.
   */
  recoverCompletedResult(
    recovery: AdministrativeOperationRecovery,
  ): Promise<unknown>;
}

export interface AdministrativeLivePatchRollbackActivator {
  /**
   * operationId is the durable idempotency key. Repeating the same typed
   * request after failure or restart must return the already-activated result
   * without repeating an external effect.
   */
  activate(input: {
    readonly attemptDeadline: AdministrativeTimestamp;
    readonly attemptStartedAt: AdministrativeTimestamp;
    readonly request: LivePatchRollbackActivationRequest;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Deployment-owned trust anchor for the concrete implementations installed at
 * this composition boundary. Implementations never select their own authority
 * identity; the catalog binds an object reference to reviewed provenance.
 */
export interface AdministrativeImplementationCatalog {
  identifyExecutor(implementation: AdministrativeOperationExecutor): unknown;
  identifyProvider(implementation: AdministrativePlanProvider): unknown;
  identifyRollbackActivator(
    implementation: AdministrativeLivePatchRollbackActivator,
  ): unknown;
}

export interface AdministrativeOperationExecution {
  readonly fence: {
    readonly activeExecutionDeadline: AdministrativeTimestamp;
    readonly attemptStartedAt: AdministrativeTimestamp;
    readonly claimId: AdministrativeOperationClaimId;
    readonly initialExecutionStartedAt: AdministrativeTimestamp;
    readonly recovered: boolean;
    readonly armLivePatchRollback: (input: {
      readonly armedAt: AdministrativeTimestamp;
      readonly rollbackDeadline: AdministrativeTimestamp;
    }) => Promise<void>;
    /**
     * Called after the independent controller has extended the armed rollback
     * and immediately before mutation. The trusted runtime clock must equal
     * mutationStartedAt, and the new deadline must retain the full window.
     */
    readonly activateLivePatchRollbackWindow: (input: {
      readonly armedAt: AdministrativeTimestamp;
      readonly mutationStartedAt: AdministrativeTimestamp;
      readonly rollbackDeadline: AdministrativeTimestamp;
    }) => Promise<void>;
    readonly recheckEffectAuthority: () => Promise<void>;
    readonly signal: AbortSignal;
  };
  readonly request: AdministrativeOperationRequest;
}

export interface AdministrativeOperationRecovery {
  readonly fence: {
    readonly activeExecutionDeadline: AdministrativeTimestamp;
    readonly attemptStartedAt: AdministrativeTimestamp;
    readonly claimId: AdministrativeOperationClaimId;
    readonly initialExecutionStartedAt: AdministrativeTimestamp;
    readonly signal: AbortSignal;
  };
  readonly request: AdministrativeOperationRequest;
}

export interface AdministrativeIdentifiers {
  nextCapability(): string;
  nextClaimId(): AdministrativeOperationClaimId;
  nextEventId(): string;
  nextOperationId(): AdministrativeOperationId;
  nextTaskId(): AdministrativeTaskId;
}

type AdministrativeEffectFenceDenialReason =
  | "active-execution-deadline"
  | "claim-lost"
  | "execution-manifest"
  | "live-patch-rollback"
  | "registered-codebase"
  | "stale-policy";

class AdministrativeEffectFenceError extends Error {
  readonly reason: AdministrativeEffectFenceDenialReason;

  constructor(reason: AdministrativeEffectFenceDenialReason) {
    super(`Administrative effect fence denied: ${reason}`);
    this.reason = reason;
  }
}

class AdministrativePlanningDeadlineError extends Error {}

class AdministrativeRollbackActivationError extends Error {
  readonly reason: "implementation-mismatch" | "transient-failure";

  constructor(reason: "implementation-mismatch" | "transient-failure") {
    super(reason);
    this.reason = reason;
  }
}

export type AdministrativePolicyActivationResult =
  | {
      readonly decision: "activated";
      readonly policy: AdministrativePolicyStatus;
    }
  | { readonly decision: "denied"; readonly reason: string };

export type AdministrativePolicySuspensionResult =
  | {
      readonly decision: "suspended";
      readonly policy: AdministrativePolicyStatus;
    }
  | { readonly decision: "denied"; readonly reason: string };

export type AdministrativeTaskPreparationResult =
  | {
      readonly confirmationCapability: string;
      readonly decision: "prepared";
      readonly policyRevision: number;
      readonly stateVersion: number;
      readonly task: AdministrativeTask;
      readonly taskId: AdministrativeTaskId;
    }
  | { readonly decision: "denied"; readonly reason: string };

export type AdministrativeTaskAdmissionResult =
  | {
      readonly decision: "admitted";
      readonly policyRevision: number;
      readonly taskId: AdministrativeTaskId;
    }
  | { readonly decision: "denied"; readonly reason: string };

export interface AdministrativeAutonomyRuntime {
  applyEvidenceRetention(input: {
    readonly cutoff: AdministrativeTimestamp;
  }): Promise<void>;
  activatePolicy(input: {
    readonly expectation: AdministrativePolicyActivationExpectation;
    readonly source: AdministrativePolicyActivationSource;
  }): Promise<AdministrativePolicyActivationResult>;
  answerTaskConfirmation(input: {
    readonly confirmation: "ambiguous" | "confirmed" | "declined";
    readonly confirmationCapability: string;
    readonly ownerId: string;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeTaskAdmissionResult>;
  close(): Promise<void>;
  getPolicyStatus(): Promise<AdministrativePolicyStatus>;
  getPolicyEvidencePage(
    input: AdministrativePolicyEvidencePageRequest,
  ): Promise<AdministrativePolicyEvidencePage>;
  getStatus(): Promise<AdministrativeAutonomyStatus>;
  getTask(
    taskId: AdministrativeTaskId,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  getTaskByOperationId(
    operationId: AdministrativeOperationId,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  listTasks(): ReturnType<AdministrativeAutonomyStore["listTasks"]>;
  reconcileOperations(): Promise<void>;
  prepareTaskConfirmation(input: {
    readonly intendedState: string;
    readonly outcome: AdministrativeRequestedOutcome;
    readonly ownerId: string;
    readonly requestId: string;
    readonly target: AdministrativeTaskTargetRequestInput;
  }): Promise<AdministrativeTaskPreparationResult>;
  suspendPolicy(input: {
    readonly expectation: AdministrativePolicySuspensionExpectation;
  }): Promise<AdministrativePolicySuspensionResult>;
}

export function createAdministrativeAutonomyRuntime(options: {
  readonly executionManifest: AdministrativeExecutionManifest;
  readonly executor?: AdministrativeOperationExecutor;
  readonly identifiers: AdministrativeIdentifiers;
  readonly implementationCatalog?: AdministrativeImplementationCatalog;
  readonly now: () => string;
  readonly operationLeaseMilliseconds?: number;
  readonly planningDeadlineTimer?: AdministrativePlanningDeadlineTimer;
  readonly provider?: AdministrativePlanProvider;
  readonly reconciliationScheduler?: AdministrativeReconciliationScheduler;
  readonly registeredCodebases?: AdministrativeRegisteredCodebaseRegistry;
  readonly registeredCodebasePathAuthority?:
    AdministrativeRegisteredCodebasePathAuthority;
  readonly rollbackActivationDeadlineTimer?: AdministrativePlanningDeadlineTimer;
  readonly rollbackActivator?: AdministrativeLivePatchRollbackActivator;
  readonly store: AdministrativeAutonomyStore;
}): AdministrativeAutonomyRuntime {
  const executionManifest = administrativeExecutionManifestSchema.parse(
    options.executionManifest,
  );
  const trustedProviderIdentity = () => {
    if (options.provider === undefined || options.implementationCatalog === undefined) {
      return undefined;
    }
    try {
      const parsed = administrativePlanProviderIdentitySchema.safeParse(
        options.implementationCatalog.identifyProvider(options.provider),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const trustedExecutorIdentity = () => {
    if (options.executor === undefined || options.implementationCatalog === undefined) {
      return undefined;
    }
    try {
      const parsed = administrativeOperationExecutorIdentitySchema.safeParse(
        options.implementationCatalog.identifyExecutor(options.executor),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const trustedRollbackActivatorIdentity = () => {
    if (
      options.rollbackActivator === undefined ||
      options.implementationCatalog === undefined
    ) {
      return undefined;
    }
    try {
      const parsed =
        administrativeLivePatchRollbackActivatorIdentitySchema.safeParse(
          options.implementationCatalog.identifyRollbackActivator(
            options.rollbackActivator,
          ),
        );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const now = () => administrativeTimestampSchema.parse(options.now());
  const systemDeadlineTimer = {
    arm(deadline: AdministrativeTimestamp, onDeadline: () => void) {
      const timer = setTimeout(
        onDeadline,
        Math.max(0, new Date(deadline).getTime() - new Date(now()).getTime()),
      );
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
  const planningDeadlineTimer =
    options.planningDeadlineTimer ?? systemDeadlineTimer;
  const rollbackActivationDeadlineTimer =
    options.rollbackActivationDeadlineTimer ?? systemDeadlineTimer;
  const executionManifestPresent =
    options.provider !== undefined && options.executor !== undefined;
  const livePatchManifestPresent = executionManifest.operationAdapters.some(
    (implementation) => implementation.kind === "live-patch.apply",
  );
  if ((options.provider === undefined) !== (options.executor === undefined)) {
    throw new Error(
      "Administrative planning and execution implementations must be supplied together",
    );
  }
  if (
    executionManifestPresent !== (options.implementationCatalog !== undefined)
  ) {
    throw new Error(
      "Administrative execution requires a trusted implementation catalog",
    );
  }
  if (
    executionManifestPresent !== (options.registeredCodebases !== undefined)
  ) {
    throw new Error(
      "Administrative execution requires a trusted Registered Codebase registry",
    );
  }
  if (
    executionManifestPresent !==
    (options.registeredCodebasePathAuthority !== undefined)
  ) {
    throw new Error(
      "Administrative execution requires trusted Registered Codebase path authority",
    );
  }
  if (
    executionManifestPresent ===
    (executionManifest.provider.kind === "unavailable")
  ) {
    throw new Error(
      "Administrative execution implementations do not match the Administrative Execution Manifest",
    );
  }
  if (livePatchManifestPresent !== (options.rollbackActivator !== undefined)) {
    throw new Error(
      "The Live Patch rollback implementation does not match the Administrative Execution Manifest",
    );
  }
  if (
    !providerIdentityMatchesManifest(
      trustedProviderIdentity(),
      executionManifest,
    )
  ) {
    throw new Error(
      "Administrative provider implementation identity does not match the Administrative Execution Manifest",
    );
  }
  if (
    !executorIdentityMatchesManifest(
      trustedExecutorIdentity(),
      executionManifest,
    )
  ) {
    throw new Error(
      "Administrative Operation executor implementation identity does not match the Administrative Execution Manifest",
    );
  }
  if (
    !rollbackActivatorIdentityMatchesManifest(
      trustedRollbackActivatorIdentity(),
      executionManifest,
    )
  ) {
    throw new Error(
      "Administrative Live Patch rollback activator implementation identity does not match the Administrative Execution Manifest",
    );
  }
  const runtimeImplementationsMatchManifest = (
    manifest: AdministrativeExecutionManifest,
  ) =>
    providerIdentityMatchesManifest(trustedProviderIdentity(), manifest) &&
    executorIdentityMatchesManifest(trustedExecutorIdentity(), manifest) &&
    rollbackActivatorIdentityMatchesManifest(
      trustedRollbackActivatorIdentity(),
      manifest,
    );
  const requestedOperationLeaseMilliseconds =
    options.operationLeaseMilliseconds ?? 30_000;
  if (
    !Number.isSafeInteger(requestedOperationLeaseMilliseconds) ||
    requestedOperationLeaseMilliseconds <= 0
  ) {
    throw new Error("Administrative Operation lease duration is invalid");
  }
  const operationLeaseMilliseconds = Math.min(
    requestedOperationLeaseMilliseconds,
    administrativeActiveExecutionMilliseconds,
  );
  const reconciliationScheduler = options.reconciliationScheduler ?? {
    schedule(at: AdministrativeTimestamp, reconcile: () => Promise<void>) {
      const timer = setTimeout(
        () => void reconcile(),
        Math.max(0, new Date(at).getTime() - new Date(now()).getTime()),
      );
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
  let closed = false;
  let reconciliationPromise: Promise<void> | undefined;
  let reconciliationRequested = false;
  let cancelRetry: (() => void) | undefined;
  let retryAt: AdministrativeTimestamp | undefined;
  const inFlightExecutions = new Map<
    AdministrativeOperationId,
    { readonly abort: (reason: string) => void }
  >();

  async function findTrustedRegisteredCodebase(
    registeredCodebaseId: RegisteredCodebaseId,
    observedAt: AdministrativeTimestamp,
  ): Promise<AdministrativeRegisteredCodebase | undefined> {
    if (options.registeredCodebases === undefined) return undefined;
    try {
      const registration = administrativeRegisteredCodebaseSchema.parse(
        await options.registeredCodebases.findRegisteredCodebase(
          registeredCodebaseId,
        ),
      );
      return registration.registeredCodebaseId === registeredCodebaseId &&
        registration.registeredAt <= observedAt &&
        observedAt < registration.expiresAt &&
        (await registeredCodebasePathsAreAuthorized(registration))
        ? registration
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function registeredCodebasePathsAreAuthorized(
    registration: AdministrativeRegisteredCodebase,
  ): Promise<boolean> {
    const authority = options.registeredCodebasePathAuthority;
    if (authority === undefined) return false;
    const fields = [
      ["liveCheckoutPath", registration.liveCheckoutPath],
      ["sourceCheckoutRoot", registration.sourceCheckoutRoot],
      ["worktreeRoot", registration.worktreeRoot],
    ] as const;
    const custodyPaths = authority.credentialCustodyBoundaryPaths;
    if (
      custodyPaths.some(
        (custodyPath) => !isCanonicalAbsolutePath(custodyPath),
      )
    ) {
      return false;
    }
    const resolvedCustodyPaths = await Promise.all(
      custodyPaths.map((custodyPath) => authority.resolvePath(custodyPath)),
    );
    if (
      resolvedCustodyPaths.some(
        (custodyPath) => !isCanonicalAbsolutePath(custodyPath),
      )
    ) {
      return false;
    }
    for (const [field, registeredPath] of fields) {
      if (!isCanonicalAbsolutePath(registeredPath)) return false;
      const resolvedPath = await authority.resolvePath(registeredPath);
      if (!isCanonicalAbsolutePath(resolvedPath)) return false;
      if (
        custodyPaths.some((custodyPath, index) => {
          const resolvedCustodyPath = resolvedCustodyPaths[index];
          return (
            resolvedCustodyPath === undefined ||
            pathsOverlap(registeredPath, custodyPath) ||
            pathsOverlap(registeredPath, resolvedCustodyPath) ||
            pathsOverlap(resolvedPath, custodyPath) ||
            pathsOverlap(resolvedPath, resolvedCustodyPath)
          );
        })
      ) {
        return false;
      }
      const allowedRoots = authority.allowedRoots[field];
      if (allowedRoots.length === 0) return false;
      let withinAllowedRoot = false;
      for (const allowedRoot of allowedRoots) {
        if (!isCanonicalAbsolutePath(allowedRoot)) return false;
        const resolvedAllowedRoot = await authority.resolvePath(allowedRoot);
        if (!isCanonicalAbsolutePath(resolvedAllowedRoot)) return false;
        if (isWithinPath(resolvedPath, resolvedAllowedRoot)) {
          withinAllowedRoot = true;
        }
      }
      if (!withinAllowedRoot) return false;
    }
    return true;
  }

  async function requireCurrentRegisteredCodebase(
    target: AdministrativeTaskTarget,
    observedAt: AdministrativeTimestamp,
  ): Promise<void> {
    const current = await findTrustedRegisteredCodebase(
      target.registeredCodebaseId,
      observedAt,
    );
    if (
      current === undefined ||
      !sameAdministrativeRegisteredCodebase(
        current,
        target.registeredCodebase,
      )
    ) {
      throw new AdministrativeEffectFenceError("registered-codebase");
    }
  }

  async function denyPlannedTask(taskId: AdministrativeTaskId, reason: string) {
    const deniedAt = now();
    await options.store.denyTask({
      deniedAt,
      deniedEvent: {
        details: { reason },
        id: options.identifiers.nextEventId(),
        kind: "administrative.task.denied",
        occurredAt: deniedAt,
        summary: "The Administrative Task failed closed before execution.",
      },
      taskId,
    });
    return { decision: "denied" as const, reason };
  }

  async function denyClaimedOperation(
    claim: Extract<AdministrativeOperationClaim, { readonly decision: "claimed" }>,
    reason: string,
    result?: Extract<
      AdministrativeOperationResult,
      { readonly kind: "delegated-worktree.change" }
    >,
  ) {
    const deniedAt = now();
    const terminalStatus =
      result !== undefined && result.delegation.status !== "completed"
        ? result.delegation.status
        : undefined;
    await options.store.settleClaimedOperationAndDenyTask({
      claimId: claim.claimId,
      deniedAt,
      deniedEvent: {
        details: { reason },
        id: options.identifiers.nextEventId(),
        kind: "administrative.task.denied",
        occurredAt: deniedAt,
        summary: "The Administrative Task failed closed during execution.",
      },
      operationEvent:
        terminalStatus === undefined || result === undefined
          ? {
              details: {
                kind: claim.request.kind,
                operationId: claim.request.operationId,
                reason,
              },
              id: options.identifiers.nextEventId(),
              kind: "administrative.operation.failed",
              occurredAt: deniedAt,
              summary: `The ${claim.request.kind} Operation failed closed.`,
            }
          : {
              details: {
                kind: result.kind,
                operationId: result.operationId,
                result,
                terminalStatus,
              },
              id: options.identifiers.nextEventId(),
              kind: "administrative.operation.terminated",
              occurredAt: result.completedAt,
              summary: `The delegated Operation ${terminalStatus} with bounded evidence.`,
            },
      operationId: claim.request.operationId,
      operationStatus: terminalStatus ?? "failed",
      ...(result === undefined ? {} : { result }),
      taskId: claim.request.taskId,
    });
    return { decision: "denied" as const, reason };
  }

  function scheduleReconciliation(at: AdministrativeTimestamp): void {
    if (closed || (retryAt !== undefined && retryAt <= at)) return;
    cancelRetry?.();
    retryAt = at;
    cancelRetry = reconciliationScheduler.schedule(at, async () => {
      retryAt = undefined;
      cancelRetry = undefined;
      try {
        await reconcileOperations();
      } catch {
        const retryAfterControllerFailure = administrativeTimestampSchema.parse(
          new Date(new Date(now()).getTime() + 1_000).toISOString(),
        );
        scheduleReconciliation(retryAfterControllerFailure);
      }
    });
  }

  async function completeAdministrativeTask(
    taskId: AdministrativeTaskId,
  ): Promise<void> {
    const record = await options.store.findTask(taskId);
    if (record === undefined || record.task.status !== "running") return;
    const completedAt = now();
    await options.store.completeTask({
      completedAt,
      completedEvent: {
        details: { policyRevision: record.task.authority.policyRevision },
        id: options.identifiers.nextEventId(),
        kind: "administrative.task.completed",
        occurredAt: completedAt,
        summary: "The confirmed administrative plan completed.",
      },
      taskId,
    });
  }

  function maintainOperationClaim(input: {
    readonly activeExecutionDeadline: AdministrativeTimestamp;
    readonly claimId: AdministrativeOperationClaimId;
    readonly leaseExpiresAt: AdministrativeTimestamp;
    readonly operationId: AdministrativeOperationId;
    readonly settlementOnly: boolean;
  }): {
    readonly abort: (reason: string) => void;
    readonly lossReason: () => string | undefined;
    readonly signal: AbortSignal;
    readonly stop: () => void;
  } {
    const controller = new AbortController();
    let reason: string | undefined;
    let renewalInFlight = false;
    const abort = (lossReason: string) => {
      if (controller.signal.aborted) return;
      reason = lossReason;
      controller.abort(new Error(lossReason));
    };
    const claimDeadline = input.settlementOnly
      ? input.leaseExpiresAt
      : input.activeExecutionDeadline;
    const deadlineDelay = Math.max(
      0,
      new Date(claimDeadline).getTime() - new Date(now()).getTime(),
    );
    const deadline = setTimeout(() => {
      abort(
        input.settlementOnly
          ? "Administrative Operation settlement claim was lost"
          : "Administrative Task active-execution deadline elapsed",
      );
    }, deadlineDelay);
    deadline.unref?.();
    const renewal = input.settlementOnly ? undefined : setInterval(() => {
      if (renewalInFlight || controller.signal.aborted) return;
      renewalInFlight = true;
      const renewedAt = now();
      if (renewedAt >= input.activeExecutionDeadline) {
        abort("Administrative Task active-execution deadline elapsed");
        renewalInFlight = false;
        return;
      }
      void options.store
        .renewOperationClaim({
          claimId: input.claimId,
          leaseExpiresAt: boundedLeaseExpiry(
            renewedAt,
            input.activeExecutionDeadline,
            operationLeaseMilliseconds,
          ),
          operationId: input.operationId,
          renewedAt,
        })
        .then((renewed) => {
          if (!renewed) abort("Administrative Operation claim was lost");
        })
        .catch(() => {
          abort("Administrative Operation claim was lost");
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, operationLeaseMilliseconds / 3);
    renewal?.unref?.();
    return {
      abort,
      lossReason: () => reason,
      signal: controller.signal,
      stop() {
        clearTimeout(deadline);
        if (renewal !== undefined) clearInterval(renewal);
      },
    };
  }

  function abortInFlightExecutions(): void {
    for (const execution of inFlightExecutions.values()) {
      execution.abort("Administrative Suspension aborted in-flight execution");
    }
  }

  async function reconcileLivePatchRollbackActivations(
    policy: Extract<AdministrativePolicyStatus, { status: "suspended" }>,
  ): Promise<void> {
    const pendingActivations =
      await options.store.listPendingLivePatchRollbackActivations();
    for (const pending of pendingActivations) {
      const request = pending.request;
      const observedAt = now();
      if (pending.nextAttemptAt > observedAt) {
        scheduleReconciliation(pending.nextAttemptAt);
        continue;
      }
      const implementationMatches =
        options.rollbackActivator !== undefined &&
        rollbackActivatorIdentityMatchesManifest(
          trustedRollbackActivatorIdentity(),
          request.authority.executionManifest,
        );
      try {
        if (!implementationMatches || options.rollbackActivator === undefined) {
          throw new AdministrativeRollbackActivationError(
            "implementation-mismatch",
          );
        }
        const attemptStartedAt = now();
        const attemptDeadline = administrativeTimestampSchema.parse(
          new Date(
            new Date(attemptStartedAt).getTime() +
              livePatchRollbackActivationAttemptMilliseconds,
          ).toISOString(),
        );
        const attemptController = new AbortController();
        let rejectDeadline: ((error: Error) => void) | undefined;
        const deadlineElapsed = new Promise<never>((_resolve, reject) => {
          rejectDeadline = reject;
        });
        const cancelDeadline = rollbackActivationDeadlineTimer.arm(
          attemptDeadline,
          () => {
            rejectDeadline?.(
              new AdministrativeRollbackActivationError("transient-failure"),
            );
            attemptController.abort();
          },
        );
        let untrusted: unknown;
        try {
          untrusted = await Promise.race([
            options.rollbackActivator.activate({
              attemptDeadline,
              attemptStartedAt,
              request,
              signal: attemptController.signal,
            }),
            deadlineElapsed,
          ]);
        } finally {
          cancelDeadline();
        }
        const result = livePatchRollbackActivationResultSchema.parse(untrusted);
        const completedAt = now();
        if (
          completedAt >= attemptDeadline ||
          result.operationId !== request.operationId ||
          result.taskId !== request.taskId ||
          !sameAdministrativeTaskTargetBinding(result, request) ||
          result.activatedAt < policy.suspendedAt ||
          result.activatedAt > completedAt
        ) {
          throw new Error(
            "Live Patch rollback activation proof does not match its request",
          );
        }
        await options.store.completeLivePatchRollbackActivation({
          completedEvent: {
            details: { operationId: result.operationId, result },
            id: options.identifiers.nextEventId(),
            kind: "administrative.live-patch.rollback-activated",
            occurredAt: result.activatedAt,
            summary: "The armed Live Patch rollback was activated.",
          },
          result,
        });
      } catch (error) {
        const failedAt = now();
        const reason =
          error instanceof AdministrativeRollbackActivationError
            ? error.reason
            : "transient-failure";
        const delay = Math.min(
          60_000,
          1_000 * 2 ** Math.min(pending.attemptCount, 6),
        );
        const nextAttemptAt = administrativeTimestampSchema.parse(
          new Date(new Date(failedAt).getTime() + delay).toISOString(),
        );
        await options.store.recordLivePatchRollbackActivationFailure({
          failedAt,
          failureEvent: {
            details: {
              attemptCount: pending.attemptCount + 1,
              nextAttemptAt,
              operationId: request.operationId,
              reason,
            },
            id: options.identifiers.nextEventId(),
            kind: "administrative.live-patch.rollback-activation-failed",
            occurredAt: failedAt,
            summary: "The armed Live Patch rollback activation will retry.",
          },
          nextAttemptAt,
          operationId: request.operationId,
          reason,
        });
        scheduleReconciliation(nextAttemptAt);
      }
    }
  }

  async function planAdministrativeTask(
    task: AdministrativeTask,
  ): Promise<AdministrativeTaskAdmissionResult> {
    if (
      task.activeExecutionDeadline === null ||
      now() >= task.activeExecutionDeadline
    ) {
      return denyPlannedTask(
        task.id,
        "Administrative Task active-execution deadline elapsed",
      );
    }
    const policy = await options.store.findActivePolicy();
    if (
      policy === undefined ||
      policy.revision !== task.authority.policyRevision
    ) {
      return denyPlannedTask(
        task.id,
        "Administrative Autonomy policy state is stale",
      );
    }
    if (
      !sameAdministrativeExecutionManifest(
        policy.executionManifest,
        task.authority.executionManifest,
      ) ||
      !sameAdministrativeExecutionManifest(
        policy.executionManifest,
        executionManifest,
      ) ||
      !runtimeImplementationsMatchManifest(policy.executionManifest)
    ) {
      return denyPlannedTask(
        task.id,
        "The active policy revision does not authorize the configured execution manifest.",
      );
    }
    if (options.provider === undefined || options.executor === undefined) {
      return denyPlannedTask(task.id, "Administrative execution is unavailable");
    }
    try {
      await requireCurrentRegisteredCodebase(task.target, now());
    } catch {
      return denyPlannedTask(
        task.id,
        "The Registered Codebase registration is unavailable or stale",
      );
    }
    let untrustedPlan: unknown;
    const planning = new AbortController();
    let expirePlanning!: () => void;
    const planningExpired = new Promise<never>((_resolve, reject) => {
      expirePlanning = () => {
        planning.abort();
        reject(new AdministrativePlanningDeadlineError());
      };
    });
    const cancelPlanningDeadline = planningDeadlineTimer.arm(
      task.activeExecutionDeadline,
      expirePlanning,
    );
    try {
      untrustedPlan = await Promise.race([
        options.provider.choosePlan({
          activeExecutionDeadline: task.activeExecutionDeadline,
          intendedState: task.intendedState,
          outcome: task.outcome,
          signal: planning.signal,
          target: task.target,
          taskId: task.id,
        }),
        planningExpired,
      ]);
      if (now() >= task.activeExecutionDeadline) {
        planning.abort();
        return denyPlannedTask(
          task.id,
          "Administrative Task active-execution deadline elapsed",
        );
      }
    } catch (error) {
      if (
        error instanceof AdministrativePlanningDeadlineError ||
        now() >= task.activeExecutionDeadline
      ) {
        return denyPlannedTask(
          task.id,
          "Administrative Task active-execution deadline elapsed",
        );
      }
      scheduleReconciliation(
        boundedLeaseExpiry(
          now(),
          task.activeExecutionDeadline,
          operationLeaseMilliseconds,
        ),
      );
      return {
        decision: "admitted",
        policyRevision: task.authority.policyRevision,
        taskId: task.id,
      };
    } finally {
      cancelPlanningDeadline();
    }
    const parsedPlan = administrativeProviderPlanSchema.safeParse(untrustedPlan);
    if (!parsedPlan.success) {
      return denyPlannedTask(
        task.id,
        "Provider instructions did not describe a permitted typed Operation plan",
      );
    }
    const planAuthorization = authorizeAdministrativePlan({
      definition: policy.definition,
      outcome: task.outcome,
      plan: parsedPlan.data,
    });
    if (planAuthorization.decision === "deny") {
      return denyPlannedTask(task.id, planAuthorization.reason);
    }
    const unavailableKind = parsedPlan.data.find(
      (operation) =>
        !executionManifest.operationAdapters.some(
          (adapter) => adapter.kind === operation.kind,
        ),
    );
    if (unavailableKind !== undefined) {
      return denyPlannedTask(
        task.id,
        `${unavailableKind.kind} is not present in the activated execution manifest`,
      );
    }
    const plannedAt = now();
    const authority = administrativeTaskAuthoritySnapshot(task);
    const operations = parsedPlan.data.map((operation) => {
      const request = operationRequest({
        authority,
        intendedState: task.intendedState,
        kind: operation.kind,
        operationId: administrativeOperationIdSchema.parse(
          options.identifiers.nextOperationId(),
        ),
        publicationIntent: task.publicationIntent,
        target: task.target,
        taskId: task.id,
      });
      return {
        acceptedEvent: {
          details: {
            kind: request.kind,
            operationId: request.operationId,
            policyRevision: request.authority.policyRevision,
            stateVersion: request.authority.policyStateVersion,
          },
          id: options.identifiers.nextEventId(),
          kind: "administrative.operation.accepted" as const,
          occurredAt: plannedAt,
          summary: `The ${request.kind} Operation was accepted by policy.`,
        },
        request,
      };
    });
    const savedPlan = await options.store.savePlan({
      operations,
      planEvent: {
        details: {
          operations: parsedPlan.data.map((operation) => operation.kind),
          policyRevision: policy.revision,
          stateVersion: task.authority.policyStateVersion,
        },
        id: options.identifiers.nextEventId(),
        kind: "administrative.plan.accepted",
        occurredAt: plannedAt,
        summary: "The confirmed outcome admitted a bounded Operation plan.",
      },
      taskId: task.id,
    });
    if (savedPlan === undefined) {
      return denyPlannedTask(
        task.id,
        "Administrative Autonomy policy state is stale",
      );
    }
    return {
      decision: "admitted",
      policyRevision: task.authority.policyRevision,
      taskId: task.id,
    };
  }

  async function reconcileTask(
    taskId: AdministrativeTaskId,
    suppliedClaim?: Extract<
      AdministrativeOperationClaim,
      { readonly decision: "claimed" }
    >,
  ): Promise<boolean> {
    if (options.executor === undefined) return false;
    const record = await options.store.findTask(taskId);
    if (suppliedClaim === undefined && record?.task.status === "planning") {
      const admission = await planAdministrativeTask(record.task);
      if (admission.decision === "denied") return true;
      return (await options.store.findTask(taskId))?.task.status !== "planning";
    }
    if (record === undefined) return false;
    const claimedAt = now();
    const activeExecutionDeadline = record.task.activeExecutionDeadline;
    const claim =
      suppliedClaim ??
      (await options.store.claimNextOperation({
        authority: administrativeTaskAuthoritySnapshot(record.task),
        claimId: administrativeOperationClaimIdSchema.parse(
          options.identifiers.nextClaimId(),
        ),
        claimedAt,
        leaseExpiresAt:
          activeExecutionDeadline === null ||
          activeExecutionDeadline === undefined
            ? claimedAt
            : boundedLeaseExpiry(
                claimedAt,
                activeExecutionDeadline,
                operationLeaseMilliseconds,
              ),
        taskId,
      }));
    if (claim.decision === "deferred") {
      scheduleReconciliation(claim.retryAt);
      return false;
    }
    if (claim.decision === "denied") {
      await denyPlannedTask(
        taskId,
        claim.reason === "stale-policy"
          ? "Administrative Autonomy policy state is stale"
          : claim.reason === "execution-manifest"
            ? "The active policy revision does not authorize the configured execution manifest."
            : "Administrative Task active-execution deadline elapsed",
      );
      return true;
    }
    if (claim.decision === "empty") {
      await completeAdministrativeTask(taskId);
      return true;
    }
    if (
      !sameAdministrativeExecutionManifest(
        claim.request.authority.executionManifest,
        executionManifest,
      ) ||
      !runtimeImplementationsMatchManifest(
        claim.request.authority.executionManifest,
      )
    ) {
      if (claim.settlementOnly) {
        scheduleReconciliation(claim.leaseExpiresAt);
        return false;
      }
      await denyClaimedOperation(
        claim,
        "The active policy revision does not authorize the configured execution manifest.",
      );
      return true;
    }
    const claimMaintenance = maintainOperationClaim({
      activeExecutionDeadline: claim.activeExecutionDeadline,
      claimId: claim.claimId,
      leaseExpiresAt: claim.leaseExpiresAt,
      operationId: claim.request.operationId,
      settlementOnly: claim.settlementOnly,
    });
    inFlightExecutions.set(claim.request.operationId, claimMaintenance);
    try {
      let untrustedResult: unknown;
      let brokerRecoveredResult = false;
      const attemptStartedAt = now();
      const armLivePatchRollback = async (input: {
        readonly armedAt: AdministrativeTimestamp;
        readonly rollbackDeadline: AdministrativeTimestamp;
      }): Promise<void> => {
        if (claim.request.kind !== "live-patch.apply") {
          throw new Error("Only a Live Patch can arm its rollback");
        }
        const request = livePatchRollbackActivationRequestSchema.parse({
          ...input,
          authority: claim.request.authority,
          armedRollbackDeadline: input.rollbackDeadline,
          kind: "activate-armed-live-patch-rollback",
          mutationAuthorizedAt: null,
          operationId: claim.request.operationId,
          ...administrativeTaskTargetBinding(claim.request.target),
          taskId: claim.request.taskId,
        });
        if (
          new Date(request.rollbackDeadline).getTime() -
            new Date(request.armedAt).getTime() !==
            livePatchRollbackWindowMilliseconds ||
          request.armedAt < attemptStartedAt ||
          request.rollbackDeadline > claim.activeExecutionDeadline
        ) {
          throw new AdministrativeEffectFenceError("live-patch-rollback");
        }
        await requireCurrentRegisteredCodebase(request.target, request.armedAt);
        const armed = await options.store.armLivePatchRollback({
          claimId: claim.claimId,
          request,
        });
        if (!armed || claimMaintenance.signal.aborted) {
          const policy = await options.store.readPolicyStatus();
          throw new AdministrativeEffectFenceError(
            policy.status === "active" &&
              policy.revision === claim.request.authority.policyRevision &&
              policy.stateVersion ===
                claim.request.authority.policyStateVersion
              ? "claim-lost"
              : "stale-policy",
          );
        }
      };
      const activateLivePatchRollbackWindow = async (input: {
        readonly armedAt: AdministrativeTimestamp;
        readonly mutationStartedAt: AdministrativeTimestamp;
        readonly rollbackDeadline: AdministrativeTimestamp;
      }): Promise<void> => {
        if (claim.request.kind !== "live-patch.apply") {
          throw new Error("Only a Live Patch has a rollback window");
        }
        if (claimMaintenance.signal.aborted) {
          throw new Error("Administrative Operation effect was aborted");
        }
        const effectAt = now();
        await requireCurrentRegisteredCodebase(claim.request.target, effectAt);
        if (input.mutationStartedAt !== effectAt) {
          throw new AdministrativeEffectFenceError("live-patch-rollback");
        }
        const authority = await options.store.recheckOperationEffect({
          authority: claim.request.authority,
          claimId: claim.claimId,
          effectAt,
          livePatchRollbackWindow: input,
          operationId: claim.request.operationId,
          taskId: claim.request.taskId,
        });
        if (authority.decision === "denied") {
          throw new AdministrativeEffectFenceError(authority.reason);
        }
        if (claimMaintenance.signal.aborted) {
          throw new AdministrativeEffectFenceError("claim-lost");
        }
      };
      const recheckEffectAuthority = async (): Promise<void> => {
        if (claim.request.kind === "live-patch.apply") {
          throw new AdministrativeEffectFenceError("live-patch-rollback");
        }
        if (claimMaintenance.signal.aborted) {
          throw new Error("Administrative Operation effect was aborted");
        }
        const effectAt = now();
        await requireCurrentRegisteredCodebase(claim.request.target, effectAt);
        const authority = await options.store.recheckOperationEffect({
          authority: claim.request.authority,
          claimId: claim.claimId,
          effectAt,
          operationId: claim.request.operationId,
          taskId: claim.request.taskId,
        });
        if (authority.decision === "denied") {
          throw new AdministrativeEffectFenceError(authority.reason);
        }
        if (claimMaintenance.signal.aborted) {
          throw new AdministrativeEffectFenceError("claim-lost");
        }
      };
      try {
        if (claim.recovered) {
          const recovered = administrativeOperationRecoveryResultSchema.parse(
            await options.executor.recoverCompletedResult({
              fence: {
                activeExecutionDeadline: claim.activeExecutionDeadline,
                attemptStartedAt,
                claimId: claim.claimId,
                initialExecutionStartedAt: claim.initialExecutionStartedAt,
                signal: claimMaintenance.signal,
              },
              request: claim.request,
            }),
          );
          if (recovered.decision === "completed") {
            untrustedResult = recovered.result;
            brokerRecoveredResult = true;
          } else if (claim.settlementOnly) {
            const policy = await options.store.readPolicyStatus();
            if (policy.status === "suspended") {
              scheduleReconciliation(claim.leaseExpiresAt);
              return false;
            }
            await denyClaimedOperation(
              claim,
              "Administrative Autonomy policy state is stale",
            );
            return true;
          }
        }
        if (untrustedResult === undefined) {
          try {
            await requireCurrentRegisteredCodebase(claim.request.target, now());
          } catch {
            throw new AdministrativeEffectFenceError("registered-codebase");
          }
          untrustedResult = await options.executor.execute({
            fence: {
              activeExecutionDeadline: claim.activeExecutionDeadline,
              activateLivePatchRollbackWindow,
              armLivePatchRollback,
              attemptStartedAt,
              claimId: claim.claimId,
              initialExecutionStartedAt: claim.initialExecutionStartedAt,
              recovered: claim.recovered,
              recheckEffectAuthority,
              signal: claimMaintenance.signal,
            },
            request: claim.request,
          });
        }
      } catch (error) {
        const lossReason = claimMaintenance.lossReason();
        if (lossReason !== undefined) {
          if (lossReason.startsWith("Administrative Suspension")) return false;
          await denyClaimedOperation(claim, lossReason);
          return true;
        }
        if (error instanceof AdministrativeEffectFenceError) {
          const reason =
            error.reason === "live-patch-rollback"
              ? "Administrative executor returned incomplete or mismatched bounded proof"
              : error.reason === "registered-codebase"
                ? "The Registered Codebase registration is unavailable or stale"
              : error.reason === "active-execution-deadline"
                ? "Administrative Task active-execution deadline elapsed"
              : error.reason === "stale-policy" ||
                  error.reason === "execution-manifest"
                ? "Administrative Autonomy policy state is stale"
                : "Administrative Operation claim was lost";
          await denyClaimedOperation(claim, reason);
          return true;
        }
        if (claim.settlementOnly) {
          scheduleReconciliation(claim.leaseExpiresAt);
          return false;
        }
        if (now() >= claim.activeExecutionDeadline) {
          await denyClaimedOperation(
            claim,
            "Administrative Task active-execution deadline elapsed",
          );
          return true;
        }
        scheduleReconciliation(
          boundedLeaseExpiry(
            claimedAt,
            claim.activeExecutionDeadline,
            operationLeaseMilliseconds,
          ),
        );
        return false;
      }
      const settledAt = now();
      let result: AdministrativeOperationResult;
      try {
        const reportedResult = administrativeOperationResultSchema.parse(
          untrustedResult,
        );
        result = operationResult(
          claim.request,
          reportedResult,
          {
            attemptStartedAt: brokerRecoveredResult
              ? claim.initialExecutionStartedAt
              : attemptStartedAt,
            initialExecutionStartedAt: claim.initialExecutionStartedAt,
            recovered: brokerRecoveredResult
              ? reportedResult.effect.kind === "idempotent-effect-replay"
              : claim.recovered,
          },
          brokerRecoveredResult ? reportedResult.completedAt : settledAt,
        );
      } catch {
        await denyClaimedOperation(
          claim,
          "Administrative executor returned incomplete or mismatched bounded proof",
        );
        return true;
      }
      if (result.completedAt >= claim.activeExecutionDeadline) {
        await denyClaimedOperation(
          claim,
          "Administrative Task active-execution deadline elapsed",
        );
        return true;
      }
      try {
        if (
          result.kind === "delegated-worktree.change" &&
          result.delegation.status !== "completed"
        ) {
          await denyClaimedOperation(
            claim,
            `Administrative Delegation ${result.delegation.status}.`,
            result,
          );
          return true;
        }
        await options.store.completeOperation({
          claimId: claim.claimId,
          completedEvent: {
            details: {
              kind: claim.request.kind,
              operationId: claim.request.operationId,
              result,
            },
            id: options.identifiers.nextEventId(),
            kind: "administrative.operation.completed",
            occurredAt: result.completedAt,
            summary: `The ${claim.request.kind} Operation completed.`,
          },
          operationId: claim.request.operationId,
          result,
          settledAt,
          taskId,
        });
        return true;
      } catch {
        scheduleReconciliation(claim.leaseExpiresAt);
        return false;
      }
    } finally {
      if (inFlightExecutions.get(claim.request.operationId) === claimMaintenance) {
        inFlightExecutions.delete(claim.request.operationId);
      }
      claimMaintenance.stop();
    }
  }

  async function reconcileCompletedOperationSettlement(
    taskId: AdministrativeTaskId,
    policy: AdministrativePolicyStatus,
  ): Promise<boolean> {
    if (options.executor === undefined) return false;
    const record = await options.store.findTask(taskId);
    if (record?.task.status !== "running") return false;
    const task = record.task;
    const claimedAt = now();
    if (!taskRequiresResultSettlement(task, policy, claimedAt)) {
      return false;
    }
    const leaseExpiresAt = administrativeTimestampSchema.parse(
      new Date(
        new Date(claimedAt).getTime() + operationLeaseMilliseconds,
      ).toISOString(),
    );
    const claim = await options.store.claimOperationSettlement({
      claimId: administrativeOperationClaimIdSchema.parse(
        options.identifiers.nextClaimId(),
      ),
      claimedAt,
      leaseExpiresAt,
      taskId,
    });
    if (claim.decision === "deferred") {
      scheduleReconciliation(claim.retryAt);
      return false;
    }
    if (claim.decision !== "claimed") {
      if (claim.decision !== "empty") return false;
      if (await options.store.allOperationsCompleted(taskId)) {
        await completeAdministrativeTask(taskId);
        return true;
      }
      if (policy.status === "active") {
        await denyPlannedTask(
          taskId,
          claimedAt >= (task.activeExecutionDeadline ?? claimedAt)
            ? "Administrative Task active-execution deadline elapsed"
            : "Administrative Autonomy policy state is stale",
        );
        return true;
      }
      return false;
    }
    const progressed = await reconcileTask(taskId, claim);
    const updated = await options.store.findTask(taskId);
    if (updated?.task.status !== "running") return progressed;
    if (await options.store.allOperationsCompleted(taskId)) {
      await completeAdministrativeTask(taskId);
      return true;
    }
    if (progressed && policy.status === "active") {
      await denyPlannedTask(
        taskId,
        claimedAt >= (task.activeExecutionDeadline ?? claimedAt)
          ? "Administrative Task active-execution deadline elapsed"
          : "Administrative Autonomy policy state is stale",
      );
      return true;
    }
    return progressed;
  }

  function taskRequiresResultSettlement(
    task: AdministrativeTask,
    policy: AdministrativePolicyStatus,
    at: AdministrativeTimestamp,
  ): boolean {
    return (
      task.status === "running" &&
      (task.activeExecutionDeadline === null ||
        at >= task.activeExecutionDeadline ||
        policy.status !== "active" ||
        policy.revision !== task.authority.policyRevision ||
        policy.stateVersion !== task.authority.policyStateVersion ||
        !sameAdministrativeExecutionManifest(
          policy.executionManifest,
          task.authority.executionManifest,
        ))
    );
  }

  async function reconcileOperations(): Promise<void> {
    if (closed) return;
    reconciliationRequested = true;
    if (reconciliationPromise !== undefined) return reconciliationPromise;
    reconciliationPromise = (async () => {
      let progressed: boolean;
      do {
        reconciliationRequested = false;
        const policy = await options.store.readPolicyStatus();
        if (policy.status === "suspended") {
          abortInFlightExecutions();
          await reconcileLivePatchRollbackActivations(policy);
          if (options.executor !== undefined) {
            const taskIds = await options.store.listRecoverableTaskIds();
            await Promise.all(
              taskIds.map((taskId) =>
                reconcileCompletedOperationSettlement(taskId, policy),
              ),
            );
          }
          return;
        }
        if (options.executor === undefined) return;
        const taskIds = await options.store.listRecoverableTaskIds();
        const taskRecords = await Promise.all(
          taskIds.map((taskId) => options.store.findTask(taskId)),
        );
        const settlementTaskIds = taskIds.filter((_taskId, index) => {
          const task = taskRecords[index]?.task;
          return task === undefined
            ? false
            : taskRequiresResultSettlement(task, policy, now());
        });
        const executableTaskIds = taskIds.filter(
          (taskId) => !settlementTaskIds.includes(taskId),
        );
        const settlementResults = await Promise.all(
          settlementTaskIds.map((taskId) =>
            reconcileCompletedOperationSettlement(taskId, policy),
          ),
        );
        const results = await Promise.all(
          executableTaskIds.map((taskId) => reconcileTask(taskId)),
        );
        progressed =
          settlementResults.some(Boolean) || results.some(Boolean);
      } while (reconciliationRequested || progressed);
    })();
    try {
      await reconciliationPromise;
    } finally {
      reconciliationPromise = undefined;
    }
    if (reconciliationRequested) await reconcileOperations();
  }

  return {
    applyEvidenceRetention: (input) => options.store.applyEvidenceRetention(input),
    async activatePolicy(input) {
      let current = await options.store.readPolicyStatus();
      if (
        current.status === "suspended" &&
        current.rollbackActivations.pendingOperationCount > 0
      ) {
        await reconcileLivePatchRollbackActivations(current);
        current = await options.store.readPolicyStatus();
        if (
          current.status === "suspended" &&
          current.rollbackActivations.pendingOperationCount > 0
        ) {
          return {
            decision: "denied",
            reason:
              "Administrative Suspension has pending Live Patch rollback activation",
          };
        }
      }
      const authorization = authorizeAdministrativePolicyActivation({
        current,
        expectation: input.expectation,
        runtimeExecutionManifestFingerprint:
          administrativeExecutionManifestFingerprint(executionManifest),
        source: input.source,
      });
      if (authorization.decision === "deny") {
        return { decision: "denied", reason: authorization.reason };
      }
      const revision =
        current.status === "inactive" ? 1 : current.revision + 1;
      const activatedAt = now();
      const activated = await options.store.activatePolicy({
        expectation: input.expectation,
        revision: {
          activatedAt,
          activatedBy: "fresh-passkey-action",
          definition: administrativeAutonomyPolicyDefinition,
          executionManifest,
          revision,
        },
        stateVersion: current.stateVersion + 1,
      });
      if (activated !== undefined && "decision" in activated) {
        return {
          decision: "denied" as const,
          reason:
            "Administrative Autonomy has unresolved Live Patch rollback windows",
        };
      }
      return activated === undefined
        ? {
            decision: "denied",
            reason: "Administrative Autonomy policy state is stale",
          }
        : { decision: "activated", policy: activated };
    },
    async answerTaskConfirmation(input) {
      if (input.confirmation === "declined") {
        const declinedAt = now();
        const declined = await options.store.declineConfirmation({
          capabilityHash: hashCapability(input.confirmationCapability),
          declinedAt,
          declinedEvent: {
            details: { reason: "Task Confirmation was declined" },
            id: options.identifiers.nextEventId(),
            kind: "administrative.confirmation.declined",
            occurredAt: declinedAt,
            summary: "The owner declined the intended administrative state.",
          },
          ownerId: input.ownerId,
          taskId: input.taskId,
        });
        return declined.decision === "denied"
          ? { decision: "denied", reason: describeClaimDenial(declined.reason) }
          : { decision: "denied", reason: "Task Confirmation was declined" };
      }
      const confirmation = authorizeAdministrativeTaskConfirmation({
        confirmation: input.confirmation,
      });
      if (confirmation.decision === "deny") {
        return { decision: "denied", reason: confirmation.reason };
      }
      const acceptedAt = now();
      const activeExecutionDeadline = administrativeTimestampSchema.parse(
        new Date(
          new Date(acceptedAt).getTime() +
            administrativeActiveExecutionMilliseconds,
        ).toISOString(),
      );
      const claim = await options.store.claimConfirmation({
        acceptedAt,
        acceptedEvent: {
          details: {
            activeExecutionDeadline,
            policyRevision:
              (await options.store.findTask(input.taskId))?.task
                .authority.policyRevision ?? 1,
          },
          id: options.identifiers.nextEventId(),
          kind: "administrative.confirmation.accepted",
          occurredAt: acceptedAt,
          summary: "The owner confirmed the Administrative Task outcome.",
        },
        capabilityHash: hashCapability(input.confirmationCapability),
        ownerId: input.ownerId,
        taskId: input.taskId,
      });
      if (claim.decision === "denied") {
        return { decision: "denied", reason: describeClaimDenial(claim.reason) };
      }
      const task = claim.record.task;
      const admission = await planAdministrativeTask(task);
      if (admission.decision === "denied") return admission;
      if ((await options.store.findTask(task.id))?.task.status === "planning") {
        return admission;
      }
      await reconcileOperations();
      const reconciled = await options.store.findTask(task.id);
      if (reconciled?.task.status === "denied") {
        return {
          decision: "denied",
          reason: reconciled.task.conclusion,
        };
      }
      return {
        decision: "admitted",
        policyRevision: task.authority.policyRevision,
        taskId: task.id,
      };
    },
    async close() {
      closed = true;
      cancelRetry?.();
      await options.store.close();
    },
    getPolicyStatus: () => options.store.readPolicyStatus(),
    getPolicyEvidencePage: (input) =>
      options.store.readPolicyEvidencePage(input),
    async getStatus() {
      const [policy, policyEvidence] = await Promise.all([
        options.store.readPolicyStatus(),
        options.store.readPolicyEvidence(),
      ]);
      const manifestMismatch =
        policy.status !== "inactive" &&
        (!sameAdministrativeExecutionManifest(
          policy.executionManifest,
          executionManifest,
        ) || !runtimeImplementationsMatchManifest(policy.executionManifest));
      return {
        policy,
        policyEvidence,
        taskExecution: manifestMismatch
          ? {
              activeExecutionManifest: policy.executionManifest,
              reason:
                "The active policy revision does not authorize the configured execution manifest.",
              runtimeExecutionManifest: executionManifest,
              status: "activation-required",
            }
          : executionManifestPresent
            ? { executionManifest, status: "execution-manifest-present" }
            : {
                executionManifest,
                reason:
                  "An executable Administrative Execution Manifest is not present.",
                status: "unavailable",
              },
      };
    },
    getTask: (taskId) => options.store.findTask(taskId),
    getTaskByOperationId: (operationId) =>
      options.store.findTaskByOperationId(operationId),
    listTasks: () => options.store.listTasks(),
    reconcileOperations,
    async prepareTaskConfirmation(input) {
      if (options.provider === undefined || options.executor === undefined) {
        return {
          decision: "denied",
          reason:
            "An executable Administrative Execution Manifest is not present.",
        };
      }
      const requestedOutcome = administrativeRequestedOutcomeSchema.parse(
        input.outcome,
      );
      const { outcome, publicationIntent } =
        canonicalAdministrativeIntent(requestedOutcome);
      const intendedState = administrativeIntendedStateSchema.parse(
        input.intendedState,
      );
      const targetRequest = administrativeTaskTargetRequestSchema.parse(
        input.target,
      );
      const policy = await options.store.readPolicyStatus();
      if (policy.status !== "active") {
        return {
          decision: "denied",
          reason: "Administrative Autonomy is not active",
        };
      }
      if (
        !sameAdministrativeExecutionManifest(
          policy.executionManifest,
          executionManifest,
        ) ||
        !runtimeImplementationsMatchManifest(policy.executionManifest)
      ) {
        return {
          decision: "denied",
          reason:
            "The active policy revision does not authorize the configured execution manifest.",
        };
      }
      const taskId = administrativeTaskIdSchema.parse(
        options.identifiers.nextTaskId(),
      );
      const confirmationCapability = options.identifiers.nextCapability();
      const preparedAt = now();
      const registeredCodebase = await findTrustedRegisteredCodebase(
        targetRequest.registeredCodebaseId,
        preparedAt,
      );
      if (registeredCodebase === undefined) {
        return {
          decision: "denied",
          reason: "The Registered Codebase is unavailable or not current",
        };
      }
      const target = administrativeTaskTargetSchema.parse({
        ...targetRequest,
        registeredCodebase,
      });
      const authority = administrativeAuthoritySnapshotSchema.parse({
        executionManifest,
        policyRevision: policy.revision,
        policyStateVersion: policy.stateVersion,
      });
      const saved = await options.store.savePreparedTask({
        capabilityHash: hashCapability(confirmationCapability),
        event: {
          details: {
            intendedState,
            outcome,
            publicationIntent,
            policyRevision: policy.revision,
            requestId: input.requestId,
            stateVersion: policy.stateVersion,
          },
          id: options.identifiers.nextEventId(),
          kind: "administrative.confirmation.prepared",
          occurredAt: preparedAt,
          summary: "A Task Confirmation was prepared for administrative work.",
        },
        ownerId: input.ownerId,
        requestId: input.requestId,
        task: {
          activeExecutionDeadline: null,
          conclusion: "Administrative Task confirmation is pending.",
          createdAt: preparedAt,
          id: taskId,
          intendedState,
          kind: "administrative.work",
          outcome,
          authority,
          publicationIntent,
          question: confirmationQuestion(
            intendedState,
            outcome,
            publicationIntent,
            target,
          ),
          status: "awaiting-confirmation",
          target,
          updatedAt: preparedAt,
        },
      });
      return saved === undefined
        ? {
            decision: "denied",
            reason: "Administrative confirmation is stale or replayed",
          }
        : {
            confirmationCapability,
            decision: "prepared",
            policyRevision: policy.revision,
            stateVersion: policy.stateVersion,
            task: saved.task,
            taskId,
          };
    },
    async suspendPolicy(input) {
      const suspendedAt = now();
      const suspended = await options.store.suspendPolicy({
        expectation: input.expectation,
        suspendedAt,
        suspensionEvent: {
          details: {
            policyRevision: input.expectation.expectedRevision,
            resultingStateVersion:
              input.expectation.expectedStateVersion + 1,
          },
          id: options.identifiers.nextEventId(),
          kind: "administrative.policy.suspended",
          occurredAt: suspendedAt,
          summary: "Administrative Autonomy was suspended.",
        },
      });
      if (suspended === undefined) {
        return {
          decision: "denied",
          reason: "Administrative Autonomy policy state is stale",
        };
      }
      if (suspended.status !== "suspended") {
        throw new Error("Administrative Suspension did not persist");
      }
      abortInFlightExecutions();
      await reconcileLivePatchRollbackActivations(suspended);
      const reconciled = await options.store.readPolicyStatus();
      if (reconciled.status !== "suspended") {
        throw new Error("Administrative Suspension changed concurrently");
      }
      return { decision: "suspended", policy: reconciled };
    },
  };
}

function providerIdentityMatchesManifest(
  identity: AdministrativePlanProviderIdentity | undefined,
  manifest: AdministrativeExecutionManifest,
): boolean {
  if (manifest.provider.kind === "unavailable") return identity === undefined;
  if (identity?.kind !== manifest.provider.kind) return false;
  if (identity.kind === "scenario-fake") {
    return (
      manifest.provider.kind === "scenario-fake" &&
      identity.implementationDigest === manifest.provider.implementationDigest
    );
  }
  return (
    manifest.provider.kind === "grok-build" &&
    identity.enrollmentCampaignId ===
      manifest.provider.enrollmentCampaignId &&
    sameGrokRunnerPin(identity.runnerPin, manifest.provider.runnerPin)
  );
}

function executorIdentityMatchesManifest(
  identity: AdministrativeOperationExecutorIdentity | undefined,
  manifest: AdministrativeExecutionManifest,
): boolean {
  if (manifest.provider.kind === "unavailable") return identity === undefined;
  if (
    identity === undefined ||
    identity.operationAdapters.length !== manifest.operationAdapters.length
  ) {
    return false;
  }
  return manifest.operationAdapters.every((expected) =>
    identity.operationAdapters.some(
      (actual) =>
        actual.kind === expected.kind &&
        actual.implementationDigest === expected.implementationDigest,
    ),
  );
}

function rollbackActivatorIdentityMatchesManifest(
  identity: AdministrativeLivePatchRollbackActivatorIdentity | undefined,
  manifest: AdministrativeExecutionManifest,
): boolean {
  const expected = manifest.operationAdapters.find(
    (implementation) => implementation.kind === "live-patch.apply",
  );
  return expected === undefined
    ? identity === undefined
    : identity?.kind === "live-patch.apply" &&
        identity.implementationDigest ===
          expected.rollbackActivationImplementationDigest;
}

function hashCapability(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

function boundedLeaseExpiry(
  claimedAt: AdministrativeTimestamp,
  activeExecutionDeadline: AdministrativeTimestamp,
  leaseMilliseconds: number,
): AdministrativeTimestamp {
  const requested = new Date(claimedAt).getTime() + leaseMilliseconds;
  return administrativeTimestampSchema.parse(
    new Date(
      Math.min(requested, new Date(activeExecutionDeadline).getTime()),
    ).toISOString(),
  );
}

function confirmationQuestion(
  intendedState: string,
  outcome: AdministrativeTaskOutcome,
  publicationIntent: AdministrativePublicationIntent,
  target: AdministrativeTaskTarget,
): string {
  const subject = `${target.registeredCodebaseId} in ${target.environment}`;
  if (outcome === "investigation") {
    return `Confirm observing ${subject} to establish this intended state: ${intendedState}`;
  }
  if (outcome === "proposal") {
    return publicationIntent === "open-pull-request"
      ? `Confirm isolated branch work and opening a pull request for ${subject} toward this intended state: ${intendedState}`
      : `Confirm branch-only work for ${subject} toward this intended state: ${intendedState}`;
  }
  return `Confirm changing ${subject} to this intended state: ${intendedState}`;
}

interface AdministrativeOperationRequestInput<
  Kind extends AdministrativeOperationRequest["kind"] =
    AdministrativeOperationRequest["kind"],
> {
  readonly authority: AdministrativeAuthoritySnapshot;
  readonly intendedState: string;
  readonly kind: Kind;
  readonly operationId: AdministrativeOperationId;
  readonly publicationIntent: AdministrativePublicationIntent;
  readonly target: AdministrativeTaskTarget;
  readonly taskId: AdministrativeTaskId;
}

interface AdministrativeOperationResultValidation {
  readonly completed: number;
  readonly effectStarted: number;
  readonly initialExecutionStarted: number;
  readonly reportedCompletedAt: AdministrativeTimestamp;
}

type AdministrativeOperationRequestFor<
  Kind extends AdministrativeOperationRequest["kind"],
> = Extract<AdministrativeOperationRequest, { readonly kind: Kind }>;

type AdministrativeOperationResultFor<
  Kind extends AdministrativeOperationRequest["kind"],
> = Extract<AdministrativeOperationResult, { readonly kind: Kind }>;

interface AdministrativeOperationHandler<
  Kind extends AdministrativeOperationRequest["kind"],
> {
  buildRequest(
    input: AdministrativeOperationRequestInput<Kind>,
  ): AdministrativeOperationRequestFor<Kind>;
  validateResult(
    request: AdministrativeOperationRequestFor<Kind>,
    result: AdministrativeOperationResultFor<Kind>,
    timing: AdministrativeOperationResultValidation,
  ): void;
}

type AdministrativeOperationHandlerRegistry = {
  [Kind in AdministrativeOperationRequest["kind"]]:
    AdministrativeOperationHandler<Kind>;
};

const administrativeOperationHandlers = {
  "delegated-worktree.change": {
    buildRequest(input) {
      const branch = `administrative/${input.operationId}`;
      return parseAdministrativeOperationRequest("delegated-worktree.change", {
        ...operationRequestCommon(input),
        change: confirmedIntendedState(input.intendedState),
        delegation: {
          brief: {
            acceptanceCriteria: {
              automaticVerification: {
                commands: input.target.registeredCodebase.verificationCommands,
                kind: "registered-codebase-verification",
              },
              intendedState: {
                intendedState: input.intendedState,
                kind: "confirmed-intended-state",
                targetSource: "confirmed-durable-task",
              },
            },
            authorizedCapabilities: [
              "registered-source.read",
              "delegated-worktree.write",
              "verification.run",
              "verified-candidate.prepare",
              ...(input.publicationIntent === "open-pull-request"
                ? (["verified-candidate.publish"] as const)
                : []),
            ],
            boundedContext: {
              editableScope: "registered-codebase",
              rawVoiceTranscriptIncluded: false,
              repositoryContentTrust: "untrusted-data-only",
              source: "confirmed-durable-task-and-registration",
            },
            constraints: [
              "delegated-worktree-only",
              "production-mutation-forbidden",
              "production-ref-mutation-forbidden",
              "human-merge-required",
            ],
            delegationId: input.operationId,
            goal: confirmedIntendedState(input.intendedState),
            registeredCodebase: input.target.registeredCodebase,
          },
          worktree: {
            baseCommit: input.target.registeredCodebase.initialProductionCommit,
            branch,
            dirty: false,
            id: input.operationId,
            path: `${input.target.registeredCodebase.worktreeRoot}/${input.operationId}`,
            state: "queued",
          },
        },
        kind: input.kind,
        publication:
          input.publicationIntent === "open-pull-request"
            ? {
                baseBranch: "registered-production-branch",
                kind: "open-pull-request",
                productionMutation: false,
              }
            : { kind: "branch-only", productionMutation: false },
      });
    },
    validateResult: validateAdministrativeDelegatedWorktreeResultBinding,
  },
  "live-patch.apply": {
    buildRequest(input) {
      return parseAdministrativeOperationRequest("live-patch.apply", {
        ...operationRequestCommon(input),
        kind: input.kind,
        mutationBoundary: {
          healthCheck: {
            kind: "registered-application-health",
            requiredBeforeMutation: true,
          },
          independentRollback: {
            armedBeforeMutation: true,
            kind: "independent-live-patch-rollback",
            rollbackWindowMilliseconds: livePatchRollbackWindowMilliseconds,
          },
          reconciliation: {
            acceptedOutcomes: [
              "captured-as-isolated-pull-request",
              "removed-from-production",
            ],
            kind: "live-patch-reconciliation",
            requiredBeforeTaskCompletion: true,
          },
          verification: {
            kind: "independent-application-health-proof",
            requiredAfterMutation: true,
          },
        },
        patch: confirmedIntendedState(input.intendedState),
      });
    },
    validateResult: validateLivePatchResult,
  },
  "production.observe": {
    buildRequest(input) {
      return parseAdministrativeOperationRequest("production.observe", {
        ...operationRequestCommon(input),
        kind: input.kind,
        observation: {
          intendedState: input.intendedState,
          kind: "registered-application-health",
          targetSource: "confirmed-durable-task",
        },
      });
    },
    validateResult: validateObservationResult,
  },
} satisfies AdministrativeOperationHandlerRegistry;

function parseAdministrativeOperationRequest<
  Kind extends AdministrativeOperationRequest["kind"],
>(kind: Kind, input: unknown): AdministrativeOperationRequestFor<Kind> {
  const parsed = administrativeOperationRequestSchema.parse(input);
  if (parsed.kind !== kind) {
    throw new Error("Administrative Operation request handler was cross-wired");
  }
  return parsed as AdministrativeOperationRequestFor<Kind>;
}

function operationRequestCommon(input: AdministrativeOperationRequestInput) {
  return {
    authority: administrativeAuthoritySnapshotSchema.parse(input.authority),
    operationId: input.operationId,
    target: input.target,
    taskId: input.taskId,
  };
}

function confirmedIntendedState(intendedState: string) {
  return {
    intendedState,
    kind: "achieve-confirmed-intended-state" as const,
    targetSource: "confirmed-durable-task" as const,
  };
}

function isCanonicalAbsolutePath(candidate: string): boolean {
  return (
    candidate !== "/" &&
    path.isAbsolute(candidate) &&
    path.normalize(candidate) === candidate
  );
}

function isWithinPath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithinPath(left, right) || isWithinPath(right, left);
}

function operationRequest(
  input: AdministrativeOperationRequestInput,
): AdministrativeOperationRequest {
  const buildRequest = administrativeOperationHandlers[input.kind]
    .buildRequest as (
      correlatedInput: AdministrativeOperationRequestInput,
    ) => AdministrativeOperationRequest;
  return buildRequest(input);
}

function operationResult(
  request: AdministrativeOperationRequest,
  untrustedResult: unknown,
  execution: {
    readonly attemptStartedAt: AdministrativeTimestamp;
    readonly initialExecutionStartedAt: AdministrativeTimestamp;
    readonly recovered: boolean;
  },
  completedAt: AdministrativeTimestamp,
): AdministrativeOperationResult {
  const untrusted = administrativeOperationResultSchema.parse(untrustedResult);
  const result = administrativeOperationResultSchema.parse({
    ...untrusted,
    completedAt,
  });
  if (result.kind !== request.kind || result.operationId !== request.operationId) {
    throw new Error(
      "Administrative Operation result identity does not match its request",
    );
  }
  const attemptStarted = new Date(execution.attemptStartedAt).getTime();
  const initialExecutionStarted = new Date(
    execution.initialExecutionStartedAt,
  ).getTime();
  const completed = new Date(result.completedAt).getTime();
  const effectStarted =
    result.effect.kind === "effect-performed"
      ? new Date(result.effect.startedAt).getTime()
      : new Date(result.effect.originallyStartedAt).getTime();
  if (
    effectStarted < initialExecutionStarted ||
    effectStarted > completed ||
    (result.effect.kind === "effect-performed" &&
      effectStarted < attemptStarted) ||
    (result.effect.kind === "idempotent-effect-replay" &&
      (!execution.recovered ||
        effectStarted > attemptStarted ||
        new Date(result.effect.replayedAt).getTime() < attemptStarted ||
        new Date(result.effect.replayedAt).getTime() > completed))
  ) {
    throw new Error("Administrative idempotency proof is not valid");
  }
  validateAdministrativeOperationKindResult(request, result, {
    completed,
    effectStarted,
    initialExecutionStarted,
    reportedCompletedAt: untrusted.completedAt,
  });
  return result;
}

function validateAdministrativeOperationKindResult(
  request: AdministrativeOperationRequest,
  result: AdministrativeOperationResult,
  timing: AdministrativeOperationResultValidation,
): void {
  if (result.kind !== request.kind) {
    throw new Error("Administrative Result does not match its Operation kind");
  }
  const validateResult = administrativeOperationHandlers[request.kind]
    .validateResult as (
      correlatedRequest: AdministrativeOperationRequest,
      correlatedResult: AdministrativeOperationResult,
      correlatedTiming: AdministrativeOperationResultValidation,
    ) => void;
  validateResult(request, result, timing);
}

function validateObservationResult(
  _request: AdministrativeOperationRequestFor<"production.observe">,
  _result: AdministrativeOperationResultFor<"production.observe">,
  _timing: AdministrativeOperationResultValidation,
): void {
}

function validateLivePatchResult(
  request: AdministrativeOperationRequestFor<"live-patch.apply">,
  result: AdministrativeOperationResultFor<"live-patch.apply">,
  timing: AdministrativeOperationResultValidation,
): void {
  const proof = result.mutationProof;
  const healthObserved = new Date(proof.healthCheck.observedAt).getTime();
  const rollbackArmed = new Date(proof.independentRollback.armedAt).getTime();
  const rollbackDeadline = new Date(
    proof.independentRollback.rollbackDeadline,
  ).getTime();
  const mutationStarted = new Date(proof.mutationStartedAt).getTime();
  const verificationObserved = new Date(
    proof.verification.observedAt,
  ).getTime();
  const reconciliationObserved = new Date(
    proof.reconciliation.observedAt,
  ).getTime();
  if (
    healthObserved < timing.initialExecutionStarted ||
    healthObserved > rollbackArmed ||
    rollbackArmed > mutationStarted ||
    rollbackDeadline - mutationStarted !==
      request.mutationBoundary.independentRollback.rollbackWindowMilliseconds ||
    mutationStarted !== timing.effectStarted ||
    mutationStarted >= rollbackDeadline ||
    mutationStarted > verificationObserved ||
    verificationObserved > reconciliationObserved ||
    reconciliationObserved > timing.completed ||
    timing.completed >= rollbackDeadline ||
    !isLivePatchMutationProofBoundToRequest(request, result)
  ) {
    throw new Error("Live Patch safety proof is not in a valid time order");
  }
}

function describeClaimDenial(
  reason:
    | "confirmation-replayed"
    | "identity-mismatch"
    | "invalid-capability"
    | "stale-policy"
    | "task-unavailable",
): string {
  switch (reason) {
    case "confirmation-replayed":
      return "Task Confirmation capability was already used";
    case "identity-mismatch":
      return "Task Confirmation belongs to another owner identity";
    case "invalid-capability":
      return "Task Confirmation capability is invalid";
    case "stale-policy":
      return "Administrative Autonomy policy state is stale";
    case "task-unavailable":
      return "Administrative Task is unavailable";
  }
}
