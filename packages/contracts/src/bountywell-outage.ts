import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();

export const bountywellOutageReport =
  "Bountywell's API appears unavailable." as const;

export const bountywellServiceRestartCapabilitySchema = z.literal(
  "bountywell.service.restart",
);

export const bountywellRestartCapabilitiesSchema = z.tuple([
  z.literal("bountywell.public-health.read"),
  z.literal("bountywell.authentication-boundary.read"),
  z.literal("bountywell.local-health.read"),
  z.literal("bountywell.service-metadata.read"),
  z.literal("bountywell.resource-evidence.read"),
  bountywellServiceRestartCapabilitySchema,
]);

export const bountywellOutageTaskConclusionSchema = z.enum([
  "Bountywell outage recovery is pending.",
  "Bountywell API was recovered.",
  "Bountywell API was already recovered.",
  "Bountywell API recovery could not be confirmed.",
  "Bountywell outage recovery was cancelled.",
]);

export const bountywellOutageTaskSchema = z.object({
  conclusion: bountywellOutageTaskConclusionSchema,
  createdAt: timestampSchema,
  id: identifierSchema,
  kind: z.literal("bountywell.outage.recovery"),
  question: z.literal(bountywellOutageReport),
  status: z.enum(["pending", "completed", "cancelled"]),
  updatedAt: timestampSchema,
});

export const bountywellOutageRecoveryRequestSchema = z
  .object({
    report: z.literal(bountywellOutageReport),
    requestId: identifierSchema,
  })
  .strict();

export const bountywellOutageInjectionSchema = z.object({
  report: z.literal(bountywellOutageReport),
  requestId: identifierSchema,
  taskId: identifierSchema,
});

export const grantBountywellRestartRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
  })
  .strict();

export const armBountywellRecoveryTimerRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
  })
  .strict();

export const injectBountywellOutageRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    ownerAvailable: z.literal(true),
  })
  .strict();

export const bountywellRecoveryTimerSchema = z.object({
  armed: z.boolean(),
  delaySeconds: z.literal(600),
  unit: z.literal("bountywell-api.service"),
});

export const bountywellRecoveryTimerProofSchema = z.object({
  capable: z.literal(true),
  delaySeconds: z.literal(600),
  unit: z.literal("bountywell-api.service"),
});

export const bountywellBaselineEvidenceSchema = z.object({
  authenticationBoundary: z.literal(401),
  publicHealth: z.literal(200),
  serviceActive: z.literal(true),
});

export const bountywellServiceControlResultSchema = z.object({
  previousActive: z.boolean(),
  started: z.boolean(),
  unit: z.literal("bountywell-api.service"),
  verified: z
    .object({
      authenticationBoundary: z.number().int().min(100).max(599),
      publicHealth: z.number().int().min(100).max(599),
      serviceActive: z.boolean(),
    })
    .optional(),
});

const outageEventFields = {
  id: identifierSchema,
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().max(240),
};

export const bountywellFaultReportedEvidenceEventSchema = z.object({
  ...outageEventFields,
  details: z.object({
    report: z.literal(bountywellOutageReport),
  }),
  kind: z.literal("fault.reported"),
});

export const bountywellDiagnosisRecordedEvidenceEventSchema = z.object({
  ...outageEventFields,
  details: z.object({
    alreadyRecovered: z.boolean(),
    basis: z.enum(["inference", "observation"]),
    hypothesis: z.string().min(1).max(240),
    inactiveUnit: z.literal("bountywell-api.service").optional(),
  }),
  kind: z.literal("diagnosis.recorded"),
});

export const bountywellPolicyDecidedEvidenceEventSchema = z.object({
  ...outageEventFields,
  details: z.object({
    capability: bountywellServiceRestartCapabilitySchema,
    decision: z.enum(["allow", "deny"]),
    reason: z.string().min(1).max(240),
  }),
  kind: z.literal("policy.decided"),
});

export const bountywellTimerLifecycleEvidenceEventSchema = z.object({
  ...outageEventFields,
  details: z.object({
    delaySeconds: z.literal(600),
    phase: z.enum(["armed", "proven", "removed", "retained"]),
    unit: z.literal("bountywell-api.service"),
  }),
  kind: z.literal("timer.lifecycle"),
});

export const bountywellOutageEvidenceEventSchema = z.discriminatedUnion("kind", [
  bountywellFaultReportedEvidenceEventSchema,
  bountywellDiagnosisRecordedEvidenceEventSchema,
  bountywellPolicyDecidedEvidenceEventSchema,
  bountywellTimerLifecycleEvidenceEventSchema,
]);

export type BountywellOutageTask = z.infer<typeof bountywellOutageTaskSchema>;
export type BountywellOutageRecoveryRequest = z.infer<
  typeof bountywellOutageRecoveryRequestSchema
>;
export type BountywellOutageInjection = z.infer<
  typeof bountywellOutageInjectionSchema
>;
export type BountywellRecoveryTimer = z.infer<
  typeof bountywellRecoveryTimerSchema
>;
export type BountywellRecoveryTimerProof = z.infer<
  typeof bountywellRecoveryTimerProofSchema
>;
export type BountywellBaselineEvidence = z.infer<
  typeof bountywellBaselineEvidenceSchema
>;
export type BountywellServiceControlResult = z.infer<
  typeof bountywellServiceControlResultSchema
>;
