import type {
  AdministrativeEvidenceEvent,
  AdministrativeEvidenceRecord,
  AdministrativeExecutionManifest,
  AdministrativeOperationRequest,
  AdministrativeOperationResult,
  AdministrativePolicyRevision,
  AdministrativePolicyStatus,
  AdministrativeTask,
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
  readonly stateVersion: number;
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
      readonly claimId: string;
      readonly decision: "claimed";
      readonly activeExecutionDeadline: string;
      readonly initialExecutionStartedAt: string;
      readonly recovered: boolean;
      readonly request: AdministrativeOperationRequest;
    }
  | { readonly decision: "deferred"; readonly retryAt: string }
  | {
      readonly decision: "denied";
      readonly reason:
        | "active-execution-deadline"
        | "execution-manifest"
        | "stale-policy";
    }
  | { readonly decision: "empty" };

/** Durable state behind the Administrative Autonomy runtime interface. */
export interface AdministrativeAutonomyStore {
  applyEvidenceRetention(input: { readonly cutoff: string }): Promise<void>;
  activatePolicy(input: {
    readonly expectedActiveRevision: number | null;
    readonly expectedExecutionManifestFingerprint: string;
    readonly expectedStateVersion: number;
    readonly revision: AdministrativePolicyRevision;
    readonly stateVersion: number;
  }): Promise<AdministrativePolicyStatus | undefined>;
  claimConfirmation(input: {
    readonly acceptedAt: string;
    readonly acceptedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly capabilityHash: string;
    readonly ownerId: string;
    readonly taskId: string;
  }): Promise<AdministrativeConfirmationClaim>;
  claimNextOperation(input: {
    readonly claimId: string;
    readonly claimedAt: string;
    readonly executionManifest: AdministrativeExecutionManifest;
    readonly leaseExpiresAt: string;
    readonly taskId: string;
  }): Promise<AdministrativeOperationClaim>;
  declineConfirmation(input: {
    readonly capabilityHash: string;
    readonly declinedAt: string;
    readonly declinedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly ownerId: string;
    readonly taskId: string;
  }): Promise<AdministrativeConfirmationClaim>;
  completeOperation(input: {
    readonly claimId: string;
    readonly completedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly operationId: string;
    readonly result: AdministrativeOperationResult;
    readonly taskId: string;
  }): Promise<AdministrativeEvidenceRecord>;
  completeTask(input: {
    readonly completedAt: string;
    readonly completedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly taskId: string;
  }): Promise<AdministrativeEvidenceRecord>;
  denyTask(input: {
    readonly deniedAt: string;
    readonly deniedEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly taskId: string;
  }): Promise<AdministrativeEvidenceRecord>;
  findActivePolicy(): Promise<AdministrativePolicyRevision | undefined>;
  findTaskByOperationId(
    operationId: string,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  findTask(taskId: string): Promise<AdministrativeEvidenceRecord | undefined>;
  listRecoverableTaskIds(): Promise<readonly string[]>;
  listTasks(): Promise<readonly AdministrativeTask[]>;
  readPolicyStatus(): Promise<AdministrativePolicyStatus>;
  renewOperationClaim(input: {
    readonly claimId: string;
    readonly leaseExpiresAt: string;
    readonly operationId: string;
    readonly renewedAt: string;
  }): Promise<boolean>;
  savePlan(input: {
    readonly operations: readonly AdministrativePlannedOperation[];
    readonly planEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly taskId: string;
  }): Promise<AdministrativeEvidenceRecord | undefined>;
  savePreparedTask(
    input: AdministrativePreparedTaskPersistence,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  /**
   * Durable CAS behind the authenticated #83 suspension control. Active policy
   * has no TTL. #86 owns PWA exposure, task lifetime, and compensation.
   */
  suspendPolicy(input: {
    readonly expectedRevision: number;
    readonly expectedStateVersion: number;
    readonly suspendedAt: string;
  }): Promise<AdministrativePolicyStatus | undefined>;
  close(): Promise<void>;
}
