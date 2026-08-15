import {
  bountywellHealthObservationSchema,
  type BountywellHealthInquiryRequest,
  type BountywellHealthObserver,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
} from "@voice-agent/contracts";
import type {
  ApplicationRegistry,
  DurableTaskStore,
} from "@voice-agent/durable-store";
import {
  authorizeBountywellHealthInquiry,
  deriveBountywellHealthConclusion,
} from "@voice-agent/policy";

const OPERATION_LEASE_MS = 30_000;

export interface DurableTaskRuntime {
  acceptBountywellHealthInquiry(
    request: BountywellHealthInquiryRequest,
  ): Promise<EvidenceRecordProjection>;
  close(): Promise<void>;
  getEvidenceRecord(taskId: string): Promise<EvidenceRecordProjection | undefined>;
  getBountywellRegistration(): ReturnType<
    ApplicationRegistry["findBountywellRegistration"]
  >;
  listEvidenceRecords(): Promise<readonly EvidenceRecordSummary[]>;
  readOperationalMetrics(): ReturnType<DurableTaskStore["readOperationalMetrics"]>;
  recordPolicyDenial(): ReturnType<DurableTaskStore["recordPolicyDenial"]>;
  processNextBountywellHealthInquiry(): Promise<
    EvidenceRecordProjection | undefined
  >;
  registerBountywell(): ReturnType<ApplicationRegistry["registerBountywell"]>;
  replayBountywellHealthOperation(
    operationId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  submitBountywellHealthInquiry(
    request: BountywellHealthInquiryRequest,
  ): Promise<EvidenceRecordProjection>;
}

export interface DurableTaskRuntimeOptions {
  readonly applicationRegistry?: ApplicationRegistry;
  readonly healthObserver?: BountywellHealthObserver;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly store: DurableTaskStore;
}

export function createDurableTaskRuntime(
  options: DurableTaskRuntimeOptions,
): DurableTaskRuntime {
  async function requireRegistration(): Promise<void> {
    if (
      options.applicationRegistry !== undefined &&
      (await options.applicationRegistry.findBountywellRegistration()) ===
        undefined
    ) {
      throw new Error("Bountywell is not registered");
    }
  }

  async function acceptBountywellHealthInquiry(
    request: BountywellHealthInquiryRequest,
  ): Promise<EvidenceRecordProjection> {
    const normalizedRequest = authorizeBountywellHealthInquiry(request);
    await requireRegistration();
    const existingTask = await options.store.findByRequestId(
      normalizedRequest.requestId,
    );
    if (existingTask !== undefined) {
      if ("expired" in existingTask) {
        throw new Error("Evidence Record retention expired");
      }
      return existingTask;
    }

    const taskId = options.nextId();
    const operationId = options.nextId();
    const eventIds = [options.nextId(), options.nextId()];
    const acceptedAt = options.now();
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
      ],
      task: {
        conclusion: "Bountywell inquiry is pending.",
        createdAt: acceptedAt,
        id: taskId,
        kind: "bountywell.health.inquiry",
        question: normalizedRequest.question,
        status: "pending",
        updatedAt: acceptedAt,
      },
    };
    return options.store.persistAcceptedInquiry({
      operationId,
      record,
      requestId: normalizedRequest.requestId,
    });
  }

  async function processNextBountywellHealthInquiry(): Promise<
    EvidenceRecordProjection | undefined
  > {
    await requireRegistration();
    if (options.healthObserver === undefined) {
      throw new Error("Bountywell health observer is unavailable");
    }
    const claimedAt = options.now();
    const operation = await options.store.claimBountywellOperation({
      claimedAt,
      leaseExpiresAt: new Date(
        new Date(claimedAt).getTime() + OPERATION_LEASE_MS,
      ).toISOString(),
    });
    if (operation === undefined) return undefined;

    const observation = bountywellHealthObservationSchema.parse(
      await options.healthObserver.observe(operation),
    );
    const conclusion = deriveBountywellHealthConclusion(observation);
    const eventIds = [options.nextId(), options.nextId(), options.nextId()];
    const evidence: readonly EvidenceEventProjection[] = [
      {
        details: {
          checks: observation.checks,
          rejectedEvidenceCount: observation.rejectedEvidenceCount,
          ...(observation.uncertainty === undefined
            ? {}
            : { uncertainty: observation.uncertainty }),
        },
        id: requireEventId(eventIds, 0),
        kind: "evidence.observed",
        occurredAt: observation.observedAt,
        sequence: 3,
        summary: "Bounded Bountywell health evidence observed.",
      },
      {
        details: { operationId: operation.operationId },
        id: requireEventId(eventIds, 1),
        kind: "operation.completed",
        occurredAt: observation.observedAt,
        sequence: 4,
        summary: "Read-only Bountywell health observation completed.",
      },
      {
        details: {},
        id: requireEventId(eventIds, 2),
        kind: "task.completed",
        occurredAt: observation.observedAt,
        sequence: 5,
        summary: conclusion,
      },
    ];
    return options.store.completeBountywellInquiry({
      conclusion,
      evidence,
      observedAt: observation.observedAt,
      operationId: operation.operationId,
      taskId: operation.taskId,
    });
  }

  return {
    acceptBountywellHealthInquiry,
    close: () => options.store.close(),
    async getBountywellRegistration() {
      return options.applicationRegistry?.findBountywellRegistration();
    },
    getEvidenceRecord: (taskId) => options.store.findByTaskId(taskId),
    listEvidenceRecords: () => options.store.listTasks(),
    readOperationalMetrics: () => options.store.readOperationalMetrics(),
    recordPolicyDenial: () => options.store.recordPolicyDenial(),
    processNextBountywellHealthInquiry,
    async registerBountywell() {
      if (options.applicationRegistry === undefined) {
        throw new Error("Application registry is unavailable");
      }
      return options.applicationRegistry.registerBountywell(options.now());
    },
    replayBountywellHealthOperation: (operationId) =>
      options.store.findByOperationId(operationId),
    async submitBountywellHealthInquiry(request) {
      const accepted = await acceptBountywellHealthInquiry(request);
      if (accepted.task.status === "completed") return accepted;
      return (await processNextBountywellHealthInquiry()) ?? accepted;
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
