import { z } from "zod";
import {
  promotionEvidenceRecordProjectionSchema,
  type PromotionEvidenceRecordProjection,
} from "./promotion.ts";
import {
  telephoneSessionEvidenceRecordProjectionSchema,
  type TelephoneSessionEvidenceRecordProjection,
} from "./callback-handshake.ts";
import {
  telephoneProviderFailureEvidenceEventSchema,
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
import {
  completionCallbackOutcomeEvidenceEventSchema,
  completionCallbackRequestedEvidenceEventSchema,
  notificationRequestedEvidenceEventSchema,
  notificationSentEvidenceEventSchema,
  taskCancellationRequestedEvidenceEventSchema,
  taskCancelledEvidenceEventSchema,
} from "./task-continuity.ts";
import {
  bountywellDiagnosisRecordedEvidenceEventSchema,
  bountywellFaultReportedEvidenceEventSchema,
  bountywellOutageTaskSchema,
  bountywellPolicyDecidedEvidenceEventSchema,
  bountywellRestartCapabilitiesSchema,
  bountywellTimerLifecycleEvidenceEventSchema,
} from "./bountywell-outage.ts";
import {
  keeploreOnboardingEvidenceRecordProjectionSchema,
  keeploreOnboardingTaskSchema,
  type KeeploreOnboardingEvidenceRecordProjection,
} from "./keeplore-onboarding.ts";

export * from "./promotion.ts";
export * from "./callback-handshake.ts";
export * from "./telephone-session.ts";
export * from "./telephone-boundaries.ts";
export * from "./task-continuity.ts";
export * from "./bountywell-outage.ts";
export * from "./keeplore-onboarding.ts";
export * from "./keeplore-promotion-journal.ts";

export const originSecurityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
} as const;

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();

export const bountywellReadCapabilitiesSchema = z.tuple([
  z.literal("bountywell.public-health.read"),
  z.literal("bountywell.authentication-boundary.read"),
  z.literal("bountywell.local-health.read"),
  z.literal("bountywell.service-metadata.read"),
  z.literal("bountywell.resource-evidence.read"),
]);

export const bountywellCapabilitiesSchema = z.union([
  bountywellReadCapabilitiesSchema,
  bountywellRestartCapabilitiesSchema,
]);

export const bountywellRegistrationSchema = z.object({
  applicationId: z.literal("bountywell-production"),
  capabilities: bountywellCapabilitiesSchema,
  healthSemantics: z.object({
    authenticationBoundary: z.object({
      expectedStatus: z.literal(401),
      path: z.literal("/api/data"),
    }),
    primary: z.object({
      expectedStatus: z.literal(200),
      path: z.literal("/api/health"),
    }),
    registeredLocal: z.object({
      expectedStatus: z.literal(200),
      path: z.literal("/api/health"),
      port: z.literal(3000),
    }),
  }),
  publicOrigin: z.literal("https://bountywell.com"),
  registeredAt: timestampSchema,
  revision: z.number().int().positive(),
  serviceUnit: z.literal("bountywell-api.service"),
});

export type BountywellRegistration = z.infer<
  typeof bountywellRegistrationSchema
>;

export const bountywellHealthInquiryRequestSchema = z.object({
  question: z.string().min(1).max(240),
  requestId: identifierSchema,
});

export const registerBountywellRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
  })
  .strict();

export const submitBountywellHealthRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    requestId: identifierSchema,
  })
  .strict();

export const bountywellRegistrationStatusSchema = z.object({
  registration: bountywellRegistrationSchema.nullable(),
});

export const bountywellHealthInquirySchema =
  bountywellHealthInquiryRequestSchema.extend({
    question: z.literal("Is Bountywell healthy?"),
  });

export type BountywellHealthInquiryRequest = z.infer<
  typeof bountywellHealthInquiryRequestSchema
>;
export type BountywellHealthInquiry = z.infer<
  typeof bountywellHealthInquirySchema
>;

const checkFields = {
  outcome: z.enum(["pass", "fail"]),
  provenance: z.string().min(1).max(120).optional(),
  summary: z.string().max(240),
};

