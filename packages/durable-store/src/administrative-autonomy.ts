import type {
  AdministrativeEvidenceEvent,
  AdministrativeExecutionPauseReason,
  AdministrativeEvidenceRecord,
  AdministrativeAuthoritySnapshot,
  AdministrativeOperationRequest,
  AdministrativeOperationResult,
  AdministrativeOperationClaimId,
  AdministrativeOperationId,
  AdministrativePolicyRevision,
  AdministrativePolicyActivationExpectation,
  AdministrativePolicyEvidenceEventInput,
  AdministrativePolicyEvidencePage,
  AdministrativePolicyEvidencePageRequest,
  AdministrativePolicyEvidenceProjection,
  AdministrativePolicySuspensionExpectation,
  AdministrativePolicyStatus,
  AdministrativeTask,
  AdministrativeTaskId,
  AdministrativeTimestamp,
  LivePatchRollbackActivationRequest,
  LivePatchRollbackActivationFailureReason,
  LivePatchRollbackActivationResult,
  PendingLivePatchRollbackActivation,
} from "@voice-agent/contracts";

type UnsequencedAdministrativeEvidenceEvent =
  AdministrativeEvidenceEvent extends infer Event
    ? Event extends AdministrativeEvidenceEvent
      ? Omit<Event, "sequence">
      : never
    : never;

export interface AdministrativePreparedTaskPersistence {
  readonly capabilityHash: string;
  readonly event: UnsequencedAdministrativeEvidenceEvent;
  readonly ownerId: string;
  readonly requestId: string;
  readonly task: AdministrativeTask;
}

export interface AdministrativePlannedOperation {
  readonly acceptedEvent: UnsequencedAdministrativeEvidenceEvent;
  readonly request: AdministrativeOperationRequest;
}

export type AdministrativeConfirmationClaim =
  | { readonly decision: "claimed"; readonly record: AdministrativeEvidenceRecord }
  | {
      readonly decision: "denied";
      readonly reason:
        | "confirmation-replayed"
        | "identity-mismatch"
        | "invalid-capability"
        | "stale-policy"
        | "task-unavailable";
    };

export type AdministrativeOperationClaim =
  | {
      readonly claimId: AdministrativeOperationClaimId;
      readonly decision: "claimed";
      readonly activeExecutionDeadline: AdministrativeTimestamp;
      readonly initialExecutionStartedAt: AdministrativeTimestamp;
      readonly leaseExpiresAt: AdministrativeTimestamp;
      readonly recovered: boolean;
      readonly request: AdministrativeOperationRequest;
      /** Stale authority may only recover a result already owned by the broker. */
      readonly settlementOnly: boolean;
    }
  | {
      readonly decision: "deferred";
      readonly retryAt: AdministrativeTimestamp;
    }
  | {
      readonly decision: "denied";
      readonly reason:
        | "active-execution-deadline"
        | "execution-manifest"
        | "stale-policy";
    }
  /** The Task is paused or stopped: no work may start, and none has failed. */
  | { readonly decision: "halted" }
  | { readonly decision: "empty" };

export type AdministrativeEffectAuthority =
  | { readonly decision: "authorized" }
  | {
      readonly decision: "denied";
      readonly reason:
        | "active-execution-deadline"
        | "claim-lost"
        | "execution-manifest"
        | "live-patch-rollback"
        | "stale-policy";
    };

/**
 * Identity for a lifetime Evidence Event. The store composes the details from
 * the state it changes in the same transaction, so a Stop or pause can never
 * record a projection that raced with the change it describes.
 */
export interface AdministrativeLifetimeEventIdentity {
  readonly id: string;
  readonly summary: string;
}

export type AdministrativeTaskLifetimeDenialReason =
  | "budget-exhausted"
  | "task-already-paused"
  | "task-not-paused"
  | "task-not-running"
  | "task-unavailable";

export type AdministrativeTaskLifetimeOutcome =
  | {
      readonly decision: "applied";
      readonly record: AdministrativeEvidenceRecord;
    }
  | {
      readonly decision: "denied";
      readonly reason: AdministrativeTaskLifetimeDenialReason;
    };

