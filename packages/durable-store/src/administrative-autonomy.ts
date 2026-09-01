import type {
  AdministrativeEvidenceEvent,
  AdministrativeEvidenceRecord,
  AdministrativeAuthoritySnapshot,
  AdministrativeOperationRequest,
  AdministrativeOperationResult,
  AdministrativeOperationClaimId,
  AdministrativeOperationId,
  AdministrativePolicyRevision,
  AdministrativePolicyStatus,
  AdministrativeTask,
  AdministrativeTaskId,
  AdministrativeTimestamp,
  LivePatchRollbackActivationRequest,
  LivePatchRollbackActivationResult,
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
      readonly recovered: boolean;
      readonly request: AdministrativeOperationRequest;
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

/** Durable state behind the Administrative Autonomy runtime interface. */
export interface AdministrativeAutonomyStore {
  applyEvidenceRetention(input: {
    readonly cutoff: AdministrativeTimestamp;
  }): Promise<void>;
  armLivePatchRollback(input: {
    readonly claimId: AdministrativeOperationClaimId;
    readonly request: LivePatchRollbackActivationRequest;
  }): Promise<boolean>;
  activatePolicy(input: {
    readonly expectedActiveRevision: number | null;
    readonly expectedExecutionManifestFingerprint: string;
    readonly expectedStateVersion: number;
    readonly revision: AdministrativePolicyRevision;
    readonly stateVersion: number;
  }): Promise<AdministrativePolicyStatus | undefined>;
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
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeEvidenceRecord>;
  completeLivePatchRollbackActivation(input: {
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
    readonly LivePatchRollbackActivationRequest[]
  >;
  listTasks(): Promise<readonly AdministrativeTask[]>;
  readPolicyStatus(): Promise<AdministrativePolicyStatus>;
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
    readonly expectedRevision: number;
    readonly expectedStateVersion: number;
    readonly suspendedAt: AdministrativeTimestamp;
  }): Promise<AdministrativePolicyStatus | undefined>;
  close(): Promise<void>;
}
