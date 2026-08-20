import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();

export const bountywellOutageReport =
  "Bountywell's API appears unavailable." as const;

/** Why a drill Intervention is refused when Bountywell is not registered. */
export const bountywellDrillNotRegistered =
  "Bountywell is not registered for the guarded outage drill." as const;

/**
 * The question a Bountywell Outage Drill answers while it is being prepared,
 * before any fault is injected. It becomes the fault report at injection.
 */
export const bountywellOutageDrillQuestion =
  "Is the guarded Bountywell Outage Drill ready?" as const;

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
  "Bountywell Outage Drill preparation is pending.",
  "Bountywell Outage Drill is armed and ready.",
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
  question: z.union([
    z.literal(bountywellOutageDrillQuestion),
    z.literal(bountywellOutageReport),
  ]),
  status: z.enum(["pending", "completed", "cancelled"]),
  updatedAt: timestampSchema,
});

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

/** The shared body of every owner-initiated drill-controller Intervention. */
export const bountywellDrillControlRequestSchema = z
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

export const bountywellDrillCapabilitySchema = z.literal(
  "bountywell.outage.drill",
);

export const bountywellPolicyDecidedEvidenceEventSchema = z.object({
  ...outageEventFields,
  details: z.object({
    capability: z.union([
      bountywellServiceRestartCapabilitySchema,
      bountywellDrillCapabilitySchema,
    ]),
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
export type BountywellTimerLifecycleEvidenceEvent = z.infer<
  typeof bountywellTimerLifecycleEvidenceEventSchema
>;

/**
 * The one typed Operations Broker port for Bountywell service control and
 * recovery-timer proof. Every method addresses the registered
 * `bountywell-api.service` unit and the independent recovery timer that starts
 * it; no other unit is reachable through this port.
 */
export interface BountywellServiceController {
  armRecoveryTimer(): Promise<BountywellRecoveryTimer>;
  fireDueTimers(): Promise<
    readonly { readonly unit: "bountywell-api.service" }[]
  >;
  /**
   * Prove the armed timer starts only `bountywell-api.service` after ten
   * minutes and leave it armed. A deterministic Agent Host proves this by
   * letting the timer fire; the real Agent Host proves it by reading the
   * pinned recovery units, without waiting ten minutes.
   */
  proveRecoveryTimer(): Promise<BountywellRecoveryTimerProof>;
  readRecoveryTimer(): Promise<BountywellRecoveryTimer>;
  removeRecoveryTimer(): Promise<{ readonly removed: boolean }>;
  startRegisteredUnit(): Promise<{
    readonly previousActive: boolean;
    readonly started: boolean;
  }>;
  stopRegisteredUnit(): Promise<{ readonly stopped: boolean }>;
}