/** Durable state behind the Administrative Autonomy runtime interface. */
export interface AdministrativeAutonomyStore {
  allOperationsCompleted(taskId: AdministrativeTaskId): Promise<boolean>;
  applyEvidenceRetention(input: {
    readonly cutoff: AdministrativeTimestamp;
  }): Promise<void>;
  armLivePatchRollback(input: {
    readonly claimId: AdministrativeOperationClaimId;
    readonly request: LivePatchRollbackActivationRequest;
  }): Promise<boolean>;
  activatePolicy(input: {
    readonly expectation: AdministrativePolicyActivationExpectation;
    readonly revision: AdministrativePolicyRevision;
    readonly stateVersion: number;
  }): Promise<
    | AdministrativePolicyStatus
    | {
        readonly decision: "blocked";
        readonly reason: "unresolved-live-patch-rollback-windows";
      }
    | undefined
  >;
  claimConfirmation(input: {
    readonly acceptedAt: AdministrativeTimestamp;
    readonly acceptedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly capabilityHash: string;
    readonly ownerId: string;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeConfirmationClaim>;
  claimNextOperation(input: {
    readonly authority: AdministrativeAuthoritySnapshot;
    readonly claimId: AdministrativeOperationClaimId;
    readonly claimedAt: AdministrativeTimestamp;
    readonly leaseExpiresAt: AdministrativeTimestamp;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeOperationClaim>;
  /** Claims only result reconciliation; it can never authorize an effect. */
  claimOperationSettlement(input: {
    readonly claimId: AdministrativeOperationClaimId;
    readonly claimedAt: AdministrativeTimestamp;
    readonly leaseExpiresAt: AdministrativeTimestamp;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeOperationClaim>;
  declineConfirmation(input: {
    readonly capabilityHash: string;
    readonly declinedAt: AdministrativeTimestamp;
    readonly declinedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly ownerId: string;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeConfirmationClaim>;
  completeOperation(input: {
    readonly claimId: AdministrativeOperationClaimId;
    readonly completedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly operationId: AdministrativeOperationId;
    readonly result: AdministrativeOperationResult;
    readonly settledAt: AdministrativeTimestamp;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeEvidenceRecord>;
  settleClaimedOperationAndDenyTask(input: {
    readonly claimId: AdministrativeOperationClaimId;
    readonly deniedAt: AdministrativeTimestamp;
    readonly deniedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly operationId: AdministrativeOperationId;
    readonly operationEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly operationStatus: "failed" | "stopped";
    readonly result?: AdministrativeOperationResult;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeEvidenceRecord>;
  completeLivePatchRollbackActivation(input: {
    readonly completedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly result: LivePatchRollbackActivationResult;
  }): Promise<boolean>;
  completeTask(input: {
    readonly completedAt: AdministrativeTimestamp;
    readonly completedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeEvidenceRecord>;
  denyTask(input: {
    readonly deniedAt: AdministrativeTimestamp;
    readonly deniedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeEvidenceRecord>;
  findActivePolicy(): Promise<AdministrativePolicyRevision | undefined>;
  findTaskByOperationId(
    operationId: AdministrativeOperationId,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  findTask(
    taskId: AdministrativeTaskId,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  listRecoverableTaskIds(): Promise<readonly AdministrativeTaskId[]>;
  listPendingLivePatchRollbackActivations(): Promise<
    readonly PendingLivePatchRollbackActivation[]
  >;
  listTasks(): Promise<readonly AdministrativeTask[]>;
  readPolicyEvidence(): Promise<AdministrativePolicyEvidenceProjection>;
  readPolicyEvidencePage(
    input: AdministrativePolicyEvidencePageRequest,
  ): Promise<AdministrativePolicyEvidencePage>;
  readPolicyStatus(): Promise<AdministrativePolicyStatus>;
  recordLivePatchRollbackActivationFailure(input: {
    readonly failedAt: AdministrativeTimestamp;
    readonly failureEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly nextAttemptAt: AdministrativeTimestamp;
    readonly operationId: AdministrativeOperationId;
    readonly reason: LivePatchRollbackActivationFailureReason;
  }): Promise<boolean>;
  recheckOperationEffect(input: {
    readonly authority: AdministrativeAuthoritySnapshot;
    readonly claimId: AdministrativeOperationClaimId;
    readonly effectAt: AdministrativeTimestamp;
    readonly livePatchRollbackWindow?: {
      readonly armedAt: AdministrativeTimestamp;
      readonly mutationStartedAt: AdministrativeTimestamp;
      readonly rollbackDeadline: AdministrativeTimestamp;
    };
    readonly operationId: AdministrativeOperationId;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeEffectAuthority>;
  renewOperationClaim(input: {
    readonly claimId: AdministrativeOperationClaimId;
    readonly leaseExpiresAt: AdministrativeTimestamp;
    readonly operationId: AdministrativeOperationId;
    readonly renewedAt: AdministrativeTimestamp;
  }): Promise<boolean>;
  /**
   * Suspends the active-execution budget. The remaining budget is banked, the
   * deadline is cleared, and no Operation may start until the Task resumes.
   */
  pauseTask(input: {
    readonly event: AdministrativeLifetimeEventIdentity;
    readonly pausedAt: AdministrativeTimestamp;
    readonly reason: AdministrativeExecutionPauseReason;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeTaskLifetimeOutcome>;
  /** Restarts the budget clock with exactly the time the Task had left. */
  resumeTask(input: {
    readonly event: AdministrativeLifetimeEventIdentity;
    readonly resumedAt: AdministrativeTimestamp;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeTaskLifetimeOutcome>;
  /**
   * Owner Stop. Future work is refused, outstanding Operations are settled as
   * stopped, worktrees and evidence are preserved, and every armed Live Patch
   * rollback for the Task becomes owed compensation.
   */
  stopTask(input: {
    readonly event: AdministrativeLifetimeEventIdentity;
    readonly stoppedAt: AdministrativeTimestamp;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeTaskLifetimeOutcome>;
  savePlan(input: {
    readonly operations: readonly AdministrativePlannedOperation[];
    readonly planEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeEvidenceRecord | undefined>;
  savePreparedTask(
    input: AdministrativePreparedTaskPersistence,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  /**
   * Durable CAS behind #83 Administrative Suspension. It closes admission and
   * makes every armed Live Patch rollback recoverably pending in one commit.
   * #86 owns PWA exposure, task lifetime, Host Patch coverage, and broader
   * compensation orchestration.
   */
  suspendPolicy(input: {
    readonly expectation: AdministrativePolicySuspensionExpectation;
    readonly suspensionEvent: AdministrativePolicyEvidenceEventInput;
    readonly suspendedAt: AdministrativeTimestamp;
  }): Promise<AdministrativePolicyStatus | undefined>;
  close(): Promise<void>;
}
