import { z } from "zod";

import {
  callAdmissionReopenReasonSchema,
  callAdmissionStateSchema,
  safePointDispositionSchema,
  selfPromotionVerificationSchema,
} from "./self-promotion.ts";

const promotionIdentifierSchema = z.string().min(1).max(200);
const promotionTextSchema = z.string().min(1).max(500);
const promotionPathSchema = z.string().min(1).max(500).startsWith("/");
const promotionCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const promotionTimestampSchema = z.iso.datetime();
const promotionApplicationIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,60}$/u);
const promotionRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const promotionBranchSchema = z.string().min(1).max(120);

export const fixtureGitHubEventSchema = z
  .object({
    action: z.enum(["closed", "opened", "synchronize"]),
    beforeCommit: promotionCommitSchema,
    branch: z.string().min(1).max(120),
    commit: promotionCommitSchema,
    event: z.enum(["pull_request", "push"]),
    merged: z.boolean(),
    mergedAt: promotionTimestampSchema,
    mergedBy: z
      .object({
        login: z.string().min(1).max(120),
        type: z.enum(["Bot", "Organization", "User"]),
      })
      .strict()
      .nullable(),
    repository: z.string().min(1).max(200),
  })
  .strict();

export const registeredCodebaseSchema = z
  .object({
    applicationId: promotionApplicationIdSchema,
    initialProductionCommit: promotionCommitSchema,
    liveCheckoutPath: promotionPathSchema,
    productionBranch: promotionBranchSchema,
    registeredAt: promotionTimestampSchema,
    repository: promotionRepositorySchema,
    sourceCheckoutRoot: promotionPathSchema,
  })
  .strict();

export const fixtureCodebaseRegistrationSchema = registeredCodebaseSchema;

export const deploymentContractSchema = z
  .object({
    activatedAt: promotionTimestampSchema,
    activatedBy: z.literal("fresh-passkey-action"),
    applicationId: promotionApplicationIdSchema,
    buildCommand: promotionTextSchema,
    health: z
      .object({
        expectedStatus: z.number().int().min(100).max(599),
        path: promotionPathSchema,
      })
      .strict(),
    preflightCommand: promotionTextSchema,
    releaseRoot: promotionPathSchema,
    revision: z.number().int().positive(),
    /**
     * The self-Promotion boundary, present only for a codebase whose Promotion
     * replaces the runtime performing it. It is part of the authenticated
     * contract rather than the promoter's code, so changing how long a
     * Promotion may wait for a live call is a Fresh Passkey Action.
     */
    selfPromotion: z
      .object({ safePointObservations: z.number().int().min(1).max(10_000) })
      .strict()
      .optional(),
    source: z.literal("voice-agent-policy"),
  })
  .strict();

export const fixtureDeploymentContractSchema = deploymentContractSchema;

export const promotionAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "rolled-back",
  "succeeded",
]);

