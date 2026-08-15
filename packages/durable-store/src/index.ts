import type {
  BountywellRegistration,
  EvidenceEventProjection,
  EvidenceRecordProjection,
  EvidenceRecordSummary,
} from "@voice-agent/contracts";

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
  persistAcceptedInquiry(
    input: AcceptedInquiryPersistence,
  ): Promise<EvidenceRecordProjection>;
  close(): Promise<void>;
}
