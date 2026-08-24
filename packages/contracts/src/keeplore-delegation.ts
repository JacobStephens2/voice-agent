import { z } from "zod";

import {
  keeploreApplicationId,
  keeploreProductionBranch,
  keeploreRepository,
} from "./keeplore-onboarding.ts";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const absolutePathSchema = z.string().min(1).max(500).startsWith("/");
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "Repository paths must stay relative to the Registered Codebase",
  });

export const keeploreButtonTrialGoal =
  "Make Keeplore's table-view Get Rid Of control match the row-level Remove control without changing card view." as const;

export const keeploreButtonTrialAcceptanceCriteria = [
  "Table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight at both the desktop and mobile verification viewports.",
  "Both table-view controls retain content-based widths.",
  "Card view is visually unchanged.",
  "Declared automated verification and authenticated desktop and mobile visual verification pass.",
  "Only a non-production branch is pushed and a pull request is opened without merging or deploying.",
] as const;

/**
 * The criterion wording every Brief accepted before the criteria named both
 * verification viewports carries. The measurement never changed — desktop and
 * mobile were always both verified — so a Delegation stored under the older
 * sentence is still readable and still lists.
 */
export const supersededKeeploreButtonTrialAcceptanceCriterion =
  "Table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight." as const;

export const keeploreDelegationCapabilities = [
  "registered-source.read",
  "delegated-worktree.write",
  "verification.run",
  "authenticated-browser.verify",
  "verified-candidate.publish",
] as const;

export const keeploreCandidatePublicationRequestSchema = z
  .object({
    candidate: z
      .object({
        automatedVerificationPassed: z.literal(true),
        headCommit: commitSchema,
        visualVerificationPassed: z.literal(true),
      })
      .strict(),
    delegationId: identifierSchema.regex(/^[A-Za-z0-9_-]+$/u),
    operation: z.literal("create-or-observe-pull-request"),
  })
  .strict();

export const keeploreCandidatePublicationResultSchema = z
  .object({
    headCommit: commitSchema,
    pullRequest: z
      .object({
        baseBranch: z.literal(keeploreProductionBranch),
        headBranch: z.string().min(1).max(200),
        headCommit: commitSchema,
        state: z.literal("open"),
        url: z.url().startsWith(`https://github.com/${keeploreRepository}/pull/`),
      })
      .strict(),
    repository: z.literal(keeploreRepository),
  })
  .strict();

export const keeploreWorktreeSchema = z
  .object({
    baseCommit: commitSchema,
    branch: z.string().min(1).max(200),
    dirty: z.boolean(),
    id: identifierSchema,
    path: absolutePathSchema,
    state: z.enum(["queued", "running", "completed", "stopped", "failed"]),
  })
  .strict();

export const keeploreDelegationBriefSchema = z
  .object({
    acceptanceCriteria: z.tuple([
      z.union([
        z.literal(keeploreButtonTrialAcceptanceCriteria[0]),
        z.literal(supersededKeeploreButtonTrialAcceptanceCriterion),
      ]),
      z.literal(keeploreButtonTrialAcceptanceCriteria[1]),
      z.literal(keeploreButtonTrialAcceptanceCriteria[2]),
      z.literal(keeploreButtonTrialAcceptanceCriteria[3]),
      z.literal(keeploreButtonTrialAcceptanceCriteria[4]),
    ]),
    boundedContext: z
      .object({
        editablePaths: z.tuple([z.literal("ui/style.css")]),
        referencePaths: z.tuple([
          z.literal("ui/artifacts/useby.php"),
          z.literal("ui/artifacts/useby.js"),
        ]),
        repositoryContentTrust: z.literal("untrusted-data-only"),
      })
      .strict(),
    capabilities: z.tuple([
      z.literal(keeploreDelegationCapabilities[0]),
      z.literal(keeploreDelegationCapabilities[1]),
      z.literal(keeploreDelegationCapabilities[2]),
      z.literal(keeploreDelegationCapabilities[3]),
      z.literal(keeploreDelegationCapabilities[4]),
    ]),
    delegationId: identifierSchema,
    durableTask: z
      .object({
        acceptedAt: timestampSchema,
        id: identifierSchema,
        kind: z.literal("keeplore.button-trial"),
        requestId: identifierSchema,
      })
      .strict(),
    goal: z.literal(keeploreButtonTrialGoal),
    registeredCodebase: z
      .object({
        applicationId: z.literal(keeploreApplicationId),
        productionBranch: z.literal(keeploreProductionBranch),
        provider: z.literal("codex"),
        readScope: z.array(z.string().min(1).max(200)).min(1).max(20),
        repository: z.literal(keeploreRepository),
        revision: z.number().int().positive(),
        sourceCommit: commitSchema,
        verificationCommand: z.string().min(1).max(200),
        worktreeRoot: absolutePathSchema,
      })
      .strict(),
  })
  .strict();