export const promotionEvidenceDetailsSchema = z
  .record(
    z.string().min(1).max(80),
    z.union([
      z.string().max(500),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine((details) => Object.keys(details).length <= 20, {
    message: "Promotion evidence detail is bounded",
  });

/**
 * Deployment Authority Drift — what the active Release carries under
 * `ops/release/` and `ops/systemd/` that the pinned, root-owned deployment
 * authority is not yet running.
 *
 * A Promotion reports it and never judges it. Drift is a normal state: the pin
 * is what stops a merged commit from expanding root authority, so a reviewed
 * change to pinned content stays dormant until the attended upgrade named by
 * `action` applies it. The observation is recorded even when nothing diverges,
 * which is what lets an owner tell "fully live" from "live except for the
 * root-pinned parts" instead of reading silence as either.
 */
export const promotionAuthorityDriftProjectionSchema = z.discriminatedUnion(
  "diverged",
  [
    z
      .object({
        diverged: z.literal(false),
        paths: z.array(z.string()).length(0),
      })
      .strict(),
    z
      .object({
        action: z.literal("./ops/upgrade-agent-host-deployment-authority.sh"),
        diverged: z.literal(true),
        paths: z.array(z.string().min(1).max(200)).min(1).max(60),
      })
      .strict(),
  ],
);

export const promotionEvidenceEventProjectionSchema = z
  .object({
    details: promotionEvidenceDetailsSchema,
    id: promotionIdentifierSchema,
    kind: z.enum([
      "admission.paused",
      "admission.reopened",
      "authority.drift-observed",
      "circuit.changed",
      "delivery.denied",
      "delivery.duplicate",
      "merge.accepted",
      "promotion.queued",
      "promotion.reordered",
      "reconciliation.discovered",
      "release.built",
      "release.preflighted",
      "release.rolled-back",
      "release.switched",
      "release.verified",
      "safe-point.reached",
      "work.disposed",
    ]),
    occurredAt: promotionTimestampSchema,
    sequence: z.number().int().positive(),
    summary: promotionTextSchema,
  })
  .strict();

export const promotionMergeProjectionSchema = z
  .object({
    actor: z.string().min(1).max(120),
    beforeCommit: promotionCommitSchema,
    branch: z.string().min(1).max(120),
    commit: promotionCommitSchema,
    deliveryId: promotionIdentifierSchema,
    mergedAt: promotionTimestampSchema,
    repository: z.string().min(1).max(200),
    source: z.enum(["reconciliation", "webhook"]),
  })
  .strict();

export const promotionReleaseProjectionSchema = z
  .object({
    commit: promotionCommitSchema,
    id: promotionIdentifierSchema,
    path: promotionPathSchema,
  })
  .strict();

export const promotionRollbackProjectionSchema = z
  .object({
    attemptedReleaseId: promotionIdentifierSchema.optional(),
    performed: z.boolean(),
    restoredReleaseId: promotionIdentifierSchema.optional(),
  })
  .strict();

export const promotionVerificationProjectionSchema = z
  .object({
    actualStatus: z.number().int().min(100).max(599),
    expectedStatus: z.number().int().min(100).max(599),
    outcome: z.enum(["healthy", "unhealthy"]),
    path: promotionPathSchema,
  })
  .strict();

export const promotionEvidenceRecordProjectionSchema = z
  .object({
    evidence: z.array(promotionEvidenceEventProjectionSchema).max(100),
    promotion: z
      .object({
        /**
         * Where a Self-Promotion left Call Admission. Absent for an application
         * whose Promotion never touches the runtime performing it.
         */
        admission: z
          .object({
            reopenedAfter: callAdmissionReopenReasonSchema.optional(),
            state: callAdmissionStateSchema,
          })
          .strict()
          .optional(),
        attempt: z
          .object({
            id: promotionIdentifierSchema,
            mergeCommit: promotionCommitSchema,
            queueSequence: z.number().int().positive(),
            status: promotionAttemptStatusSchema,
          })
          .strict()
          .optional(),
        authorityDrift: promotionAuthorityDriftProjectionSchema.optional(),
        circuit: z
          .object({
            consecutiveFailures: z.number().int().nonnegative(),
            state: z.enum(["closed", "half-open", "open"]),
          })
          .strict(),
        contract: z
          .object({
            activatedAt: promotionTimestampSchema,
            revision: z.number().int().positive(),
            source: z.literal("voice-agent-policy"),
          })
          .strict()
          .optional(),
        denialReason: z.string().min(1).max(120).optional(),
        merge: promotionMergeProjectionSchema,
        release: promotionReleaseProjectionSchema.optional(),
        rollback: promotionRollbackProjectionSchema,
        /** How a Self-Promotion reached its Promotion Safe Point. */
        safePoint: safePointDispositionSchema.optional(),
        /** The runtime readings a Self-Promotion takes after switching. */
        selfVerification: selfPromotionVerificationSchema.optional(),
        verification: promotionVerificationProjectionSchema.optional(),
      })
      .strict(),
    task: z
      .object({
        conclusion: promotionTextSchema,
        createdAt: promotionTimestampSchema,
        id: promotionIdentifierSchema,
        kind: z.literal("human-merge.promotion"),
        question: promotionTextSchema,
        status: z.enum(["completed", "denied", "pending", "running"]),
        updatedAt: promotionTimestampSchema,
      })
      .strict(),
  })
  .strict();

export const promotionOperationProjectionSchema = z
  .object({
    actualStatus: z.number().int().min(100).max(599).optional(),
    command: promotionTextSchema.optional(),
    kind: z.enum([
      "release.build",
      "release.preflight",
      "release.rollback",
      "release.safe-point",
      "release.switch",
      "release.verify",
    ]),
    operationId: promotionIdentifierSchema,
    outcome: z.enum(["completed", "healthy", "passed", "unhealthy"]),
    releasePath: promotionPathSchema.optional(),
    restoredReleaseId: promotionIdentifierSchema.optional(),
    sourcePath: promotionPathSchema.optional(),
  })
  .strict();

export type FixtureGitHubEvent = z.infer<typeof fixtureGitHubEventSchema>;
export type RegisteredCodebase = z.infer<typeof registeredCodebaseSchema>;
export type FixtureCodebaseRegistration = RegisteredCodebase;
export type DeploymentContract = z.infer<typeof deploymentContractSchema>;
export type FixtureDeploymentContract = DeploymentContract;
export type PromotionAttemptStatus = z.infer<
  typeof promotionAttemptStatusSchema
>;
export type PromotionAuthorityDriftProjection = z.infer<
  typeof promotionAuthorityDriftProjectionSchema
>;
export type PromotionEvidenceEventProjection = z.infer<
  typeof promotionEvidenceEventProjectionSchema
>;
export type PromotionEvidenceRecordProjection = z.infer<
  typeof promotionEvidenceRecordProjectionSchema
>;
export type PromotionOperationProjection = z.infer<
  typeof promotionOperationProjectionSchema
>;
