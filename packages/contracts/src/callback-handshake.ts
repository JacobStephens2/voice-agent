import { z } from "zod";

import {
  telephoneProviderFailureEvidenceEventSchema,
  telephoneProviderRetryEvidenceEventSchema,
  telephoneProviderTimingEvidenceEventSchema,
  telephoneResponseInterruptedEvidenceEventSchema,
  telephoneSemanticResponseEvidenceEventSchema,
  telephoneTurnFinalizedEvidenceEventSchema,
} from "./telephone-session.ts";
import {
  telephoneAudioDebugCleanedEvidenceEventSchema,
  telephoneAudioDebugEnabledEvidenceEventSchema,
  telephoneAudioDebugRevokedEvidenceEventSchema,
  telephoneSessionEndedEvidenceEventSchema,
  telephoneSpendingWarningEvidenceEventSchema,
  telephoneUsageRecordedEvidenceEventSchema,
} from "./telephone-boundaries.ts";

const callbackIdentifierSchema = z.string().min(1).max(120);
const callbackTimestampSchema = z.iso.datetime();
export const e164TelephoneNumberSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/u);

export const registeredTelephoneInputSchema = z
  .object({
    livekitInboundTrunkId: callbackIdentifierSchema,
    livekitOutboundTrunkId: callbackIdentifierSchema,
    telephoneNumber: e164TelephoneNumberSchema,
    telnyxNumber: e164TelephoneNumberSchema,
  })
  .strict();
export type RegisteredTelephoneInput = z.infer<
  typeof registeredTelephoneInputSchema
>;

export const registeredTelephoneSchema = registeredTelephoneInputSchema.extend({
  registeredAt: callbackTimestampSchema,
  revision: z.number().int().positive(),
});
export type RegisteredTelephone = z.infer<typeof registeredTelephoneSchema>;

export const registerTelephoneRequestSchema = registeredTelephoneInputSchema
  .extend({ csrfToken: z.string().min(16).max(200) })
  .strict();

export const registeredTelephoneStatusSchema = z.object({
  registration: registeredTelephoneSchema.nullable(),
});

const sanitizedCorrelationSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/u);

const telephoneEvidenceFields = {
  id: callbackIdentifierSchema,
  occurredAt: callbackTimestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
};