export const bountywellHealthCheckSchema = z.discriminatedUnion("source", [
  z.object({
    ...checkFields,
    facts: z.object({ statusCode: z.number().int().min(100).max(599) }),
    source: z.literal("public-health"),
  }),
  z.object({
    ...checkFields,
    facts: z.object({ statusCode: z.number().int().min(100).max(599) }),
    source: z.literal("authentication-boundary"),
  }),
  z.object({
    ...checkFields,
    facts: z.object({ statusCode: z.number().int().min(100).max(599) }),
    source: z.literal("local-health"),
  }),
  z.object({
    ...checkFields,
    facts: z.object({
      active: z.boolean(),
      subState: z.enum(["running", "not-running", "unavailable"]).optional(),
    }),
    source: z.literal("service-state"),
  }),
  z.object({
    ...checkFields,
    facts: z.discriminatedUnion("availability", [
      z.object({
        availability: z.literal("available"),
        diskPressure: z.boolean().optional(),
        memoryPressure: z.boolean().optional(),
        taskPressure: z.boolean().optional(),
      }),
      z.object({ availability: z.literal("unavailable") }),
    ]),
    source: z.literal("resource-health"),
  }),
]);

export const bountywellHealthObservationSchema = z.object({
  checks: z.array(bountywellHealthCheckSchema).min(1).max(8),
  observedAt: timestampSchema,
  rejectedEvidenceCount: z.number().int().nonnegative(),
  uncertainty: z.string().min(1).max(300).optional(),
});

export type BountywellHealthObservation = z.infer<
  typeof bountywellHealthObservationSchema
>;

export const bountywellHealthObservationRequestSchema = z.object({
  operationId: identifierSchema,
  taskId: identifierSchema,
}).strict();

export type BountywellHealthObservationRequest = z.infer<
  typeof bountywellHealthObservationRequestSchema
>;

export interface BountywellHealthObserver {
  observe(
    request: BountywellHealthObservationRequest,
  ): Promise<BountywellHealthObservation>;
}

const eventFields = {
  id: identifierSchema,
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().max(240),
};

export const evidenceEventProjectionSchema = z.discriminatedUnion("kind", [
  telephoneAudioDebugCleanedEvidenceEventSchema,
  telephoneAudioDebugEnabledEvidenceEventSchema,
  telephoneAudioDebugRevokedEvidenceEventSchema,
  telephoneSessionEndedEvidenceEventSchema,
  telephoneSpendingWarningEvidenceEventSchema,
  telephoneUsageRecordedEvidenceEventSchema,
  telephoneTurnFinalizedEvidenceEventSchema,
  telephoneProviderTimingEvidenceEventSchema,
  telephoneProviderFailureEvidenceEventSchema,
  telephoneResponseInterruptedEvidenceEventSchema,
  completionCallbackRequestedEvidenceEventSchema,
  completionCallbackOutcomeEvidenceEventSchema,
  notificationRequestedEvidenceEventSchema,
  notificationSentEvidenceEventSchema,
  taskCancellationRequestedEvidenceEventSchema,
  taskCancelledEvidenceEventSchema,
  z.object({
    ...eventFields,
    details: z.object({ requestId: identifierSchema }),
    kind: z.literal("task.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ operationId: identifierSchema }),
    kind: z.literal("operation.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      checks: z.array(bountywellHealthCheckSchema).min(1).max(8),
      rejectedEvidenceCount: z.number().int().nonnegative(),
      uncertainty: z.string().min(1).max(300).optional(),
    }),
    kind: z.literal("evidence.observed"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ operationId: identifierSchema }),
    kind: z.literal("operation.completed"),
  }),
  z.object({
    ...eventFields,
    details: z.object({}),
    kind: z.literal("task.completed"),
  }),
  bountywellFaultReportedEvidenceEventSchema,
  bountywellDiagnosisRecordedEvidenceEventSchema,
  bountywellPolicyDecidedEvidenceEventSchema,
  bountywellTimerLifecycleEvidenceEventSchema,
  telephoneSemanticResponseEvidenceEventSchema,
]);

export type EvidenceEventProjection = z.infer<
  typeof evidenceEventProjectionSchema
>;

export const bountywellHealthTaskConclusionSchema = z.enum([
  "Bountywell inquiry is pending.",
  "Bountywell API is healthy.",
  "Bountywell API health could not be confirmed.",
  "Bountywell inquiry cancelled.",
]);
export type BountywellHealthTaskConclusion = z.infer<
  typeof bountywellHealthTaskConclusionSchema
>;

export const bountywellHealthTaskSchema = z.object({
  conclusion: bountywellHealthTaskConclusionSchema,
  createdAt: timestampSchema,
  id: identifierSchema,
  kind: z.literal("bountywell.health.inquiry"),
  question: z.literal("Is Bountywell healthy?"),
  status: z.enum(["pending", "completed", "cancelled"]),
  updatedAt: timestampSchema,
});

