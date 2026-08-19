import { z } from "zod";

import {
  promotionEvidenceEventProjectionSchema,
  promotionMergeProjectionSchema,
  promotionReleaseProjectionSchema,
  promotionRollbackProjectionSchema,
  promotionVerificationProjectionSchema,
} from "./promotion.ts";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const absolutePathSchema = z.string().min(1).max(500).startsWith("/");
const commandSchema = z.string().min(1).max(200);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const keeploreApplicationId = "keeplore-production" as const;
export const keeploreRepository = "JacobStephens2/keeplore" as const;
export const keeploreProductionBranch = "main" as const;
export const keeploreServiceUnit = "keeplore-api.service" as const;

/** The read-only revalidation performed before any pull, branch, or build. */
export const keeploreLiveInspectionSchema = z
  .object({
    accessMode: z.literal("read-only"),
    headCommit: commitSchema,
    inspectedAt: timestampSchema,
    liveCheckoutPath: absolutePathSchema,
    productionBranch: z.literal(keeploreProductionBranch),
    repository: z.literal(keeploreRepository),
    servingPath: absolutePathSchema,
    serviceUnit: z.literal(keeploreServiceUnit),
    uncommittedPaths: z.array(z.string().min(1).max(300)).max(200),
    verificationCommands: z.array(commandSchema).min(1).max(5),
  })
  .strict();

/** The owner's reconciliation of live uncommitted work, recorded before automation acts. */
export const keeploreWorkingTreeReconciliationSchema = z
  .object({
    outcome: z.enum([
      "already-clean",
      "committed-by-owner",
      "preserved-on-branch",
      "stashed-by-owner",
    ]),
    preservedRef: z.string().min(1).max(200).optional(),
    reconciledAt: timestampSchema,
    reconciledBy: z.literal("owner"),
    remainingUncommittedPaths: z.array(z.string().min(1).max(300)).max(200),
  })
  .strict();

export const keeploreEnrollmentSourceSchema = z.enum([
  "fresh-passkey-action",
  "repository",
  "trusted-session",
  "voice",
]);

export const keeploreRegistrationSchema = z
  .object({
    applicationId: z.literal(keeploreApplicationId),
    deploymentBoundaries: z
      .object({
        liveCheckoutPath: absolutePathSchema,
        releaseRoot: absolutePathSchema,
        retainedReleases: z.number().int().min(1).max(20),
        sourceMirrorPath: absolutePathSchema,
      })
      .strict(),
    permittedSubagentProvider: z.literal("codex"),
    productionBranch: z.literal(keeploreProductionBranch),
    readScope: z.array(z.string().min(1).max(200)).min(1).max(20),
    registeredAt: timestampSchema,
    registeredBy: z.literal("fresh-passkey-action"),
    repository: z.literal(keeploreRepository),
    revision: z.number().int().positive(),
    verification: z
      .object({
        checkName: z.string().min(1).max(120),
        command: commandSchema,
      })
      .strict(),
    worktreeRoot: absolutePathSchema,
  })
  .strict();

export const keeploreRegistrationStatusSchema = z
  .object({ registration: keeploreRegistrationSchema.nullable() })
  .strict();

export const keeploreBranchProtectionSchema = z
  .object({
    allowsDeletion: z.boolean(),
    allowsForcePush: z.boolean(),
    branch: z.string().min(1).max(120),
    bypassActors: z.array(z.string().min(1).max(120)).max(20),
    requiredChecks: z.array(z.string().min(1).max(120)).max(20),
    requiresPullRequest: z.boolean(),
  })
  .strict();

export const keeploreGitHubAppInstallationSchema = z
  .object({
    permissions: z
      .record(
        z.string().min(1).max(60),
        z.enum(["admin", "read", "write"]),
      )
      .refine((permissions) => Object.keys(permissions).length <= 20, {
        message: "GitHub App permissions are bounded",
      }),
    repositories: z.array(z.string().min(1).max(200)).min(1).max(20),
  })
  .strict();

