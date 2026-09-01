import type {
  AdministrativeEvidenceEvent,
  AdministrativeEvidenceRecord,
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

/** Durable state behind the Administrative Autonomy runtime interface. */
export interface AdministrativeAutonomyStore {
  activatePolicy(input: {
    readonly expectedActiveRevision: number | null;
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
  completeOperation(input: {
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
  findTask(taskId: string): Promise<AdministrativeEvidenceRecord | undefined>;
  listTasks(): Promise<readonly AdministrativeTask[]>;
  readPolicyStatus(): Promise<AdministrativePolicyStatus>;
  savePlan(input: {
    readonly operations: readonly AdministrativePlannedOperation[];
    readonly planEvent: UnsequencedAdministrativeEvidenceEvent;
    readonly taskId: string;
  }): Promise<AdministrativeEvidenceRecord | undefined>;
  savePreparedTask(
    input: AdministrativePreparedTaskPersistence,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  close(): Promise<void>;
}