export const bountywellTaskSchema = z.discriminatedUnion("kind", [
  bountywellHealthTaskSchema,
  bountywellOutageTaskSchema,
]);

export const evidenceRecordProjectionSchema = z.object({
  evidence: z.array(evidenceEventProjectionSchema).max(100),
  task: bountywellTaskSchema,
});

export type EvidenceRecordProjection = z.infer<
  typeof evidenceRecordProjectionSchema
>;

export type VoiceAgentEvidenceRecordProjection =
  | EvidenceRecordProjection
  | KeeploreOnboardingEvidenceRecordProjection
  | PromotionEvidenceRecordProjection
  | TelephoneSessionEvidenceRecordProjection;

export const voiceAgentEvidenceRecordProjectionSchema = z.union([
  evidenceRecordProjectionSchema,
  keeploreOnboardingEvidenceRecordProjectionSchema,
  promotionEvidenceRecordProjectionSchema,
  telephoneSessionEvidenceRecordProjectionSchema,
]);

export const evidenceRecordSummarySchema = z.discriminatedUnion("kind", [
  bountywellHealthTaskSchema,
  bountywellOutageTaskSchema,
  keeploreOnboardingTaskSchema,
  promotionEvidenceRecordProjectionSchema.shape.task,
  telephoneSessionEvidenceRecordProjectionSchema.shape.task,
]);
export const evidenceRecordSummaryListSchema = z.array(evidenceRecordSummarySchema).max(100);
export type EvidenceRecordSummary = z.infer<typeof evidenceRecordSummarySchema>;

export const authenticationStatusSchema = z.object({
  bootstrapAvailable: z.boolean(),
  passkeyCount: z.number().int().nonnegative(),
  setup: z.enum([
    "bootstrap-required",
    "second-passkey-required",
    "recovery-confirmation-required",
    "ready",
  ]),
  unattendedAuthorityEnabled: z.boolean(),
});
export type AuthenticationStatus = z.infer<typeof authenticationStatusSchema>;

export const bootstrapRegistrationOptionsRequestSchema = z.object({
  bootstrapCode: z.string().min(8).max(120),
  label: z.string().min(1).max(80),
  mode: z.literal("bootstrap"),
});
export const recoveryRegistrationOptionsRequestSchema = z.object({
  csrfToken: z.string().min(16).max(200),
  label: z.string().min(1).max(80),
  mode: z.literal("recovery"),
});
export const registrationOptionsRequestSchema = z.discriminatedUnion("mode", [
  bootstrapRegistrationOptionsRequestSchema,
  recoveryRegistrationOptionsRequestSchema,
]);
export const passkeyResponseRequestSchema = z.object({ response: z.unknown() });
export const passkeyAuthenticationResponseRequestSchema = z.object({
  ceremonyId: z.string().min(16).max(200),
  response: z.unknown(),
});
export const csrfRequestSchema = z.object({
  csrfToken: z.string().min(16).max(200),
});
export const recoveryRequestSchema = z.object({
  recoveryCode: z.string().min(8).max(120),
});
export const recoveryCodesConfirmationRequestSchema = z.object({
  confirmationToken: z.string().min(16).max(200),
});

export const passkeyEnrollmentResultSchema = z.object({
  recoveryCodes: z.array(z.string().min(8).max(120)).max(50),
  recoveryConfirmationToken: z.string().min(16).max(200).optional(),
  status: authenticationStatusSchema,
});
export type PasskeyEnrollmentResult = z.infer<
  typeof passkeyEnrollmentResultSchema
>;
export const trustedBrowserSessionResponseSchema = z.object({
  csrfToken: z.string().min(16).max(200),
  expiresAt: timestampSchema,
  freshUntil: timestampSchema.optional(),
});
export type TrustedBrowserSessionResponse = z.infer<
  typeof trustedBrowserSessionResponseSchema
>;
export const recoverySessionResponseSchema = z.object({
  csrfToken: z.string().min(16).max(200),
  expiresAt: timestampSchema,
});
export type RecoverySessionResponse = z.infer<
  typeof recoverySessionResponseSchema
>;
export const freshPasskeyActionResponseSchema = z.object({
  freshUntil: timestampSchema,
});
export const promotionResumeResponseSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  status: z.literal("queued"),
});
export const webAuthnOptionsSchema = z.looseObject({
  challenge: z.string().min(1),
});
