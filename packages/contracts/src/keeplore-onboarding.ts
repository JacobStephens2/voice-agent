import { z } from "zod";

import {
  deploymentContractSchema,
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
/**
 * Keeplore's canonical repository. It was renamed from `artifact-manager`, and
 * GitHub still redirects the old name, so a live checkout can carry a stale
 * remote that resolves correctly while naming the wrong repository.
 */
export const keeploreRepository = "JacobStephens2/keeplore" as const;
export const keeploreFormerRepository =
  "JacobStephens2/artifact-manager" as const;
export const keeploreProductionBranch = "main" as const;
/** Apache serves Keeplore's two document roots; there is no application service unit. */
export const keeploreServingEdge = "apache" as const;

/** The paths Apache serves. Promotion repoints them at the active Release. */
export const keeploreDocumentRootsSchema = z
  .object({
    api: absolutePathSchema,
    ui: absolutePathSchema,
  })
  .strict();

/** The read-only revalidation performed before any pull, branch, or build. */
export const keeploreLiveInspectionSchema = z
  .object({
    accessMode: z.literal("read-only"),
    headCommit: commitSchema,
    inspectedAt: timestampSchema,
    documentRoots: keeploreDocumentRootsSchema,
    liveCheckoutPath: absolutePathSchema,
    productionBranch: z.literal(keeploreProductionBranch),
    /** What the live checkout's origin names today, stale rename included. */
    remoteRepository: z.string().min(1).max(200),
    repository: z.literal(keeploreRepository),
    servingEdge: z.literal(keeploreServingEdge),
    /** Gitignored runtime state that must survive a Promotion, relative to the checkout. */
    sharedPaths: z.array(z.string().min(1).max(200)).max(20),
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
        sharedRoot: absolutePathSchema,
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

/** The shared Deployment Contract, fixed to Keeplore and its Release retention. */
export const keeploreDeploymentContractSchema = deploymentContractSchema
  .extend({
    applicationId: z.literal(keeploreApplicationId),
    retainedReleases: z.number().int().min(1).max(20),
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

export type KeeploreDocumentRoots = z.infer<
  typeof keeploreDocumentRootsSchema
>;
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
