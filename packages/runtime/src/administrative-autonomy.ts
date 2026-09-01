import { createHash } from "node:crypto";

import {
  administrativeActiveExecutionMilliseconds,
  administrativeAuthoritySnapshotSchema,
  administrativeExecutionManifestFingerprint,
  administrativeExecutionManifestSchema,
  administrativeOperationRequestSchema,
  administrativeOperationResultSchema,
  administrativeOperationClaimIdSchema,
  administrativeOperationExecutorIdentitySchema,
  administrativeOperationIdSchema,
  administrativePlanProviderIdentitySchema,
  administrativeProviderPlanSchema,
  administrativeIntendedStateSchema,
  administrativeRequestedOutcomeSchema,
  administrativeTimestampSchema,
  administrativeTaskIdSchema,
  administrativeTaskTargetSchema,
  livePatchRollbackActivationRequestSchema,
  livePatchRollbackActivationResultSchema,
  administrativeLivePatchRollbackActivatorIdentitySchema,
  livePatchRollbackWindowMilliseconds,
  sameAdministrativeExecutionManifest,
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
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativePublicationIntent,
  type AdministrativeRequestedOutcome,
  type AdministrativeTask,
  type AdministrativeTaskId,
  type AdministrativeTaskOutcome,
  type AdministrativeTaskTarget,
  type AdministrativeTimestamp,
  type LivePatchRollbackActivationRequest,
  type AdministrativeLivePatchRollbackActivatorIdentity,
} from "@voice-agent/contracts";
import type { AdministrativeAutonomyStore } from "@voice-agent/durable-store";
import {
  administrativeAutonomyPolicyDefinition,
  authorizeAdministrativePlan,
  authorizeAdministrativePolicyActivation,
  authorizeAdministrativeTaskConfirmation,
  canonicalAdministrativeIntent,
} from "@voice-agent/policy";

export interface AdministrativePlanProvider {
  readonly identity: AdministrativePlanProviderIdentity;
  /**
   * taskId is the durable planning idempotency key. A provider may receive the
   * same accepted task again after a transient failure or process restart.
   */
  choosePlan(input: {
    readonly outcome: AdministrativeTaskOutcome;
    readonly intendedState: string;
    readonly target: AdministrativeTaskTarget;
    readonly taskId: AdministrativeTaskId;
  }): Promise<unknown>;
}

export interface AdministrativeOperationExecutor {
  readonly identity: AdministrativeOperationExecutorIdentity;
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
}

export interface AdministrativeLivePatchRollbackActivator {
  readonly identity: AdministrativeLivePatchRollbackActivatorIdentity;
  /**
   * operationId is the durable idempotency key. Repeating the same typed
   * request after failure or restart must return the already-activated result
   * without repeating an external effect.
   */
  activate(request: LivePatchRollbackActivationRequest): Promise<unknown>;
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
  | "stale-policy";

class AdministrativeEffectFenceError extends Error {
  readonly reason: AdministrativeEffectFenceDenialReason;

  constructor(reason: AdministrativeEffectFenceDenialReason) {
    super(`Administrative effect fence denied: ${reason}`);
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
    readonly expectedActiveRevision: number | null;
    readonly expectedExecutionManifestFingerprint: string;
    readonly expectedStateVersion: number;
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
    readonly target: AdministrativeTaskTarget;
  }): Promise<AdministrativeTaskPreparationResult>;
  suspendPolicy(input: {
    readonly expectedRevision: number;
    readonly expectedStateVersion: number;
  }): Promise<AdministrativePolicySuspensionResult>;
}