export const telephoneEvidenceEventSchema = z.discriminatedUnion("kind", [
  telephoneAudioDebugCleanedEvidenceEventSchema,
  telephoneAudioDebugEnabledEvidenceEventSchema,
  telephoneAudioDebugRevokedEvidenceEventSchema,
  telephoneSessionEndedEvidenceEventSchema,
  telephoneSpendingWarningEvidenceEventSchema,
  telephoneUsageRecordedEvidenceEventSchema,
  telephoneTurnFinalizedEvidenceEventSchema,
  telephoneProviderTimingEvidenceEventSchema,
  telephoneProviderFailureEvidenceEventSchema,
  telephoneProviderRetryEvidenceEventSchema,
  telephoneResponseInterruptedEvidenceEventSchema,
  telephoneSemanticResponseEvidenceEventSchema,
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({
      callerFingerprint: sanitizedCorrelationSchema,
      providerCorrelation: sanitizedCorrelationSchema,
    }),
    kind: z.literal("telephone.inbound.received"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({}),
    kind: z.literal("telephone.inbound.notice"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({
      attempt: z.union([z.literal(1), z.literal(2)]),
      operationId: callbackIdentifierSchema,
    }),
    kind: z.literal("telephone.callback.requested"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({
      attempt: z.union([z.literal(1), z.literal(2)]),
      classification: z.enum(["human", "machine", "unknown"]),
      providerCorrelation: sanitizedCorrelationSchema,
    }),
    kind: z.literal("telephone.machine.detected"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({
      accepted: z.boolean(),
      attempt: z.union([z.literal(1), z.literal(2)]),
      digit: z.enum(["1", "other"]),
      providerCorrelation: sanitizedCorrelationSchema,
    }),
    kind: z.literal("telephone.dtmf.received"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({
      attempt: z.literal(1),
      dueAt: callbackTimestampSchema,
      nextAttempt: z.literal(2),
    }),
    kind: z.literal("telephone.retry.scheduled"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({
      attempt: z.union([z.literal(1), z.literal(2)]),
      outcome: z.enum([
        "authorized",
        "busy",
        "failed",
        "hangup",
        "unanswered",
        "voicemail",
      ]),
      providerCorrelation: sanitizedCorrelationSchema,
    }),
    kind: z.literal("telephone.callback.outcome"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({
      attempt: z.union([z.literal(1), z.literal(2)]),
      reason: z.enum([
        "bad-dtmf",
        "caller-speech",
        "duplicate",
        "machine-not-human",
        "out-of-order",
      ]),
    }),
    kind: z.literal("telephone.authorization.rejected"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({ telephoneSessionId: callbackIdentifierSchema }),
    kind: z.literal("telephone.session.authorized"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({ operationId: callbackIdentifierSchema }),
    kind: z.literal("notification.requested"),
  }),
  z.object({
    ...telephoneEvidenceFields,
    details: z.object({ operationId: callbackIdentifierSchema }),
    kind: z.literal("notification.sent"),
  }),
]);
export type TelephoneEvidenceEvent = z.infer<
  typeof telephoneEvidenceEventSchema
>;

export const telephoneSessionEvidenceRecordProjectionSchema = z.object({
  evidence: z.array(telephoneEvidenceEventSchema),
  session: z.object({
    attempt: z.union([z.literal(1), z.literal(2)]),
    authorizedAt: callbackTimestampSchema.optional(),
    durationMs: z.number().int().nonnegative().max(7_200_000).optional(),
    endedAt: callbackTimestampSchema.optional(),
    endReason: z
      .enum([
        "completed",
        "disconnected",
        "maximum-duration",
        "prolonged-silence",
        "provider-failure",
        "spending-ceiling",
      ])
      .optional(),
    id: callbackIdentifierSchema,
    outcome: z.enum(["authorized", "failed", "pending"]),
    retryDueAt: callbackTimestampSchema.optional(),
  }),
  task: z.object({
    conclusion: z.enum([
      "Callback Handshake is pending.",
      "Callback Handshake failed.",
      "Telephone Session authorized.",
    ]),
    createdAt: callbackTimestampSchema,
    id: callbackIdentifierSchema,
    kind: z.literal("callback.handshake"),
    question: z.literal("Authenticate a Telephone Session."),
    status: z.enum(["completed", "pending"]),
    updatedAt: callbackTimestampSchema,
  }),
});
export type TelephoneSessionEvidenceRecordProjection = z.infer<
  typeof telephoneSessionEvidenceRecordProjectionSchema
>;

export const telephoneEvidenceRecordSummarySchema =
  telephoneSessionEvidenceRecordProjectionSchema.shape.task;
export type TelephoneEvidenceRecordSummary = z.infer<
  typeof telephoneEvidenceRecordSummarySchema
>;

export const inboundTelephoneEventSchema = z
  .object({
    calledNumber: z.string().min(1).max(40),
    callerNumber: z.string().min(1).max(40),
    deliveryId: callbackIdentifierSchema,
    inboundTrunkId: callbackIdentifierSchema,
    providerCallId: callbackIdentifierSchema,
  })
  .strict();
export type InboundTelephoneEvent = z.infer<typeof inboundTelephoneEventSchema>;

const callbackAttemptSchema = z.union([z.literal(1), z.literal(2)]);
const providerEventFields = {
  attempt: callbackAttemptSchema,
  deliveryId: callbackIdentifierSchema,
  providerCallId: callbackIdentifierSchema,
};
export const callbackProviderEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...providerEventFields,
    classification: z.enum(["human", "machine", "unknown"]),
    kind: z.literal("machine-detection"),
  }),
  z.object({
    ...providerEventFields,
    digit: z.string().min(1).max(8),
    kind: z.literal("dtmf"),
  }),
  z.object({
    ...providerEventFields,
    kind: z.literal("speech"),
  }),
  z.object({
    ...providerEventFields,
    kind: z.literal("ended"),
    outcome: z.enum(["busy", "failed", "hangup", "unanswered"]),
  }),
]);
export type CallbackProviderEvent = z.infer<typeof callbackProviderEventSchema>;

export const callbackActionSchema = z.discriminatedUnion("kind", [
  z.object({
    effectId: callbackIdentifierSchema,
    kind: z.literal("play-inbound-notice-and-end"),
    text: z.literal("Thanks. I’ll call your registered telephone back now."),
  }),
  z.object({
    attempt: callbackAttemptSchema,
    destination: e164TelephoneNumberSchema,
    effectId: callbackIdentifierSchema,
    from: e164TelephoneNumberSchema,
    kind: z.literal("place-callback"),
    livekitOutboundTrunkId: callbackIdentifierSchema,
    participantIdentity: callbackIdentifierSchema,
    roomName: callbackIdentifierSchema,
  }),
  z.object({
    effectId: callbackIdentifierSchema,
    kind: z.literal("prompt-for-dtmf"),
    text: z.literal("Press 1 to confirm you are the registered owner."),
  }),
  z.object({
    effectId: callbackIdentifierSchema,
    kind: z.literal("play-confirmation"),
    text: z.literal("Telephone confirmed. Your secure session is ready."),
  }),
  z.object({
    effectId: callbackIdentifierSchema,
    kind: z.literal("end-call"),
    voicemailSafe: z.literal(true),
  }),
  z.object({
    evidenceRecordId: callbackIdentifierSchema,
    effectId: callbackIdentifierSchema,
    kind: z.literal("request-silent-notification"),
  }),
]);
export type CallbackAction = z.infer<typeof callbackActionSchema>;

export const callbackActionResultSchema = z.object({
  actions: z.array(callbackActionSchema).max(4),
});
export type CallbackActionResult = z.infer<typeof callbackActionResultSchema>;

export const inboundTelephoneResultSchema = callbackActionResultSchema.extend({
  disposition: z.enum(["notice-and-callback", "reject"]),
  handshakeId: callbackIdentifierSchema.optional(),
});
export type InboundTelephoneResult = z.infer<typeof inboundTelephoneResultSchema>;

export const callbackHandshakeSnapshotSchema = z.object({
  callbackOperationId: callbackIdentifierSchema,
  callbackParticipantIdentity: callbackIdentifierSchema,
  callerFingerprint: sanitizedCorrelationSchema,
  humanDetected: z.boolean(),
  id: callbackIdentifierSchema,
  receivedDtmfOne: z.boolean(),
  registrationRevision: z.number().int().positive(),
  retryDueAt: callbackTimestampSchema.optional(),
  revision: z.number().int().nonnegative(),
  state: z.enum([
    "awaiting-machine",
    "awaiting-dtmf",
    "authorized",
    "failed",
    "retry-scheduled",
  ]),
  telephoneSessionId: callbackIdentifierSchema,
});
export type CallbackHandshakeSnapshot = z.infer<
  typeof callbackHandshakeSnapshotSchema
>;
