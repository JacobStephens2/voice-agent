import { createHash } from "node:crypto";

import {
  callbackActionResultSchema,
  callbackProviderEventSchema,
  e164TelephoneNumberSchema,
  inboundTelephoneEventSchema,
  inboundTelephoneResultSchema,
  registeredTelephoneInputSchema,
  type CallbackAction,
  type CallbackActionResult,
  type CallbackHandshakeSnapshot,
  type CallbackProviderEvent,
  type InboundTelephoneEvent,
  type InboundTelephoneResult,
  type RegisteredTelephone,
  type RegisteredTelephoneInput,
  type TelephoneConversationEvidenceEvent,
  type TelephoneEvidenceEvent,
  type TelephoneEvidenceRecordSummary,
  type TelephoneSessionEvidenceRecordProjection,
} from "@voice-agent/contracts";
import type { CallbackHandshakeStore } from "@voice-agent/durable-store";

const inboundNotice = "Thanks. I’ll call your registered telephone back now." as const;
const dtmfPrompt = "Press 1 to confirm you are the registered owner." as const;
const confirmation = "Telephone confirmed. Your secure session is ready." as const;
const rateLimitWindowMs = 5 * 60 * 1_000;

export interface CallbackHandshakeRuntime {
  appendTelephoneSessionEvidence(
    handshakeId: string,
    event: Omit<TelephoneConversationEvidenceEvent, "sequence">,
  ): Promise<TelephoneSessionEvidenceRecordProjection>;
  close(): Promise<void>;
  findRegisteredTelephone(): Promise<RegisteredTelephone | undefined>;
  listEvidenceRecords(): Promise<readonly TelephoneEvidenceRecordSummary[]>;
  processDueRetries(): Promise<readonly {
    readonly handshakeId: string;
    readonly result: CallbackActionResult;
  }[]>;
  readEvidenceRecord(
    handshakeId: string,
  ): Promise<TelephoneSessionEvidenceRecordProjection | undefined>;
  readOperationalMetrics(): ReturnType<
    CallbackHandshakeStore["readOperationalMetrics"]
  >;
  requestTelephoneSessionFailureNotification(
    handshakeId: string,
    input: { readonly failureEventId: string; readonly occurredAt: string },
  ): Promise<TelephoneSessionEvidenceRecordProjection>;
  receiveInbound(event: InboundTelephoneEvent): Promise<InboundTelephoneResult>;
  receiveProviderEvent(
    handshakeId: string,
    event: CallbackProviderEvent,
  ): Promise<CallbackActionResult>;
  registerTelephone(input: RegisteredTelephoneInput): Promise<RegisteredTelephone>;
}

export interface CallbackHandshakeRuntimeOptions {
  readonly maximumAcceptedInWindow?: number;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly store: CallbackHandshakeStore;
}

