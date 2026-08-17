import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const deliveryIdentifierSchema = z.string().min(1).max(80);
const turnIdentifierSchema = z.string().min(1).max(80);
const timestampSchema = z.iso.datetime();
const providerNameSchema = z.string().min(1).max(80);
const durationSchema = z.number().int().nonnegative().max(120_000);

const telephoneEvidenceFields = {
  id: identifierSchema,
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
};

export const telephoneTurnFinalizedEvidenceEventSchema = z.object({
  ...telephoneEvidenceFields,
  details: z.object({
    telephoneSessionId: identifierSchema,
    text: z.string().min(1).max(500),
    turnId: turnIdentifierSchema,
  }),
  kind: z.literal("telephone.turn.finalized"),
});

export const telephoneProviderTimingEvidenceEventSchema = z.object({
  ...telephoneEvidenceFields,
  details: z.object({
    durationMs: durationSchema,
    outcome: z.literal("completed"),
    provider: providerNameSchema,
    stage: z.enum(["stt", "coordinator", "tts"]),
  }),
  kind: z.literal("telephone.provider.timing"),
});

export const telephoneSemanticResponseEvidenceEventSchema = z.object({
  ...telephoneEvidenceFields,
  details: z.object({
    responseId: identifierSchema,
    text: z.string().min(1).max(1_000),
  }),
  kind: z.literal("telephone.semantic.response"),
});

export const telephoneResponseInterruptedEvidenceEventSchema = z.object({
  ...telephoneEvidenceFields,
  details: z.object({
    durationMs: durationSchema,
    responseId: identifierSchema,
  }),
  kind: z.literal("telephone.response.interrupted"),
});

export const telephoneProviderFailureEvidenceEventSchema = z.object({
  ...telephoneEvidenceFields,
  details: z.discriminatedUnion("failure", [
    z.object({
      failure: z.literal("timeout"),
      provider: providerNameSchema,
      stage: z.enum(["stt", "coordinator", "tts"]),
      timeoutMs: durationSchema,
    }),
    z.object({
      failure: z.literal("unavailable"),
      provider: providerNameSchema,
      stage: z.enum(["stt", "coordinator", "tts"]),
    }),
  ]),
  kind: z.literal("telephone.provider.failure"),
});

export const telephoneConversationEvidenceEventSchema = z.discriminatedUnion(
  "kind",
  [
    telephoneTurnFinalizedEvidenceEventSchema,
    telephoneProviderTimingEvidenceEventSchema,
    telephoneSemanticResponseEvidenceEventSchema,
    telephoneResponseInterruptedEvidenceEventSchema,
    telephoneProviderFailureEvidenceEventSchema,
  ],
);
export type TelephoneConversationEvidenceEvent = z.infer<
  typeof telephoneConversationEvidenceEventSchema
>;

export const finalizedTelephoneTurnSchema = z
  .object({
    deliveryId: deliveryIdentifierSchema,
    kind: z.literal("turn-finalized"),
    occurredAt: timestampSchema,
    stt: z.object({
      durationMs: durationSchema,
      provider: providerNameSchema,
    }),
    telephoneSessionId: identifierSchema,
    transcript: z.string().min(1).max(2_000),
    turnId: turnIdentifierSchema,
  })
  .strict();
export type FinalizedTelephoneTurn = z.infer<
  typeof finalizedTelephoneTurnSchema
>;

export const telephoneSpeechHypothesisSchema = z
  .object({
    deliveryId: deliveryIdentifierSchema,
    kind: z.literal("speech-hypothesis"),
    occurredAt: timestampSchema,
    telephoneSessionId: identifierSchema,
    transcript: z.string().min(1).max(2_000),
  })
  .strict();

export const telephoneResponseInterruptedProviderEventSchema = z
  .object({
    deliveryId: deliveryIdentifierSchema,
    durationMs: durationSchema,
    kind: z.literal("response-interrupted"),
    occurredAt: timestampSchema,
    responseId: identifierSchema,
    taskId: identifierSchema.optional(),
  })
  .strict();

export const telephoneProviderTimingEventSchema = z
  .object({
    deliveryId: deliveryIdentifierSchema,
    durationMs: durationSchema,
    kind: z.literal("provider-timing"),
    occurredAt: timestampSchema,
    provider: providerNameSchema,
    stage: z.enum(["stt", "coordinator", "tts"]),
    taskId: identifierSchema.optional(),
  })
  .strict();

export const telephoneProviderTimeoutEventSchema = z
  .object({
    deliveryId: deliveryIdentifierSchema,
    kind: z.literal("provider-timeout"),
    occurredAt: timestampSchema,
    provider: providerNameSchema,
    stage: z.enum(["stt", "coordinator", "tts"]),
    taskId: identifierSchema.optional(),
    timeoutMs: durationSchema,
  })
  .strict();

export const telephoneProviderFailureEventSchema = z
  .object({
    deliveryId: deliveryIdentifierSchema,
    failure: z.literal("unavailable"),
    kind: z.literal("provider-failure"),
    occurredAt: timestampSchema,
    provider: providerNameSchema,
    stage: z.enum(["stt", "coordinator", "tts"]),
    taskId: identifierSchema.optional(),
  })
  .strict();

export const telephoneTurnInterpretationSchema = z.object({
  durationMs: durationSchema,
  intent: z.enum(["bountywell-health", "state-changing", "unrelated"]),
  provider: providerNameSchema,
});
export type TelephoneTurnInterpretation = z.infer<
  typeof telephoneTurnInterpretationSchema
>;

export const telephoneSessionProviderEventSchema = z.discriminatedUnion(
  "kind",
  [
    finalizedTelephoneTurnSchema,
    telephoneSpeechHypothesisSchema,
    telephoneResponseInterruptedProviderEventSchema,
    telephoneProviderTimingEventSchema,
    telephoneProviderTimeoutEventSchema,
    telephoneProviderFailureEventSchema,
  ],
);
export type TelephoneSessionProviderEvent = z.infer<
  typeof telephoneSessionProviderEventSchema
>;

const speakSemanticResponseActionSchema = z.object({
  interruptible: z.literal(true),
  kind: z.literal("speak-semantic-response"),
  responseId: identifierSchema,
  taskId: identifierSchema,
  text: z.string().min(1).max(1_000),
});
const speakGuidanceActionSchema = z.object({
  interruptible: z.literal(true),
  kind: z.literal("speak-guidance"),
  responseId: identifierSchema,
  text: z.string().min(1).max(1_000),
});
const requestTaskConfirmationActionSchema = z.object({
  confirmationId: identifierSchema,
  interruptible: z.literal(true),
  kind: z.literal("request-task-confirmation"),
  text: z.string().min(1).max(1_000),
});
const playPrerecordedFailureActionSchema = z.object({
  interruptible: z.literal(false),
  kind: z.literal("play-prerecorded-failure-and-end"),
  taskId: identifierSchema.optional(),
  text: z.literal(
    "The voice service is temporarily unavailable. Please check the Evidence Record.",
  ),
});
export const telephoneSessionActionSchema = z.discriminatedUnion("kind", [
  speakSemanticResponseActionSchema,
  speakGuidanceActionSchema,
  requestTaskConfirmationActionSchema,
  playPrerecordedFailureActionSchema,
]);
export type TelephoneSessionAction = z.infer<
  typeof telephoneSessionActionSchema
>;

export const telephoneSessionActionResultSchema = z.object({
  actions: z.array(telephoneSessionActionSchema).max(2),
});
export type TelephoneSessionActionResult = z.infer<
  typeof telephoneSessionActionResultSchema
>;
