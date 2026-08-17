import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();

export const completionCallbackRequestedEvidenceEventSchema = z.object({
  details: z.object({
    operationId: identifierSchema,
    telephoneSessionId: identifierSchema,
  }),
  id: identifierSchema,
  kind: z.literal("completion.callback.requested"),
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
});

export const completionCallbackOutcomeEvidenceEventSchema = z.object({
  details: z.object({
    humanDetected: z.boolean(),
    operationId: identifierSchema,
    outcome: z.enum(["authorized", "failed", "unanswered", "voicemail"]),
    receivedDtmfOne: z.boolean(),
    resumedTelephoneSessionId: identifierSchema.optional(),
  }),
  id: identifierSchema,
  kind: z.literal("completion.callback.outcome"),
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
});

export const notificationRequestedEvidenceEventSchema = z.object({
  details: z.object({ operationId: identifierSchema }),
  id: identifierSchema,
  kind: z.literal("notification.requested"),
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
});

export const notificationSentEvidenceEventSchema = z.object({
  details: z.object({ operationId: identifierSchema }),
  id: identifierSchema,
  kind: z.literal("notification.sent"),
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
});

export const taskCancellationRequestedEvidenceEventSchema = z.object({
  details: z.object({ operationId: identifierSchema }),
  id: identifierSchema,
  kind: z.literal("task.cancellation.requested"),
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
});

export const taskCancelledEvidenceEventSchema = z.object({
  details: z.object({}),
  id: identifierSchema,
  kind: z.literal("task.cancelled"),
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
});

export const completionReportOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    destination: z.string().regex(/^\+[1-9]\d{7,14}$/u),
    effectId: identifierSchema,
    from: z.string().regex(/^\+[1-9]\d{7,14}$/u),
    kind: z.literal("place-completion-callback"),
    livekitOutboundTrunkId: identifierSchema,
    operationId: identifierSchema,
    taskId: identifierSchema,
    telephoneSessionId: identifierSchema,
  }),
  z.object({
    callbackOperationId: identifierSchema,
    effectId: identifierSchema,
    kind: z.literal("resume-completion-callback"),
    operationId: identifierSchema,
    taskId: identifierSchema,
    telephoneSessionId: identifierSchema,
  }),
  z.object({
    clickTracking: z.literal(false),
    evidenceRecordUrl: z.url(),
    from: z.string().min(3).max(200),
    idempotencyKey: identifierSchema,
    kind: z.literal("send-silent-notification"),
    openTracking: z.literal(false),
    operationId: identifierSchema,
    subject: z.literal("Voice Agent task update"),
    taskId: identifierSchema,
    text: z.string().min(1).max(500),
    to: z.email(),
  }),
]);
export type CompletionReportOperation = z.infer<
  typeof completionReportOperationSchema
>;

export const completionCallbackRequestResultSchema = z.object({
  disposition: z.literal("disconnect"),
  text: z.literal(
    "I’ll keep working and call your registered telephone once this task finishes.",
  ),
});
export type CompletionCallbackRequestResult = z.infer<
  typeof completionCallbackRequestResultSchema
>;

export const completionCallbackProviderEventSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      authentication: z.object({
        answer: z.literal("human"),
        digit: z.literal("1"),
      }),
      deliveryId: identifierSchema,
      operationId: identifierSchema,
      outcome: z.literal("authorized"),
    }),
    z.object({
      authentication: z
        .object({
          answer: z.literal("human"),
          digit: z.string().length(1).optional(),
        })
        .optional(),
      deliveryId: identifierSchema,
      operationId: identifierSchema,
      outcome: z.literal("failed"),
    }),
    z.object({
      deliveryId: identifierSchema,
      operationId: identifierSchema,
      outcome: z.enum(["unanswered", "voicemail"]),
    }),
  ],
);
export type CompletionCallbackProviderEvent = z.infer<
  typeof completionCallbackProviderEventSchema
>;

export const completionProviderActionResultSchema = z.object({
  actions: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        effectId: z.string().min(1).max(200),
        kind: z.literal("play-completion-voicemail-and-end"),
        text: z.literal(
          "Your Voice Agent task has finished. Open the secure app for details.",
        ),
      }),
      z.object({
        effectId: z.string().min(1).max(200),
        kind: z.literal("resume-existing-task"),
        taskId: identifierSchema,
        telephoneSessionId: identifierSchema,
      }),
    ]),
  ).max(1),
});
export type CompletionProviderActionResult = z.infer<
  typeof completionProviderActionResultSchema
>;

export const notificationPreferenceInputSchema = z
  .object({
    email: z.email(),
    from: z.string().min(3).max(200),
    notificationSubdomain: z.string().regex(/^[a-z0-9.-]+$/u),
  })
  .strict();
export type NotificationPreferenceInput = z.infer<
  typeof notificationPreferenceInputSchema
>;

export const notificationPreferenceSchema = notificationPreferenceInputSchema.extend({
  clickTracking: z.literal(false),
  configuredAt: timestampSchema,
  openTracking: z.literal(false),
  revision: z.number().int().positive(),
});
export type NotificationPreference = z.infer<
  typeof notificationPreferenceSchema
>;
export const notificationPreferenceStatusSchema = z.object({
  preference: notificationPreferenceSchema.nullable(),
});

export const updateNotificationPreferenceRequestSchema =
  notificationPreferenceInputSchema.extend({
    csrfToken: z.string().min(16).max(200),
  });

export const stopTaskRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    requestId: identifierSchema,
  })
  .strict();

export const applyEvidenceRetentionRequestSchema = z
  .object({ csrfToken: z.string().min(16).max(200) })
  .strict();
export const evidenceRetentionResultSchema = z.object({ cutoff: timestampSchema });
