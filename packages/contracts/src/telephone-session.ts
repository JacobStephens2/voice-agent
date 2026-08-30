import { z } from "zod";

import type { RecognizedSpeechModel } from "./recognized-speech-model.ts";
import type { ConfiguredSpeechSynthesis } from "./recognized-synthesis-model.ts";

const identifierSchema = z.string().min(1).max(120);
const deliveryIdentifierSchema = z.string().min(1).max(80);
const turnIdentifierSchema = z.string().min(1).max(80);
const timestampSchema = z.iso.datetime();
const providerNameSchema = z.string().min(1).max(80);
/**
 * The Recognized Speech Model in use at a speech stage. Optional because only
 * the stages this system configures a model for carry one, and because
 * evidence recorded before the setting existed has none.
 */
const speechModelSchema = z.string().min(1).max(120).optional();
const durationSchema = z.number().int().nonnegative().max(120_000);
export const telephoneSpeechProviderStages = [
  "stt",
  "coordinator",
  "tts",
] as const;
export type TelephoneSpeechProviderStage =
  (typeof telephoneSpeechProviderStages)[number];
export const telephoneProviderFailureStages = [
  ...telephoneSpeechProviderStages,
  "setup",
  // The Voice Agent's own turn pipeline: a fault raised here is this system's,
  // not a speech or interpretation provider's.
  "agent",
] as const;
export type TelephoneProviderFailureStage =
  (typeof telephoneProviderFailureStages)[number];
const providerStageSchema = z.enum(telephoneSpeechProviderStages);
const providerFailureStageSchema = z.enum(telephoneProviderFailureStages);

/**
 * The configured model identifier evidence carries for one stage: the
 * transcriber's for a recognition stage and the synthesizer's for a synthesis
 * one. A stage this system configures no speech model for carries none, because
 * naming one there would record a model against a fault it did not raise.
 *
 * Both paths that write this evidence read it from here, so a stage's model is
 * decided once rather than once per writer.
 */
export function speechStageModel(
  models: {
    readonly recognition: RecognizedSpeechModel;
    readonly synthesis: ConfiguredSpeechSynthesis;
  },
  stage: TelephoneProviderFailureStage,
): { readonly model?: string } {
  if (stage === "stt") return { model: models.recognition.model };
  if (stage === "tts") return { model: models.synthesis.model };
  return {};
}

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
    model: speechModelSchema,
    outcome: z.literal("completed"),
    provider: providerNameSchema,
    stage: providerStageSchema,
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
      model: speechModelSchema,
      provider: providerNameSchema,
      stage: providerFailureStageSchema,
      timeoutMs: durationSchema,
    }),
    z.object({
      failure: z.literal("unavailable"),
      model: speechModelSchema,
      provider: providerNameSchema,
      stage: providerFailureStageSchema,
    }),
  ]),
  kind: z.literal("telephone.provider.failure"),
});

export const telephoneProviderRetryEvidenceEventSchema = z.object({
  ...telephoneEvidenceFields,
  details: z.object({
    provider: providerNameSchema,
    stage: providerFailureStageSchema,
    turnId: turnIdentifierSchema.optional(),
  }),
  kind: z.literal("telephone.provider.retry"),
});

export const telephoneConversationEvidenceEventSchema = z.discriminatedUnion(
  "kind",
  [
    telephoneTurnFinalizedEvidenceEventSchema,
    telephoneProviderTimingEvidenceEventSchema,
    telephoneSemanticResponseEvidenceEventSchema,
    telephoneResponseInterruptedEvidenceEventSchema,
    telephoneProviderFailureEvidenceEventSchema,
    telephoneProviderRetryEvidenceEventSchema,
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
    stage: providerStageSchema,
    taskId: identifierSchema.optional(),
  })
  .strict();

/**
 * Whether the reporting adapter still has something to replay. `terminal` marks
 * a fault the Telephone Session cannot recover from — an unusable session or a
 * failed start — so it never spends the session's single bounded retry.
 */
export const telephoneProviderFailureRecoveries = [
  "retryable",
  "terminal",
] as const;
export type TelephoneProviderFailureRecovery =
  (typeof telephoneProviderFailureRecoveries)[number];
const providerFailureRecoverySchema = z
  .enum(telephoneProviderFailureRecoveries)
  .optional();

export const telephoneProviderTimeoutEventSchema = z
  .object({
    deliveryId: deliveryIdentifierSchema,
    kind: z.literal("provider-timeout"),
    occurredAt: timestampSchema,
    provider: providerNameSchema,
    recovery: providerFailureRecoverySchema,
    stage: providerFailureStageSchema,
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
    recovery: providerFailureRecoverySchema,
    stage: providerFailureStageSchema,
    taskId: identifierSchema.optional(),
  })
  .strict();

export const telephoneTurnInterpretationSchema = z.object({
  durationMs: durationSchema,
  intent: z.enum(["bountywell-health", "state-changing", "stop", "unrelated"]),
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
const offerCompletionCallbackActionSchema = z.object({
  interruptible: z.literal(true),
  kind: z.literal("offer-completion-callback"),
  responseId: identifierSchema,
  taskId: identifierSchema,
  // The offer is spoken verbatim, so each context that may make it is pinned
  // here: background work already under way, and a Delegation whose outcome
  // will outlive the call that confirmed it.
  text: z.enum([
    "This is still running. I can disconnect and call your registered telephone when it finishes. Would you like that?",
    "The Keeplore Button Trial is confirmed and delegated to restricted Codex on a non-production branch. Nothing will be merged or deployed. I can disconnect and call your registered telephone when it finishes. Would you like that?",
  ]),
});
const requestCompletionCallbackAndDisconnectActionSchema = z.object({
  interruptible: z.literal(false),
  kind: z.literal("request-completion-callback-and-disconnect"),
  requestId: identifierSchema,
  taskId: identifierSchema,
  telephoneSessionId: identifierSchema,
});
const retryProviderTurnActionSchema = z.object({
  kind: z.literal("retry-provider-turn"),
  retryId: identifierSchema,
  stage: providerFailureStageSchema,
  taskId: identifierSchema.optional(),
  turnId: turnIdentifierSchema.optional(),
});
export const telephoneSessionActionSchema = z.discriminatedUnion("kind", [
  speakSemanticResponseActionSchema,
  speakGuidanceActionSchema,
  requestTaskConfirmationActionSchema,
  playPrerecordedFailureActionSchema,
  offerCompletionCallbackActionSchema,
  requestCompletionCallbackAndDisconnectActionSchema,
  retryProviderTurnActionSchema,
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
