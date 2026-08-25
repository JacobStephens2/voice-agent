import { z } from "zod";

/**
 * Self-Promotion is the Promotion of the Voice Agent's own Registered Codebase
 * by the runtime that is about to be replaced. It differs from every other
 * Promotion in one way: the work it must not disturb is running inside it. This
 * contract names what "must not disturb" means, so the runtime, the pinned
 * promoter, and the Evidence Record all read the same boundary.
 */

/**
 * An Operation whose kind mutates Agent Host state. Its declared safe boundary
 * is its own settlement: interrupted in flight it leaves the host in a state no
 * Evidence Record can describe, because the Operation neither took effect nor
 * did not.
 */
export const nonInterruptibleOperationKinds = [
  "bountywell.recovery-timer.arm",
  "bountywell.recovery-timer.remove",
  "bountywell.service.restart",
  "bountywell.service.stop",
] as const;

export type NonInterruptibleOperationKind =
  (typeof nonInterruptibleOperationKinds)[number];

/**
 * Every other Operation is resumable: it is read-only, or idempotent under its
 * own durable identity, so the switched runtime replays it rather than
 * repeating its external effect.
 */
export function isNonInterruptibleOperationKind(
  kind: string,
): kind is NonInterruptibleOperationKind {
  return (nonInterruptibleOperationKinds as readonly string[]).includes(kind);
}

/** Whether the runtime will accept a new Telephone Session. */
export const callAdmissionStateSchema = z.enum(["open", "paused"]);
export type CallAdmissionState = z.infer<typeof callAdmissionStateSchema>;

export const callAdmissionPauseReasonSchema = z.enum(["self-promotion"]);
export type CallAdmissionPauseReason = z.infer<
  typeof callAdmissionPauseReasonSchema
>;

const selfPromotionCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const selfPromotionTimestampSchema = z.iso.datetime();

export const callAdmissionRecordSchema = z
  .object({
    changedAt: selfPromotionTimestampSchema,
    /** The Self-Promotion holding admission closed, while one holds it. */
    commit: selfPromotionCommitSchema.optional(),
    promotionId: z.string().min(1).max(200).optional(),
    reason: callAdmissionPauseReasonSchema.optional(),
    state: callAdmissionStateSchema,
  })
  .strict();
export type CallAdmissionRecord = z.infer<typeof callAdmissionRecordSchema>;

export const safePointObservationSchema = z
  .object({
    /**
     * Live Telephone Sessions. A Self-Promotion waits for each to end naturally
     * or reach an explicit safe handoff; it never ends one to deploy sooner.
     */
    activeTelephoneSessions: z.number().int().nonnegative(),
    admission: callAdmissionStateSchema,
    nonInterruptibleOperations: z.number().int().nonnegative(),
    /** Unsettled work that survives the switch under its own identity. */
    resumableOperations: z.number().int().nonnegative(),
    reached: z.boolean(),
  })
  .strict();
export type SafePointObservation = z.infer<typeof safePointObservationSchema>;

export const safePointDispositionSchema = z
  .object({
    activeTelephoneSessionsAtRequest: z.number().int().nonnegative(),
    disposition: z.enum(["already-safe", "deadline-exceeded", "waited"]),
    /**
     * Always zero, and stated rather than implied: no Telephone Session is ever
     * ended to make a Self-Promotion happen sooner.
     */
    endedForPromotion: z.literal(0),
    nonInterruptibleOperationsAtRequest: z.number().int().nonnegative(),
    observations: z.number().int().positive(),
    resumableOperationsAtRequest: z.number().int().nonnegative(),
  })
  .strict();
export type SafePointDisposition = z.infer<typeof safePointDispositionSchema>;

/**
 * What a Self-Promotion verifies after the atomic switch, beyond the health
 * path every Deployment Contract declares. A reading that is not `passed`
 * fails verification and restores the prior Release.
 */
export const selfPromotionVerificationChecks = [
  "api-health",
  "callback-admission",
  "durable-store-compatibility",
  "public-health",
  "service-restart",
  "worker-readiness",
] as const;
export type SelfPromotionVerificationCheck =
  (typeof selfPromotionVerificationChecks)[number];

export const selfPromotionVerificationSchema = z
  .object({
    checks: z.array(
      z
        .object({
          check: z.enum(selfPromotionVerificationChecks),
          outcome: z.enum(["failed", "passed"]),
        })
        .strict(),
    ).max(selfPromotionVerificationChecks.length),
    outcome: z.enum(["healthy", "unhealthy"]),
  })
  .strict();
export type SelfPromotionVerification = z.infer<
  typeof selfPromotionVerificationSchema
>;
