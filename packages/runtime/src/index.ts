import {
  bountywellHealthObservationSchema,
  type BountywellHealthInquiryRequest,
  type BountywellHealthObserver,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
  type FinalizedTelephoneTurn,
  type TelephoneTurnInterpretation,
} from "@voice-agent/contracts";
import type {
  ApplicationRegistry,
  DurableTaskStore,
} from "@voice-agent/durable-store";
import {
  authorizeBountywellHealthInquiry,
  deriveBountywellHealthConclusion,
} from "@voice-agent/policy";
import {
  createBountywellOutageControls,
  type BountywellOutageControls,
  type BountywellServiceController,
} from "./bountywell-outage.ts";

export * from "./callback-handshake.ts";
export * from "./telephone-boundaries.ts";
export * from "./telephone-session.ts";
export * from "./task-continuity.ts";
export * from "./bountywell-outage.ts";

export interface TelephoneBountywellHealthInquiry {
  readonly interpretation: TelephoneTurnInterpretation;
  readonly sanitizedTranscript: string;
  readonly turn: FinalizedTelephoneTurn;
}

const OPERATION_LEASE_MS = 30_000;
const TELEPHONE_OPERATION_WAIT_MS = 12_000;

export interface DurableTaskRuntime extends BountywellOutageControls {
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
  requestStop(input: {
    readonly requestId: string;
    readonly taskId: string;
  }): Promise<EvidenceRecordProjection>;
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
  submitTelephoneBountywellHealthInquiry(
    input: TelephoneBountywellHealthInquiry,
  ): Promise<EvidenceRecordProjection>;
  appendTelephoneEvidence(input: {
    readonly event: Omit<EvidenceEventProjection, "sequence">;
    readonly taskId: string;
  }): Promise<EvidenceRecordProjection>;
}

export interface DurableTaskRuntimeOptions {
  readonly advanceMs?: (milliseconds: number) => void;
  readonly applicationRegistry?: ApplicationRegistry;
  readonly deferTelephoneOperations?: boolean;
  readonly healthObserver?: BountywellHealthObserver;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly serviceController?: BountywellServiceController;
  readonly store: DurableTaskStore;
}