export const keeploreDeploymentContractSchema = z
  .object({
    activatedAt: timestampSchema,
    activatedBy: z.literal("fresh-passkey-action"),
    applicationId: z.literal(keeploreApplicationId),
    buildCommand: commandSchema,
    health: z
      .object({
        expectedStatus: z.number().int().min(100).max(599),
        path: absolutePathSchema,
      })
      .strict(),
    preflightCommand: commandSchema,
    releaseRoot: absolutePathSchema,
    retainedReleases: z.number().int().min(1).max(20),
    revision: z.number().int().positive(),
    source: z.literal("voice-agent-policy"),
  })
  .strict();

export const keeplorePolicyAssessmentSchema = z
  .object({
    satisfied: z.boolean(),
    violations: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict();

export const keeploreOnboardingTaskConclusionSchema = z.enum([
  "Keeplore onboarding is pending.",
  "Keeplore is onboarded and its Human Merge was promoted.",
  "Keeplore onboarding could not be confirmed.",
]);

export const keeploreOnboardingTaskSchema = z
  .object({
    conclusion: keeploreOnboardingTaskConclusionSchema,
    createdAt: timestampSchema,
    id: identifierSchema,
    kind: z.literal("keeplore.onboarding"),
    question: z.literal("Onboard Keeplore with a harmless Human Merge."),
    status: z.enum(["completed", "denied", "pending", "running"]),
    updatedAt: timestampSchema,
  })
  .strict();

/** The Evidence Record the owner reads to accept the onboarding. */
export const keeploreOnboardingEvidenceRecordProjectionSchema = z
  .object({
    evidence: z.array(promotionEvidenceEventProjectionSchema).max(100),
    onboarding: z
      .object({
        branchProtection: keeplorePolicyAssessmentSchema,
        contractRevision: z.number().int().positive(),
        githubApp: keeplorePolicyAssessmentSchema,
        health: promotionVerificationProjectionSchema.optional(),
        merge: promotionMergeProjectionSchema.optional(),
        promotionAttempt: z
          .object({
            id: identifierSchema,
            mergeCommit: commitSchema,
            status: z.enum(["queued", "rolled-back", "running", "succeeded"]),
          })
          .strict()
          .optional(),
        registrationRevision: z.number().int().positive(),
        release: promotionReleaseProjectionSchema.optional(),
        retainedRelease: promotionReleaseProjectionSchema.optional(),
        rollback: promotionRollbackProjectionSchema,
      })
      .strict(),
    task: keeploreOnboardingTaskSchema,
  })
  .strict();

/** The browser supplies only the owner's reconciliation; the host inspects Keeplore itself. */
export const enrollKeeploreRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    reconciliation: keeploreWorkingTreeReconciliationSchema,
  })
  .strict();

export const activateKeeploreDeploymentContractRequestSchema = z
  .object({
    buildCommand: commandSchema,
    csrfToken: z.string().min(16).max(200),
    health: keeploreDeploymentContractSchema.shape.health,
    preflightCommand: commandSchema,
    releaseRoot: absolutePathSchema,
    retainedReleases: keeploreDeploymentContractSchema.shape.retainedReleases,
    revision: z.number().int().positive(),
  })
  .strict();

export type KeeploreLiveInspection = z.infer<
  typeof keeploreLiveInspectionSchema
>;
export type KeeploreWorkingTreeReconciliation = z.infer<
  typeof keeploreWorkingTreeReconciliationSchema
>;
export type KeeploreEnrollmentSource = z.infer<
  typeof keeploreEnrollmentSourceSchema
>;
export type KeeploreRegistration = z.infer<typeof keeploreRegistrationSchema>;
export type KeeploreBranchProtection = z.infer<
  typeof keeploreBranchProtectionSchema
>;
export type KeeploreGitHubAppInstallation = z.infer<
  typeof keeploreGitHubAppInstallationSchema
>;
export type KeeploreDeploymentContract = z.infer<
  typeof keeploreDeploymentContractSchema
>;
export type KeeplorePolicyAssessment = z.infer<
  typeof keeplorePolicyAssessmentSchema
>;
export type KeeploreOnboardingEvidenceRecordProjection = z.infer<
  typeof keeploreOnboardingEvidenceRecordProjectionSchema
>;
export type KeeploreOnboardingTask = z.infer<
  typeof keeploreOnboardingTaskSchema
>;
