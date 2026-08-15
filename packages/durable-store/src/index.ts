import type { EvidenceRecordProjection } from "@voice-agent/contracts";

export interface CompletedInquiryPersistence {
  readonly operationId: string;
  readonly record: EvidenceRecordProjection;
  readonly requestId: string;
}

export interface DurableTaskStore {
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