export function createDurableTaskRuntime(
  options: DurableTaskRuntimeOptions,
): DurableTaskRuntime {
  const activeTelephoneSubmissions = new Map<
    string,
    Promise<EvidenceRecordProjection>
  >();
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
    initialEvidence: readonly EvidenceEventProjection[] = [],
    acceptedAt = options.now(),
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
    const record: EvidenceRecordProjection = {
      evidence: [
        ...initialEvidence,
        {
          details: { requestId: normalizedRequest.requestId },
          id: requireEventId(eventIds, 0),
          kind: "task.accepted",
          occurredAt: acceptedAt,
          sequence: initialEvidence.length + 1,
          summary: "Bountywell health inquiry accepted.",
        },
        {
          details: { operationId },
          id: requireEventId(eventIds, 1),
          kind: "operation.accepted",
          occurredAt: acceptedAt,
          sequence: initialEvidence.length + 2,
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
    const currentRecord = await options.store.findByTaskId(operation.taskId);
    if (currentRecord === undefined) {
      throw new Error("Claimed Bountywell Durable Task is unavailable");
    }
    const firstCompletionSequence =
      (currentRecord.evidence.at(-1)?.sequence ?? 0) + 1;
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
        sequence: firstCompletionSequence,
        summary: "Bounded Bountywell health evidence observed.",
      },
      {
        details: { operationId: operation.operationId },
        id: requireEventId(eventIds, 1),
        kind: "operation.completed",
        occurredAt: observation.observedAt,
        sequence: firstCompletionSequence + 1,
        summary: "Read-only Bountywell health observation completed.",
      },
      {
        details: {},
        id: requireEventId(eventIds, 2),
        kind: "task.completed",
        occurredAt: observation.observedAt,
        sequence: firstCompletionSequence + 2,
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

  async function performTelephoneBountywellHealthInquiry(
    input: TelephoneBountywellHealthInquiry,
  ): Promise<EvidenceRecordProjection> {
    const turnSequence = 1;
    const initialEvidence: readonly EvidenceEventProjection[] = [
      {
        details: {
          telephoneSessionId: input.turn.telephoneSessionId,
          text: input.sanitizedTranscript,
          turnId: input.turn.turnId,
        },
        id: `${input.turn.turnId}:turn`,
        kind: "telephone.turn.finalized",
        occurredAt: input.turn.occurredAt,
        sequence: turnSequence,
        summary: "A finalized sanitized telephone turn was accepted.",
      },
      {
        details: {
          durationMs: input.turn.stt.durationMs,
          outcome: "completed",
          provider: input.turn.stt.provider,
          stage: "stt",
        },
        id: `${input.turn.turnId}:stt`,
        kind: "telephone.provider.timing",
        occurredAt: input.turn.occurredAt,
        sequence: turnSequence + 1,
        summary: "Final speech recognition timing was recorded.",
      },
      {
        details: {
          durationMs: input.interpretation.durationMs,
          outcome: "completed",
          provider: input.interpretation.provider,
          stage: "coordinator",
        },
        id: `${input.turn.turnId}:coordinator`,
        kind: "telephone.provider.timing",
        occurredAt: input.turn.occurredAt,
        sequence: turnSequence + 2,
        summary: "Telephone turn interpretation timing was recorded.",
      },
    ];
    const accepted = await acceptBountywellHealthInquiry(
      {
        question: "Is Bountywell healthy?",
        requestId: `telephone:${input.turn.turnId}`,
      },
      initialEvidence,
      input.turn.occurredAt,
    );
    if (accepted.task.status !== "pending") return accepted;
    if (options.deferTelephoneOperations === true) {
      return waitForCompletedTelephoneTask(accepted.task.id, accepted);
    }
    const processed = await processNextBountywellHealthInquiry();
    if (processed !== undefined) return processed;
    return waitForCompletedTelephoneTask(accepted.task.id, accepted);
  }

  async function waitForCompletedTelephoneTask(
    taskId: string,
    accepted: EvidenceRecordProjection,
  ): Promise<EvidenceRecordProjection> {
    const deadline = Date.now() + TELEPHONE_OPERATION_WAIT_MS;
    let latest = accepted;
    while (Date.now() < deadline) {
      await delay(100);
      const record = await options.store.findByTaskId(taskId);
      if (record === undefined) {
        throw new Error("Telephone Durable Task became unavailable");
      }
      latest = record;
      if (record.task.status !== "pending") return record;
    }
    return latest;
  }

  async function submitTelephoneBountywellHealthInquiry(
    input: TelephoneBountywellHealthInquiry,
  ): Promise<EvidenceRecordProjection> {
    const key = `${input.turn.telephoneSessionId}:${input.turn.turnId}`;
    const active = activeTelephoneSubmissions.get(key);
    if (active !== undefined) return active;
    const submission = performTelephoneBountywellHealthInquiry(input);
    activeTelephoneSubmissions.set(key, submission);
    try {
      return await submission;
    } finally {
      if (activeTelephoneSubmissions.get(key) === submission) {
        activeTelephoneSubmissions.delete(key);
      }
    }
  }

  return {
    acceptBountywellHealthInquiry,
    appendTelephoneEvidence: (input) =>
      options.store.appendEvidence({
        ...input,
        updatedAt: input.event.occurredAt,
      }),
    close: () => options.store.close(),
    async getBountywellRegistration() {
      return options.applicationRegistry?.findBountywellRegistration();
    },
    getEvidenceRecord: (taskId) => options.store.findByTaskId(taskId),
    listEvidenceRecords: () => options.store.listTasks(),
    readOperationalMetrics: () => options.store.readOperationalMetrics(),
    recordPolicyDenial: () => options.store.recordPolicyDenial(),
    requestStop(input) {
      return options.store.requestCancellation({
        operationId: options.nextId(),
        requestId: input.requestId,
        requestedEventId: options.nextId(),
        acceptedEventId: options.nextId(),
        completedEventId: options.nextId(),
        cancelledEventId: options.nextId(),
        requestedAt: options.now(),
        taskId: input.taskId,
      });
    },
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
      if (accepted.task.status !== "pending") return accepted;
      return (await processNextBountywellHealthInquiry()) ?? accepted;
    },
    submitTelephoneBountywellHealthInquiry,
    ...createBountywellOutageControls({
      ...(options.advanceMs === undefined ? {} : { advanceMs: options.advanceMs }),
      ...(options.applicationRegistry === undefined
        ? {}
        : { applicationRegistry: options.applicationRegistry }),
      ...(options.healthObserver === undefined
        ? {}
        : { healthObserver: options.healthObserver }),
      nextId: options.nextId,
      now: options.now,
      recordPolicyDenial: () => options.store.recordPolicyDenial(),
      ...(options.serviceController === undefined
        ? {}
        : { serviceController: options.serviceController }),
      store: options.store,
    }),
  };
}

function requireEventId(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`Missing deterministic event identifier at index ${index}`);
  }
  return id;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export * from "./keeplore-onboarding.ts";

export * from "./keeplore-live-inspector.ts";
export * from "./keeplore-registration-file.ts";