export function createCallbackHandshakeRuntime(
  options: CallbackHandshakeRuntimeOptions,
): CallbackHandshakeRuntime {
  const maximumAcceptedInWindow = options.maximumAcceptedInWindow ?? 3;

  async function receiveInbound(
    untrustedEvent: InboundTelephoneEvent,
  ): Promise<InboundTelephoneResult> {
    const event = inboundTelephoneEventSchema.parse(untrustedEvent);
    const duplicate = await options.store.findDelivery(event.deliveryId);
    if (duplicate !== undefined) {
      return suppressDuplicateCallback(
        inboundTelephoneResultSchema.parse(duplicate),
      );
    }
    const registration = await options.store.findRegisteredTelephone();
    if (!isAcceptedInbound(event, registration)) {
      return options.store.persistRejectedDelivery(
        event.deliveryId,
        rejectedInboundResult(),
      );
    }

    const acceptedAt = options.now();
    const handshakeId = options.nextId();
    const telephoneSessionId = options.nextId();
    const callbackOperationId = options.nextId();
    const events: TelephoneEvidenceEvent[] = [
      {
        details: {
          callerFingerprint: fingerprint(event.callerNumber),
          providerCorrelation: fingerprint(event.providerCallId),
        },
        id: options.nextId(),
        kind: "telephone.inbound.received",
        occurredAt: acceptedAt,
        sequence: 1,
        summary: "A registered telephone requested a Callback Handshake.",
      },
      {
        details: {},
        id: options.nextId(),
        kind: "telephone.inbound.notice",
        occurredAt: acceptedAt,
        sequence: 2,
        summary: "The fixed callback notice was requested; commands were disabled.",
      },
      {
        details: { attempt: 1, operationId: callbackOperationId },
        id: options.nextId(),
        kind: "telephone.callback.requested",
        occurredAt: acceptedAt,
        sequence: 3,
        summary: "Callback attempt 1 was requested through the registered route.",
      },
    ];
    const noticeEffectId = options.nextId();
    const callbackEffectId = options.nextId();
    const snapshot: CallbackHandshakeSnapshot = {
      callbackOperationId,
      callbackParticipantIdentity: callbackOperationId,
      callerFingerprint: fingerprint(event.callerNumber),
      humanDetected: false,
      id: handshakeId,
      receivedDtmfOne: false,
      registrationRevision: registration.revision,
      revision: 0,
      state: "awaiting-machine",
      telephoneSessionId,
    };
    const projection: TelephoneSessionEvidenceRecordProjection = {
      evidence: events,
      session: {
        attempt: 1,
        id: telephoneSessionId,
        outcome: "pending",
      },
      task: {
        conclusion: "Callback Handshake is pending.",
        createdAt: acceptedAt,
        id: handshakeId,
        kind: "callback.handshake",
        question: "Authenticate a Telephone Session.",
        status: "pending",
        updatedAt: acceptedAt,
      },
    };
    const result: InboundTelephoneResult = {
      actions: [
        {
          effectId: noticeEffectId,
          kind: "play-inbound-notice-and-end",
          text: inboundNotice,
        },
        placeCallbackAction({
          attempt: 1,
          effectId: callbackEffectId,
          handshakeId,
          participantIdentity: callbackOperationId,
          registration,
        }),
      ],
      disposition: "notice-and-callback",
      handshakeId,
    };
    const cutoff = new Date(
      new Date(acceptedAt).getTime() - rateLimitWindowMs,
    ).toISOString();
    const persisted = await options.store.createHandshake({
      acceptedAt,
      deliveryId: event.deliveryId,
      maximumAcceptedInWindow,
      projection,
      rateLimitCutoff: cutoff,
      rateLimitedResult: rejectedInboundResult(),
      result,
      snapshot,
    });
    const parsed = inboundTelephoneResultSchema.parse(persisted.result);
    return persisted.kind === "duplicate"
      ? suppressDuplicateCallback(parsed)
      : parsed;
  }

  async function receiveProviderEvent(
    handshakeId: string,
    untrustedEvent: CallbackProviderEvent,
  ): Promise<CallbackActionResult> {
    const event = callbackProviderEventSchema.parse(untrustedEvent);
    const duplicate = await options.store.findDelivery(event.deliveryId);
    if (duplicate !== undefined) {
      return callbackActionResultSchema.parse(duplicate);
    }

    for (let conflict = 0; conflict < 3; conflict += 1) {
      const snapshot = await options.store.findHandshake(handshakeId);
      const projection = await options.store.findEvidenceRecord(handshakeId);
      if (snapshot === undefined || projection === undefined) {
        throw new Error("Callback Handshake is unavailable");
      }
      const transition = reduceProviderEvent(snapshot, projection, event);
      const persisted = await options.store.applyTransition({
        deliveryId: event.deliveryId,
        expectedRevision: snapshot.revision,
        projection: transition.projection,
        result: transition.result,
        snapshot: transition.snapshot,
      });
      if (persisted.kind === "conflict") continue;
      return callbackActionResultSchema.parse(persisted.result);
    }
    throw new Error("Callback Handshake changed concurrently");
  }

  function reduceProviderEvent(
    snapshot: CallbackHandshakeSnapshot,
    projection: TelephoneSessionEvidenceRecordProjection,
    event: CallbackProviderEvent,
  ): {
    readonly projection: TelephoneSessionEvidenceRecordProjection;
    readonly result: CallbackActionResult;
    readonly snapshot: CallbackHandshakeSnapshot;
  } {
    if (event.attempt !== projection.session.attempt) {
      return rejectionTransition(
        snapshot,
        projection,
        event.attempt,
        "out-of-order",
      );
    }
    if (snapshot.state === "authorized" || snapshot.state === "failed") {
      return rejectionTransition(
        snapshot,
        projection,
        event.attempt,
        "out-of-order",
      );
    }
    if (event.kind === "machine-detection") {
      return machineTransition(snapshot, projection, event);
    }
    if (event.kind === "dtmf") {
      return dtmfTransition(snapshot, projection, event);
    }
    if (event.kind === "speech") {
      return rejectionTransition(
        snapshot,
        projection,
        event.attempt,
        "caller-speech",
      );
    }
    return endedTransition(snapshot, projection, event);
  }

  function machineTransition(
    snapshot: CallbackHandshakeSnapshot,
    projection: TelephoneSessionEvidenceRecordProjection,
    event: Extract<CallbackProviderEvent, { kind: "machine-detection" }>,
  ) {
    const occurredAt = options.now();
    const evidence = appendEvent(projection, {
      details: {
        attempt: event.attempt,
        classification: event.classification,
        providerCorrelation: fingerprint(event.providerCallId),
      },
      id: options.nextId(),
      kind: "telephone.machine.detected",
      occurredAt,
      summary: `Answering-machine detection classified attempt ${event.attempt}.`,
    });
    if (event.classification !== "human") {
      return failHandshake(
        { ...snapshot, humanDetected: false },
        evidence,
        event.attempt,
        "machine-not-human",
        "voicemail",
        fingerprint(event.providerCallId),
      );
    }
    const humanSnapshot = { ...snapshot, humanDetected: true };
    if (snapshot.receivedDtmfOne) {
      return authorizeHandshake(humanSnapshot, evidence);
    }
    return {
      projection: updateProjection(evidence, occurredAt),
      result: {
        actions: [
          {
            effectId: options.nextId(),
            kind: "prompt-for-dtmf" as const,
            text: dtmfPrompt,
          },
        ],
      },
      snapshot: {
        ...humanSnapshot,
        revision: snapshot.revision + 1,
        state: "awaiting-dtmf" as const,
      },
    };
  }

  function dtmfTransition(
    snapshot: CallbackHandshakeSnapshot,
    projection: TelephoneSessionEvidenceRecordProjection,
    event: Extract<CallbackProviderEvent, { kind: "dtmf" }>,
  ) {
    const occurredAt = options.now();
    const receivedOne = event.digit === "1";
    const evidence = appendEvent(projection, {
      details: {
        accepted: receivedOne,
        attempt: event.attempt,
        digit: receivedOne ? "1" : "other",
        providerCorrelation: fingerprint(event.providerCallId),
      },
      id: options.nextId(),
      kind: "telephone.dtmf.received",
      occurredAt,
      summary: receivedOne
        ? "DTMF 1 was received from the callback leg."
        : "A non-authorizing DTMF digit was received.",
    });
    if (!receivedOne) {
      return rejectionTransition(
        snapshot,
        evidence,
        event.attempt,
        "bad-dtmf",
      );
    }
    const nextSnapshot = { ...snapshot, receivedDtmfOne: true };
    if (snapshot.humanDetected) {
      return authorizeHandshake(nextSnapshot, evidence);
    }
    return {
      projection: updateProjection(evidence, occurredAt),
      result: { actions: [] },
      snapshot: {
        ...nextSnapshot,
        revision: snapshot.revision + 1,
      },
    };
  }

  function authorizeHandshake(
    snapshot: CallbackHandshakeSnapshot,
    projection: TelephoneSessionEvidenceRecordProjection,
  ) {
    const occurredAt = options.now();
    const answered = appendEvent(projection, {
      details: {
        attempt: projection.session.attempt,
        outcome: "authorized",
        providerCorrelation: latestProviderCorrelation(projection),
      },
      id: options.nextId(),
      kind: "telephone.callback.outcome",
      occurredAt,
      summary: `Callback attempt ${projection.session.attempt} reached an authorized human.`,
    });
    const authorized = appendEvent(answered, {
      details: { telephoneSessionId: snapshot.telephoneSessionId },
      id: options.nextId(),
      kind: "telephone.session.authorized",
      occurredAt,
      summary: "Human detection and DTMF 1 authorized the Telephone Session.",
    });
    return {
      projection: {
        ...authorized,
        session: {
          attempt: authorized.session.attempt,
          authorizedAt: occurredAt,
          id: authorized.session.id,
          outcome: "authorized" as const,
        },
        task: {
          ...authorized.task,
          conclusion: "Telephone Session authorized." as const,
          status: "completed" as const,
          updatedAt: occurredAt,
        },
      },
      result: {
        actions: [
          {
            effectId: options.nextId(),
            kind: "play-confirmation" as const,
            text: confirmation,
          },
        ],
      },
      snapshot: {
        ...snapshot,
        revision: snapshot.revision + 1,
        state: "authorized" as const,
      },
    };
  }

  function rejectionTransition(
    snapshot: CallbackHandshakeSnapshot,
    projection: TelephoneSessionEvidenceRecordProjection,
    attempt: 1 | 2,
    reason:
      | "bad-dtmf"
      | "caller-speech"
      | "duplicate"
      | "machine-not-human"
      | "out-of-order",
  ) {
    const occurredAt = options.now();
    const rejected = appendEvent(projection, {
      details: { attempt, reason },
      id: options.nextId(),
      kind: "telephone.authorization.rejected",
      occurredAt,
      summary: "A provider event did not authorize the Telephone Session.",
    });
    return {
      projection: updateProjection(rejected, occurredAt),
      result: { actions: [] },
      snapshot: { ...snapshot, revision: snapshot.revision + 1 },
    };
  }

  function endedTransition(
    snapshot: CallbackHandshakeSnapshot,
    projection: TelephoneSessionEvidenceRecordProjection,
    event: Extract<CallbackProviderEvent, { kind: "ended" }>,
  ) {
    const occurredAt = options.now();
    const ended = appendEvent(projection, {
      details: {
        attempt: event.attempt,
        outcome: event.outcome,
        providerCorrelation: fingerprint(event.providerCallId),
      },
      id: options.nextId(),
      kind: "telephone.callback.outcome",
      occurredAt,
      summary: `Callback attempt ${event.attempt} ended without authorization.`,
    });
    if (event.attempt === 1 && event.outcome === "unanswered") {
      const dueAt = new Date(new Date(occurredAt).getTime() + 30_000).toISOString();
      const scheduled = appendEvent(ended, {
        details: { attempt: 1, dueAt, nextAttempt: 2 },
        id: options.nextId(),
        kind: "telephone.retry.scheduled",
        occurredAt,
        summary: "One callback retry was scheduled after 30 seconds.",
      });
      return {
        projection: {
          ...updateProjection(scheduled, occurredAt),
          session: { ...scheduled.session, retryDueAt: dueAt },
        },
        result: { actions: [] },
        snapshot: {
          ...snapshot,
          retryDueAt: dueAt,
          revision: snapshot.revision + 1,
          state: "retry-scheduled" as const,
        },
      };
    }
    return failHandshake(
      snapshot,
      ended,
      event.attempt,
      "out-of-order",
      event.outcome,
      fingerprint(event.providerCallId),
    );
  }

  function failHandshake(
    snapshot: CallbackHandshakeSnapshot,
    projection: TelephoneSessionEvidenceRecordProjection,
    attempt: 1 | 2,
    reason: "machine-not-human" | "out-of-order",
    outcome: "busy" | "failed" | "hangup" | "unanswered" | "voicemail",
    providerCorrelation: string,
  ) {
    const occurredAt = options.now();
    let failed = projection;
    if (outcome === "voicemail") {
      failed = appendEvent(failed, {
        details: { attempt, outcome, providerCorrelation },
        id: options.nextId(),
        kind: "telephone.callback.outcome",
        occurredAt,
        summary: "The callback reached a machine; no voicemail was left.",
      });
    }
    failed = appendEvent(failed, {
      details: { attempt, reason },
      id: options.nextId(),
      kind: "telephone.authorization.rejected",
      occurredAt,
      summary: "The callback could not authorize a Telephone Session.",
    });
    const notificationOperationId = options.nextId();
    failed = appendEvent(failed, {
      details: { operationId: notificationOperationId },
      id: options.nextId(),
      kind: "notification.requested",
      occurredAt,
      summary: "A generic Silent Notification was requested.",
    });
    return {
      projection: {
        ...failed,
        session: {
          attempt,
          id: failed.session.id,
          outcome: "failed" as const,
        },
        task: {
          ...failed.task,
          conclusion: "Callback Handshake failed." as const,
          status: "completed" as const,
          updatedAt: occurredAt,
        },
      },
      result: {
        actions: [
          {
            effectId: options.nextId(),
            kind: "end-call" as const,
            voicemailSafe: true as const,
          },
          {
            effectId: notificationOperationId,
            evidenceRecordId: snapshot.id,
            kind: "request-silent-notification" as const,
          },
        ],
      },
      snapshot: {
        ...snapshot,
        retryDueAt: undefined,
        revision: snapshot.revision + 1,
        state: "failed" as const,
      },
    };
  }

  async function processDueRetries() {
    const now = options.now();
    const due = await options.store.findDueRetries(now);
    const results: Array<{
      readonly handshakeId: string;
      readonly result: CallbackActionResult;
    }> = [];
    for (const original of due) {
      const projection = await options.store.findEvidenceRecord(original.id);
      const registration = await options.store.findRegisteredTelephoneRevision(
        original.registrationRevision,
      );
      if (projection === undefined || registration === undefined) continue;
      const eventId = options.nextId();
      const effectId = options.nextId();
      const operationId = options.nextId();
      const nextProjection = appendEvent(projection, {
        details: { attempt: 2, operationId },
        id: eventId,
        kind: "telephone.callback.requested",
        occurredAt: now,
        summary: "Callback attempt 2 was requested through the registered route.",
      });
      const nextSnapshot: CallbackHandshakeSnapshot = {
        ...original,
        callbackOperationId: operationId,
        callbackParticipantIdentity: operationId,
        humanDetected: false,
        receivedDtmfOne: false,
        retryDueAt: undefined,
        revision: original.revision + 1,
        state: "awaiting-machine",
      };
      const result = {
        actions: [
          placeCallbackAction({
            attempt: 2,
            effectId,
            handshakeId: original.id,
            participantIdentity: operationId,
            registration,
          }),
        ],
      };
      const applied = await options.store.applyTransition({
        deliveryId: `retry:${original.id}:2`,
        expectedRevision: original.revision,
        projection: {
          ...updateProjection(nextProjection, now),
          session: {
            attempt: 2,
            id: nextProjection.session.id,
            outcome: "pending",
          },
        },
        result,
        snapshot: nextSnapshot,
      });
      if (applied.kind === "applied") {
        results.push({
          handshakeId: original.id,
          result: callbackActionResultSchema.parse(applied.result),
        });
      }
    }
    return results;
  }

  return {
    appendTelephoneSessionEvidence: (handshakeId, event) =>
      options.store.appendEvidence({
        event,
        handshakeId,
        updatedAt: event.occurredAt,
      }),
    close: () => options.store.close(),
    findRegisteredTelephone: () => options.store.findRegisteredTelephone(),
    listEvidenceRecords: () => options.store.listEvidenceRecords(),
    processDueRetries,
    readEvidenceRecord: (handshakeId) =>
      options.store.findEvidenceRecord(handshakeId),
    readOperationalMetrics: () => options.store.readOperationalMetrics(),
    requestTelephoneSessionFailureNotification: (handshakeId, input) => {
      const correlation = fingerprint(input.failureEventId);
      return options.store.appendEvidence({
        event: {
          details: { operationId: `notification-operation:${correlation}` },
          id: `notification:${correlation}`,
          kind: "notification.requested",
          occurredAt: input.occurredAt,
          summary: "A generic Silent Notification was requested.",
        },
        handshakeId,
        updatedAt: input.occurredAt,
      });
    },
    receiveInbound,
    receiveProviderEvent,
    registerTelephone(input) {
      return options.store.registerTelephone(
        registeredTelephoneInputSchema.parse(input),
        options.now(),
      );
    },
  };
}