export function createAdministrativeAutonomyRuntime(options: {
  readonly executionManifest: AdministrativeExecutionManifest;
  readonly executor?: AdministrativeOperationExecutor;
  readonly identifiers: AdministrativeIdentifiers;
  readonly now: () => string;
  readonly operationLeaseMilliseconds?: number;
  readonly provider?: AdministrativePlanProvider;
  readonly rollbackActivator?: AdministrativeLivePatchRollbackActivator;
  readonly store: AdministrativeAutonomyStore;
}): AdministrativeAutonomyRuntime {
  const executionManifest = administrativeExecutionManifestSchema.parse(
    options.executionManifest,
  );
  const providerIdentity =
    options.provider === undefined
      ? undefined
      : administrativePlanProviderIdentitySchema.parse(options.provider.identity);
  const executorIdentity =
    options.executor === undefined
      ? undefined
      : administrativeOperationExecutorIdentitySchema.parse(
          options.executor.identity,
        );
  const rollbackActivatorIdentity =
    options.rollbackActivator === undefined
      ? undefined
      : administrativeLivePatchRollbackActivatorIdentitySchema.parse(
          options.rollbackActivator.identity,
        );
  const now = () => administrativeTimestampSchema.parse(options.now());
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
  if (!providerIdentityMatchesManifest(providerIdentity, executionManifest)) {
    throw new Error(
      "Administrative provider implementation identity does not match the Administrative Execution Manifest",
    );
  }
  if (!executorIdentityMatchesManifest(executorIdentity, executionManifest)) {
    throw new Error(
      "Administrative Operation executor implementation identity does not match the Administrative Execution Manifest",
    );
  }
  if (
    !rollbackActivatorIdentityMatchesManifest(
      rollbackActivatorIdentity,
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
    providerIdentityMatchesManifest(providerIdentity, manifest) &&
    executorIdentityMatchesManifest(executorIdentity, manifest) &&
    rollbackActivatorIdentityMatchesManifest(
      rollbackActivatorIdentity,
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
  let closed = false;
  let reconciliationPromise: Promise<void> | undefined;
  let reconciliationRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAt: AdministrativeTimestamp | undefined;
  const inFlightExecutions = new Map<
    AdministrativeOperationId,
    { readonly abort: (reason: string) => void }
  >();

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

  function scheduleReconciliation(at: AdministrativeTimestamp): void {
    if (closed || (retryAt !== undefined && retryAt <= at)) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryAt = at;
    const delay = Math.max(
      0,
      new Date(at).getTime() - new Date(now()).getTime(),
    );
    retryTimer = setTimeout(() => {
      retryAt = undefined;
      retryTimer = undefined;
      void reconcileOperations();
    }, delay);
    retryTimer.unref?.();
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
        details: { policyRevision: record.task.policyRevision },
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
    readonly operationId: AdministrativeOperationId;
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
    const deadlineDelay = Math.max(
      0,
      new Date(input.activeExecutionDeadline).getTime() -
        new Date(now()).getTime(),
    );
    const deadline = setTimeout(() => {
      abort("Administrative Task active-execution deadline elapsed");
    }, deadlineDelay);
    deadline.unref?.();
    const renewal = setInterval(() => {
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
    renewal.unref?.();
    return {
      abort,
      lossReason: () => reason,
      signal: controller.signal,
      stop() {
        clearTimeout(deadline);
        clearInterval(renewal);
      },
    };
  }

  function abortInFlightExecutions(): void {
    for (const execution of inFlightExecutions.values()) {
      execution.abort("Administrative Suspension aborted in-flight execution");
    }
  }

  async function reconcileLivePatchRollbackActivations(
    suspendedAt: AdministrativeTimestamp,
  ): Promise<void> {
    if (options.rollbackActivator === undefined) return;
    const requests =
      await options.store.listPendingLivePatchRollbackActivations();
    for (const request of requests) {
      try {
        const untrusted = await options.rollbackActivator.activate(request);
        const result = livePatchRollbackActivationResultSchema.parse(untrusted);
        const observedAt = now();
        if (
          result.operationId !== request.operationId ||
          result.taskId !== request.taskId ||
          result.target.environment !== request.target.environment ||
          result.target.registeredCodebaseId !==
            request.target.registeredCodebaseId ||
          result.activatedAt < suspendedAt ||
          result.activatedAt > observedAt
        ) {
          throw new Error(
            "Live Patch rollback activation proof does not match its request",
          );
        }
        await options.store.completeLivePatchRollbackActivation({ result });
      } catch {
        // Administrative Suspension is already durable. A failed independent
        // activator stays pending for the next retry or process restart.
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
    if (policy === undefined || policy.revision !== task.policyRevision) {
      return denyPlannedTask(
        task.id,
        "Administrative Autonomy policy state is stale",
      );
    }
    if (
      !sameAdministrativeExecutionManifest(
        policy.executionManifest,
        task.executionManifest,
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
    let untrustedPlan: unknown;
    try {
      untrustedPlan = await options.provider.choosePlan({
        intendedState: task.intendedState,
        outcome: task.outcome,
        target: task.target,
        taskId: task.id,
      });
    } catch {
      scheduleReconciliation(
        boundedLeaseExpiry(
          now(),
          task.activeExecutionDeadline,
          operationLeaseMilliseconds,
        ),
      );
      return {
        decision: "admitted",
        policyRevision: task.policyRevision,
        taskId: task.id,
      };
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
    const authority = administrativeAuthoritySnapshotSchema.parse({
      executionManifest,
      policyRevision: policy.revision,
      policyStateVersion: task.policyStateVersion,
    });
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
          stateVersion: task.policyStateVersion,
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
      policyRevision: task.policyRevision,
      taskId: task.id,
    };
  }

  async function reconcileTask(taskId: AdministrativeTaskId): Promise<boolean> {
    if (options.executor === undefined) return false;
    const record = await options.store.findTask(taskId);
    if (record?.task.status === "planning") {
      const admission = await planAdministrativeTask(record.task);
      if (admission.decision === "denied") return true;
      return (await options.store.findTask(taskId))?.task.status !== "planning";
    }
    if (record === undefined) return false;
    const claimedAt = now();
    const activeExecutionDeadline = record.task.activeExecutionDeadline;
    const claim = await options.store.claimNextOperation({
      authority: administrativeAuthoritySnapshotSchema.parse({
        executionManifest,
        policyRevision: record.task.policyRevision,
        policyStateVersion: record.task.policyStateVersion,
      }),
      claimId: administrativeOperationClaimIdSchema.parse(
        options.identifiers.nextClaimId(),
      ),
      claimedAt,
      leaseExpiresAt:
        activeExecutionDeadline === null || activeExecutionDeadline === undefined
          ? claimedAt
          : boundedLeaseExpiry(
              claimedAt,
              activeExecutionDeadline,
              operationLeaseMilliseconds,
            ),
      taskId,
    });
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
      await denyPlannedTask(
        taskId,
        "The active policy revision does not authorize the configured execution manifest.",
      );
      return true;
    }
    const claimMaintenance = maintainOperationClaim({
      activeExecutionDeadline: claim.activeExecutionDeadline,
      claimId: claim.claimId,
      operationId: claim.request.operationId,
    });
    inFlightExecutions.set(claim.request.operationId, claimMaintenance);
    try {
      let untrustedResult: unknown;
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
          armedRollbackDeadline: input.rollbackDeadline,
          kind: "activate-armed-live-patch-rollback",
          mutationAuthorizedAt: null,
          operationId: claim.request.operationId,
          target: claim.request.target,
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
        const authority = await options.store.recheckOperationEffect({
          authority: claim.request.authority,
          claimId: claim.claimId,
          effectAt: now(),
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
      } catch (error) {
        const lossReason = claimMaintenance.lossReason();
        if (lossReason !== undefined) {
          if (lossReason.startsWith("Administrative Suspension")) return false;
          await denyPlannedTask(taskId, lossReason);
          return true;
        }
        if (error instanceof AdministrativeEffectFenceError) {
          const reason =
            error.reason === "live-patch-rollback"
              ? "Administrative executor returned incomplete or mismatched bounded proof"
              : error.reason === "active-execution-deadline"
                ? "Administrative Task active-execution deadline elapsed"
              : error.reason === "stale-policy" ||
                  error.reason === "execution-manifest"
                ? "Administrative Autonomy policy state is stale"
                : "Administrative Operation claim was lost";
          await denyPlannedTask(taskId, reason);
          return true;
        }
        if (now() >= claim.activeExecutionDeadline) {
          await denyPlannedTask(
            taskId,
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
      const lossReason = claimMaintenance.lossReason();
      if (lossReason !== undefined) {
        await denyPlannedTask(taskId, lossReason);
        return true;
      }
      const completedAt = now();
      if (completedAt >= claim.activeExecutionDeadline) {
        await denyPlannedTask(
          taskId,
          "Administrative Task active-execution deadline elapsed",
        );
        return true;
      }
      let result: AdministrativeOperationResult;
      try {
        result = operationResult(
          claim.request,
          untrustedResult,
          {
            attemptStartedAt,
            initialExecutionStartedAt: claim.initialExecutionStartedAt,
            recovered: claim.recovered,
          },
          completedAt,
        );
      } catch {
        await denyPlannedTask(
          taskId,
          "Administrative executor returned incomplete or mismatched bounded proof",
        );
        return true;
      }
      try {
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
          taskId,
        });
        return true;
      } catch {
        const policy = await options.store.readPolicyStatus();
        if (policy.status === "suspended") return false;
        if (
          policy.status !== "active" ||
          policy.revision !== claim.request.authority.policyRevision ||
          policy.stateVersion !==
            claim.request.authority.policyStateVersion ||
          !sameAdministrativeExecutionManifest(
            policy.executionManifest,
            claim.request.authority.executionManifest,
          )
        ) {
          await denyPlannedTask(
            taskId,
            "Administrative Autonomy policy state is stale",
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
    } finally {
      if (inFlightExecutions.get(claim.request.operationId) === claimMaintenance) {
        inFlightExecutions.delete(claim.request.operationId);
      }
      claimMaintenance.stop();
    }
  }

  async function reconcileOperations(): Promise<void> {
    if (closed || options.executor === undefined) return;
    reconciliationRequested = true;
    if (reconciliationPromise !== undefined) return reconciliationPromise;
    reconciliationPromise = (async () => {
      let progressed: boolean;
      do {
        reconciliationRequested = false;
        const policy = await options.store.readPolicyStatus();
        if (policy.status === "suspended") {
          abortInFlightExecutions();
          await reconcileLivePatchRollbackActivations(policy.suspendedAt);
          return;
        }
        const taskIds = await options.store.listRecoverableTaskIds();
        const results = await Promise.all(
          taskIds.map((taskId) => reconcileTask(taskId)),
        );
        progressed = results.some(Boolean);
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
        current.rollbackActivations.pendingOperationIds.length > 0
      ) {
        await reconcileLivePatchRollbackActivations(current.suspendedAt);
        current = await options.store.readPolicyStatus();
        if (
          current.status === "suspended" &&
          current.rollbackActivations.pendingOperationIds.length > 0
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
        expectedActiveRevision: input.expectedActiveRevision,
        expectedExecutionManifestFingerprint:
          input.expectedExecutionManifestFingerprint,
        expectedStateVersion: input.expectedStateVersion,
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
        expectedActiveRevision: input.expectedActiveRevision,
        expectedExecutionManifestFingerprint:
          input.expectedExecutionManifestFingerprint,
        expectedStateVersion: input.expectedStateVersion,
        revision: {
          activatedAt,
          activatedBy: "fresh-passkey-action",
          definition: administrativeAutonomyPolicyDefinition,
          executionManifest,
          revision,
        },
        stateVersion: current.stateVersion + 1,
      });
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
                .policyRevision ?? 1,
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
        policyRevision: task.policyRevision,
        taskId: task.id,
      };
    },
    async close() {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      await options.store.close();
    },
    getPolicyStatus: () => options.store.readPolicyStatus(),
    async getStatus() {
      const policy = await options.store.readPolicyStatus();
      const manifestMismatch =
        policy.status !== "inactive" &&
        (!sameAdministrativeExecutionManifest(
          policy.executionManifest,
          executionManifest,
        ) || !runtimeImplementationsMatchManifest(policy.executionManifest));
      return {
        policy,
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
      const target = administrativeTaskTargetSchema.parse(input.target);
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
        stateVersion: policy.stateVersion,
        task: {
          activeExecutionDeadline: null,
          conclusion: "Administrative Task confirmation is pending.",
          createdAt: preparedAt,
          id: taskId,
          intendedState,
          kind: "administrative.work",
          outcome,
          executionManifest,
          policyRevision: policy.revision,
          policyStateVersion: policy.stateVersion,
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
      const suspended = await options.store.suspendPolicy({
        expectedRevision: input.expectedRevision,
        expectedStateVersion: input.expectedStateVersion,
        suspendedAt: now(),
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
      await reconcileLivePatchRollbackActivations(suspended.suspendedAt);
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
    identity.enrollmentId === manifest.provider.enrollmentId &&
    identity.runnerPin === manifest.provider.runnerPin
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

function operationRequest(input: {
  readonly authority: AdministrativeAuthoritySnapshot;
  readonly intendedState: string;
  readonly kind: AdministrativeOperationRequest["kind"];
  readonly operationId: AdministrativeOperationId;
  readonly publicationIntent: AdministrativePublicationIntent;
  readonly target: AdministrativeTaskTarget;
  readonly taskId: AdministrativeTaskId;
}): AdministrativeOperationRequest {
  const common = {
    authority: administrativeAuthoritySnapshotSchema.parse(input.authority),
    operationId: input.operationId,
    target: input.target,
    taskId: input.taskId,
  };
  const intendedState = {
    intendedState: input.intendedState,
    kind: "achieve-confirmed-intended-state" as const,
    targetSource: "confirmed-durable-task" as const,
  };
  if (input.kind === "production.observe") {
    return administrativeOperationRequestSchema.parse({
      ...common,
      kind: input.kind,
      observation: {
        intendedState: input.intendedState,
        kind: "registered-application-health",
        targetSource: "confirmed-durable-task",
      },
    });
  }
  if (input.kind === "delegated-worktree.change") {
    return administrativeOperationRequestSchema.parse({
      ...common,
      change: intendedState,
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
  }
  return administrativeOperationRequestSchema.parse({
    ...common,
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
    patch: intendedState,
  });
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
  if (
    request.kind === "delegated-worktree.change" &&
    result.kind === request.kind
  ) {
    const matchingPublication =
      (request.publication.kind === "branch-only" &&
        result.publication.kind === "isolated-branch-prepared") ||
      (request.publication.kind === "open-pull-request" &&
        result.publication.kind === "isolated-pull-request-opened" &&
        result.publication.registeredCodebaseId ===
          request.target.registeredCodebaseId);
    if (!matchingPublication) {
      throw new Error(
        "Administrative publication proof does not match its request",
      );
    }
  }
  if (request.kind === "live-patch.apply" && result.kind === "live-patch.apply") {
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
      healthObserved < initialExecutionStarted ||
      healthObserved > rollbackArmed ||
      rollbackArmed > mutationStarted ||
      rollbackDeadline - mutationStarted !==
        request.mutationBoundary.independentRollback.rollbackWindowMilliseconds ||
      mutationStarted !== effectStarted ||
      mutationStarted >= rollbackDeadline ||
      mutationStarted > verificationObserved ||
      verificationObserved > reconciliationObserved ||
      reconciliationObserved > completed ||
      completed >= rollbackDeadline ||
      proof.reconciliation.registeredCodebaseId !==
        request.target.registeredCodebaseId
    ) {
      throw new Error("Live Patch safety proof is not in a valid time order");
    }
  }
  return result;
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
