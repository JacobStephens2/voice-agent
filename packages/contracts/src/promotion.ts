import { z } from "zod";

const promotionIdentifierSchema = z.string().min(1).max(200);
const promotionTextSchema = z.string().min(1).max(500);
const promotionPathSchema = z.string().min(1).max(500).startsWith("/");
const promotionCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const promotionTimestampSchema = z.iso.datetime();

export const fixtureGitHubEventSchema = z
  .object({
    action: z.enum(["closed", "opened", "synchronize"]),
    beforeCommit: promotionCommitSchema,
    branch: z.string().min(1).max(120),
    commit: promotionCommitSchema,
    event: z.enum(["pull_request", "push"]),
    merged: z.boolean(),
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

export const fixtureCodebaseRegistrationSchema = z
  .object({
    applicationId: z.literal("fixture-production"),
    liveCheckoutPath: promotionPathSchema,
    productionBranch: z.literal("main"),
    registeredAt: promotionTimestampSchema,
    repository: z.literal("JacobStephens2/fixture-application"),
    sourceCheckoutRoot: promotionPathSchema,
  })
  .strict();

export const fixtureDeploymentContractSchema = z
  .object({
    activatedAt: promotionTimestampSchema,
    activatedBy: z.literal("fresh-passkey-action"),
    applicationId: z.literal("fixture-production"),
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
    source: z.literal("voice-agent-policy"),
  })
  .strict();

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

export const promotionEvidenceEventProjectionSchema = z
  .object({
    details: promotionEvidenceDetailsSchema,
    id: promotionIdentifierSchema,
    kind: z.enum([
      "circuit.changed",
      "delivery.denied",
      "delivery.duplicate",
      "merge.accepted",
      "promotion.queued",
      "reconciliation.discovered",
      "release.built",
      "release.preflighted",
      "release.rolled-back",
      "release.switched",
      "release.verified",
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
        attempt: z
          .object({
            id: promotionIdentifierSchema,
            mergeCommit: promotionCommitSchema,
            queueSequence: z.number().int().positive(),
            status: promotionAttemptStatusSchema,
          })
          .strict()
          .optional(),
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

export interface FixtureGitHubEvent {
  readonly action: "closed" | "opened" | "synchronize";
  readonly beforeCommit: string;
  readonly branch: string;
  readonly commit: string;
  readonly event: "pull_request" | "push";
  readonly merged: boolean;
  readonly mergedBy: {
    readonly login: string;
    readonly type: "Bot" | "Organization" | "User";
  } | null;
  readonly repository: string;
}

export interface FixtureCodebaseRegistration {
  readonly applicationId: "fixture-production";
  readonly liveCheckoutPath: string;
  readonly productionBranch: "main";
  readonly registeredAt: string;
  readonly repository: "JacobStephens2/fixture-application";
  readonly sourceCheckoutRoot: string;
}

export interface FixtureDeploymentContract {
  readonly activatedAt: string;
  readonly activatedBy: "fresh-passkey-action";
  readonly applicationId: "fixture-production";
  readonly buildCommand: string;
  readonly health: {
    readonly expectedStatus: number;
    readonly path: string;
  };
  readonly preflightCommand: string;
  readonly releaseRoot: string;
  readonly revision: number;
  readonly source: "voice-agent-policy";
}

export type PromotionAttemptStatus =
  | "queued"
  | "running"
  | "rolled-back"
  | "succeeded";

export interface PromotionEvidenceEventProjection {
  readonly details: Readonly<Record<string, boolean | number | string | null>>;
  readonly id: string;
  readonly kind:
    | "circuit.changed"
    | "delivery.denied"
    | "delivery.duplicate"
    | "merge.accepted"
    | "promotion.queued"
    | "reconciliation.discovered"
    | "release.built"
    | "release.preflighted"
    | "release.rolled-back"
    | "release.switched"
    | "release.verified";
  readonly occurredAt: string;
  readonly sequence: number;
  readonly summary: string;
}

export interface PromotionEvidenceRecordProjection {
  readonly evidence: readonly PromotionEvidenceEventProjection[];
  readonly promotion: {
    readonly attempt?:
      | {
      readonly id: string;
      readonly mergeCommit: string;
      readonly queueSequence: number;
      readonly status: PromotionAttemptStatus;
        }
      | undefined;
    readonly circuit: {
      readonly consecutiveFailures: number;
      readonly state: "closed" | "half-open" | "open";
    };
    readonly contract?:
      | {
      readonly activatedAt: string;
      readonly revision: number;
      readonly source: "voice-agent-policy";
        }
      | undefined;
    readonly denialReason?: string | undefined;
    readonly merge: {
      readonly actor: string;
      readonly beforeCommit: string;
      readonly branch: string;
      readonly commit: string;
      readonly deliveryId: string;
      readonly repository: string;
      readonly source: "reconciliation" | "webhook";
    };
    readonly release?:
      | {
      readonly commit: string;
      readonly id: string;
      readonly path: string;
        }
      | undefined;
    readonly rollback: {
      readonly attemptedReleaseId?: string | undefined;
      readonly performed: boolean;
      readonly restoredReleaseId?: string | undefined;
    };
    readonly verification?:
      | {
      readonly actualStatus: number;
      readonly expectedStatus: number;
      readonly outcome: "healthy" | "unhealthy";
      readonly path: string;
        }
      | undefined;
  };
  readonly task: {
    readonly conclusion: string;
    readonly createdAt: string;
    readonly id: string;
    readonly kind: "human-merge.promotion";
    readonly question: string;
    readonly status: "completed" | "denied" | "pending" | "running";
    readonly updatedAt: string;
  };
}

export interface PromotionOperationProjection {
  readonly actualStatus?: number | undefined;
  readonly command?: string | undefined;
  readonly kind:
    | "release.build"
    | "release.preflight"
    | "release.rollback"
    | "release.switch"
    | "release.verify";
  readonly operationId: string;
  readonly outcome: "completed" | "healthy" | "passed" | "unhealthy";
  readonly releasePath?: string | undefined;
  readonly restoredReleaseId?: string | undefined;
  readonly sourcePath?: string | undefined;
}
