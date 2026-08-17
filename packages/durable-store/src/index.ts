import type {
  BountywellRegistration,
  EvidenceEventProjection,
  EvidenceRecordProjection,
  EvidenceRecordSummary,
} from "@voice-agent/contracts";

export * from "./callback-handshake.ts";
export * from "./task-continuity.ts";

export interface ApplicationRegistry {
  findBountywellRegistration(): Promise<BountywellRegistration | undefined>;
  registerBountywell(
    registeredAt: string,
  ): Promise<BountywellRegistration>;
}

export interface AcceptedInquiryPersistence {
  readonly operationId: string;
  readonly record: EvidenceRecordProjection;
  readonly requestId: string;
}

export interface AppendedEvidencePersistence {
  readonly event: Omit<EvidenceEventProjection, "sequence">;
  readonly taskId: string;
  readonly updatedAt: string;
}

export interface ClaimedBountywellOperation {
  readonly operationId: string;
  readonly taskId: string;
}

export interface ExpiredEvidenceRecord {
  readonly expired: true;
}

export interface CompletedInquiryPersistence {
  readonly conclusion: EvidenceRecordProjection["task"]["conclusion"];
  readonly evidence: readonly EvidenceEventProjection[];
  readonly observedAt: string;
  readonly operationId: string;
  readonly taskId: string;
}

export interface CancellationRequestPersistence {
  readonly acceptedEventId: string;
  readonly cancelledEventId: string;
  readonly completedEventId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly requestedAt: string;
  readonly requestedEventId: string;
  readonly taskId: string;
}

export interface VoiceAgentOperationalMetrics {
  readonly bountywellChecks: readonly {
    readonly outcome: "fail" | "pass";
    readonly source:
      | "authentication-boundary"
      | "local-health"
      | "public-health"
      | "resource-health"
      | "service-state";
  }[];
  readonly operations: {
    readonly accepted: number;
    readonly completed: number;
    readonly running: number;
  };
  readonly policyDenials: number;
  readonly storage: {
    readonly databaseBytes: number;
    readonly filesystemAvailableBytes: number;
  };
  readonly tasks: {
    readonly completed: number;
    readonly pending: number;
  };
}

export interface DurableTaskStore {
  applyEvidenceRetention(input: {
    readonly cutoff: string;
  }): Promise<void>;
  appendEvidence(
    input: AppendedEvidencePersistence,
  ): Promise<EvidenceRecordProjection>;
  claimBountywellOperation(input: {
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<ClaimedBountywellOperation | undefined>;
  completeBountywellInquiry(
    input: CompletedInquiryPersistence,
  ): Promise<EvidenceRecordProjection>;
  listTasks(): Promise<readonly EvidenceRecordSummary[]>;
  findByOperationId(
    operationId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  findByRequestId(
    requestId: string,
  ): Promise<EvidenceRecordProjection | ExpiredEvidenceRecord | undefined>;
  findByTaskId(taskId: string): Promise<EvidenceRecordProjection | undefined>;
  readOperationalMetrics(): Promise<VoiceAgentOperationalMetrics>;
  recordPolicyDenial(): Promise<void>;
  requestCancellation(
    input: CancellationRequestPersistence,
  ): Promise<EvidenceRecordProjection>;
  persistAcceptedInquiry(
    input: AcceptedInquiryPersistence,
  ): Promise<EvidenceRecordProjection>;
  close(): Promise<void>;
}