function rejectedInboundResult(): InboundTelephoneResult {
  return { actions: [], disposition: "reject" };
}

function suppressDuplicateCallback(
  result: InboundTelephoneResult,
): InboundTelephoneResult {
  return inboundTelephoneResultSchema.parse({
    ...result,
    actions: result.actions.filter(
      (action) => action.kind === "play-inbound-notice-and-end",
    ),
  });
}

function isAcceptedInbound(
  event: InboundTelephoneEvent,
  registration: RegisteredTelephone | undefined,
): registration is RegisteredTelephone {
  return (
    registration !== undefined &&
    e164TelephoneNumberSchema.safeParse(event.callerNumber).success &&
    e164TelephoneNumberSchema.safeParse(event.calledNumber).success &&
    event.callerNumber === registration.telephoneNumber &&
    event.calledNumber === registration.telnyxNumber &&
    event.inboundTrunkId === registration.livekitInboundTrunkId
  );
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function latestProviderCorrelation(
  projection: TelephoneSessionEvidenceRecordProjection,
): string {
  for (let index = projection.evidence.length - 1; index >= 0; index -= 1) {
    const event = projection.evidence[index];
    if (
      event?.kind === "telephone.dtmf.received" ||
      event?.kind === "telephone.machine.detected"
    ) {
      return event.details.providerCorrelation;
    }
  }
  throw new Error("Authorized callback has no provider correlation");
}

function placeCallbackAction(input: {
  readonly attempt: 1 | 2;
  readonly effectId: string;
  readonly handshakeId: string;
  readonly participantIdentity: string;
  readonly registration: RegisteredTelephone;
}): Extract<CallbackAction, { kind: "place-callback" }> {
  return {
    attempt: input.attempt,
    destination: input.registration.telephoneNumber,
    effectId: input.effectId,
    from: input.registration.telnyxNumber,
    kind: "place-callback",
    livekitOutboundTrunkId: input.registration.livekitOutboundTrunkId,
    participantIdentity: input.participantIdentity,
    roomName: `callback-handshake-${input.handshakeId}`,
  };
}

function appendEvent(
  projection: TelephoneSessionEvidenceRecordProjection,
  event: Omit<TelephoneEvidenceEvent, "sequence">,
): TelephoneSessionEvidenceRecordProjection {
  return {
    ...projection,
    evidence: [
      ...projection.evidence,
      { ...event, sequence: projection.evidence.length + 1 } as TelephoneEvidenceEvent,
    ],
  };
}

function updateProjection(
  projection: TelephoneSessionEvidenceRecordProjection,
  updatedAt: string,
): TelephoneSessionEvidenceRecordProjection {
  return {
    ...projection,
    task: { ...projection.task, updatedAt },
  };
}
