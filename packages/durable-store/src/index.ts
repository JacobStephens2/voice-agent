import type {
  EvidenceRecordProjection,
  EvidenceRecordSummary,
} from "@voice-agent/contracts";

export interface CompletedInquiryPersistence {
  readonly operationId: string;
  readonly record: EvidenceRecordProjection;
  readonly requestId: string;
}

export interface DurableTaskStore {
  listTasks(): Promise<readonly EvidenceRecordSummary[]>;
  findByOperationId(
    operationId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  findByRequestId(
    requestId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  findByTaskId(taskId: string): Promise<EvidenceRecordProjection | undefined>;
  persistCompletedInquiry(input: CompletedInquiryPersistence): Promise<void>;
  close(): Promise<void>;
}
