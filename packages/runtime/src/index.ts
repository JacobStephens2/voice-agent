import {
  bountywellHealthObservationSchema,
  type BountywellHealthInquiryRequest,
  type BountywellHealthObserver,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import type { DurableTaskStore } from "@voice-agent/durable-store";
import {
  authorizeBountywellHealthInquiry,
  deriveBountywellHealthConclusion,
} from "@voice-agent/policy";

export interface DurableTaskRuntime {
  submitBountywellHealthInquiry(
    request: BountywellHealthInquiryRequest,
  ): Promise<EvidenceRecordProjection>;
  getEvidenceRecord(taskId: string): Promise<EvidenceRecordProjection | undefined>;
  replayBountywellHealthOperation(
    operationId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  close(): Promise<void>;
}

export interface DurableTaskRuntimeOptions {
  readonly store: DurableTaskStore;
  readonly healthObserver: BountywellHealthObserver;
  readonly nextId: () => string;
  readonly now: () => string;
}

export function createDurableTaskRuntime(
  options: DurableTaskRuntimeOptions,
): DurableTaskRuntime {
  return {
    close: () => options.store.close(),

    getEvidenceRecord: (taskId) => options.store.findByTaskId(taskId),

    replayBountywellHealthOperation: (operationId) =>
      options.store.findByOperationId(operationId),

    async submitBountywellHealthInquiry(request) {
      const normalizedRequest = authorizeBountywellHealthInquiry(request);
      const existingTask = await options.store.findByRequestId(
        normalizedRequest.requestId,
      );
      if (existingTask !== undefined) return existingTask;

      const taskId = options.nextId();
      const operationId = options.nextId();
      const eventIds = Array.from({ length: 5 }, () => options.nextId());
      const acceptedAt = options.now();
      const observation = bountywellHealthObservationSchema.parse(
        await options.healthObserver.observe({ operationId, taskId }),
      );
      const conclusion = deriveBountywellHealthConclusion(observation);

      const record: EvidenceRecordProjection = {
        evidence: [
          {
            details: { requestId: normalizedRequest.requestId },
            id: requireEventId(eventIds, 0),
            kind: "task.accepted",
            occurredAt: acceptedAt,
            sequence: 1,
            summary: "Bountywell health inquiry accepted.",
          },
          {
            details: { operationId },
            id: requireEventId(eventIds, 1),
            kind: "operation.accepted",
            occurredAt: acceptedAt,
            sequence: 2,
            summary: "Read-only Bountywell health observation accepted.",
          },
          {
            details: {
              checks: observation.checks,
              rejectedEvidenceCount: observation.rejectedEvidenceCount,
            },
            id: requireEventId(eventIds, 2),
            kind: "evidence.observed",
            occurredAt: observation.observedAt,
            sequence: 3,
            summary: "Bounded Bountywell health evidence observed.",
          },
          {
            details: { operationId },
            id: requireEventId(eventIds, 3),
            kind: "operation.completed",
            occurredAt: observation.observedAt,
            sequence: 4,
            summary: "Read-only Bountywell health observation completed.",
          },
          {
            details: {},
            id: requireEventId(eventIds, 4),
            kind: "task.completed",
            occurredAt: observation.observedAt,
            sequence: 5,
            summary: conclusion,
          },
        ],
        task: {
          conclusion,
          createdAt: acceptedAt,
          id: taskId,
          kind: "bountywell.health.inquiry",
          question: normalizedRequest.question,
          status: "completed",
          updatedAt: observation.observedAt,
        },
      };

      await options.store.persistCompletedInquiry({
        operationId,
        record,
        requestId: normalizedRequest.requestId,
      });
      return record;
    },
  };
}

function requireEventId(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`Missing deterministic event identifier at index ${index}`);
  }
  return id;
}