const computedButtonStyleSchema = z
  .object({
    backgroundColor: z.string().min(1).max(80),
    borderBottomWidth: z.string().min(1).max(40),
    borderLeftWidth: z.string().min(1).max(40),
    borderRadius: z.string().min(1).max(40),
    borderRightWidth: z.string().min(1).max(40),
    borderTopWidth: z.string().min(1).max(40),
    boxShadow: z.string().min(1).max(300),
    color: z.string().min(1).max(80),
    fontFamily: z.string().min(1).max(200),
    fontSize: z.string().min(1).max(40),
    fontWeight: z.string().min(1).max(40),
    height: z.string().min(1).max(40),
    letterSpacing: z.string().min(1).max(40),
    lineHeight: z.string().min(1).max(40),
    paddingBottom: z.string().min(1).max(40),
    paddingTop: z.string().min(1).max(40),
    textTransform: z.string().min(1).max(40),
    width: z.string().min(1).max(40),
    widthMode: z.literal("content"),
  })
  .strict();

const screenshotSchema = z
  .object({
    authenticated: z.boolean(),
    path: absolutePathSchema,
    viewport: z
      .object({
        height: z.number().int().positive().max(4_000),
        name: z.enum(["desktop", "mobile"]),
        width: z.number().int().positive().max(4_000),
      })
      .strict(),
  })
  .strict();

export const keeploreDelegationFailureKinds = [
  "delegation-execution",
  "model-declined",
  "restricted-runner",
  "sandbox-initialization",
] as const;

export const keeploreDelegationResultSchema = z
  .object({
    branch: z.string().min(1).max(200),
    changedFiles: z.array(repositoryPathSchema).max(20),
    cleanup: z
      .object({
        eligible: z.boolean(),
        quarantineReason: z.string().min(1).max(300).nullable(),
      })
      .strict(),
    commits: z.array(commitSchema).max(20),
    completedAt: timestampSchema,
    delegationId: identifierSchema,
    environment: z
      .object({
        dockerSocket: z.literal(false),
        identity: z.literal("voice-codex"),
        operationsBroker: z.literal(false),
        productionDirectoryWrite: z.literal(false),
        productionSecrets: z.literal(false),
        providerLogin: z.literal("separate-eligible-subscription"),
        sudo: z.literal(false),
      })
      .strict(),
    failure: z
      .object({
        evidencePaths: z.array(absolutePathSchema).max(4),
        kind: z.enum(keeploreDelegationFailureKinds),
        message: z.string().min(1).max(300),
        name: z.string().min(1).max(120),
      })
      .strict()
      .nullable(),
    pullRequest: z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("none"), url: z.null() }).strict(),
        z
          .object({
            state: z.literal("open"),
            url: z.url().startsWith("https://github.com/"),
          })
          .strict(),
      ]),
    risks: z.array(z.string().min(1).max(300)).max(20),
    status: z.enum(["completed", "failed", "stopped"]),
    verification: z
      .object({
        automated: z
          .array(
            z
              .object({
                command: z.string().min(1).max(200),
                outcome: z.enum(["failed", "passed"]),
                summary: z.string().min(1).max(300),
              })
              .strict(),
          )
          .max(10),
        cardView: z
          .object({
            afterHash: z.string().min(1).max(200),
            beforeHash: z.string().min(1).max(200),
            unchanged: z.boolean(),
          })
          .strict(),
        computedStyles: z
          .array(
            z
              .object({
                getRidOf: computedButtonStyleSchema,
                remove: computedButtonStyleSchema,
                viewport: z.enum(["desktop", "mobile"]),
              })
              .strict(),
          )
          .max(4),
        screenshots: z.array(screenshotSchema).max(4),
      })
      .strict(),
    worktree: keeploreWorktreeSchema,
  })
  .strict();

export const keeploreButtonTrialTaskSchema = z
  .object({
    conclusion: z.enum([
      "Keeplore Button Trial is delegated.",
      "Keeplore Button Trial is running.",
      "Keeplore Button Trial pull request is ready for Human Merge.",
      "Keeplore Button Trial stopped with its worktree preserved.",
      "Keeplore Button Trial could not be verified.",
    ]),
    createdAt: timestampSchema,
    id: identifierSchema,
    kind: z.literal("keeplore.button-trial"),
    question: z.literal(keeploreButtonTrialGoal),
    status: z.enum(["pending", "running", "completed", "stopped", "failed"]),
    updatedAt: timestampSchema,
  })
  .strict();

export const keeploreDelegationRecordSchema = z
  .object({
    delegation: z
      .object({
        brief: keeploreDelegationBriefSchema,
        result: keeploreDelegationResultSchema.optional(),
        stopRequested: z.boolean(),
        worktree: keeploreWorktreeSchema,
      })
      .strict(),
    task: keeploreButtonTrialTaskSchema,
  })
  .strict();

export type KeeploreWorktree = z.infer<typeof keeploreWorktreeSchema>;
export type KeeploreCandidatePublicationRequest = z.infer<
  typeof keeploreCandidatePublicationRequestSchema
>;
export type KeeploreCandidatePublicationResult = z.infer<
  typeof keeploreCandidatePublicationResultSchema
>;
export type KeeploreDelegationBrief = z.infer<
  typeof keeploreDelegationBriefSchema
>;
export type KeeploreDelegationResult = z.infer<
  typeof keeploreDelegationResultSchema
>;
export type KeeploreDelegationFailure = NonNullable<
  KeeploreDelegationResult["failure"]
>;
export type KeeploreDelegationRecord = z.infer<
  typeof keeploreDelegationRecordSchema
>;
