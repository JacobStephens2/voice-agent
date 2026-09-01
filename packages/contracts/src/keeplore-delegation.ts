import { z } from "zod";

import {
  delegationAutomatedVerificationResultsSchema,
  delegationCommitSchema,
  delegationResultSharedFields,
  delegationWorktreeSchema,
} from "./delegation.ts";

import {
  keeploreProductionBranch,
  keeploreRegisteredCodebaseIdSchema,
  keeploreRepository,
} from "./keeplore-onboarding.ts";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const absolutePathSchema = z.string().min(1).max(500).startsWith("/");

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

/**
 * The computed properties authenticated visual verification requires the two
 * table-view controls to share exactly.
 *
 * The restricted runner checks them, the Operations policy checks them again
 * before a result is accepted, and the model is told them in its prompt — it
 * never measures the rendered controls itself. Naming them once here keeps the
 * bar the model is given from drifting away from the bar it is judged against:
 * a model told only to "match" picks which properties that means, and a rule
 * that reads as a match — matching padding, matching typography — still fails
 * on the shadow and the colour it never touched.
 *
 * Width is deliberately absent. Both controls are measured for content-based
 * widths, which requires them to differ.
 */
export const keeploreMatchedControlProperties = [
  "backgroundColor",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRadius",
  "borderRightWidth",
  "borderTopWidth",
  "boxShadow",
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "height",
  "letterSpacing",
  "lineHeight",
  "paddingBottom",
  "paddingTop",
  "textTransform",
] as const;

export function describeKeeploreMatchedControlProperties(): string {
  return keeploreMatchedControlProperties.join(", ");
}

/**
 * The one mismatch check both acceptance gates read, or `null` when the two
 * controls share every matched property.
 *
 * The restricted runner checks a candidate before it publishes anything and the
 * Operations policy checks the accepted result again, so the comparison — and
 * the sentence an owner and the next round of work read — belongs here rather
 * than in a copy on each side of that boundary. It names every mismatching
 * property: a candidate reported as differing in `boxShadow` alone sends the
 * next attempt after one property while the rest are still wrong.
 */
export function describeKeeploreControlMismatch(
  viewport: "desktop" | "mobile",
  styles: {
    getRidOf: KeeploreComputedButtonStyle;
    remove: KeeploreComputedButtonStyle;
  },
): string | null {
  const mismatched = keeploreMatchedControlProperties.filter(
    (property) => styles.getRidOf[property] !== styles.remove[property],
  );
  if (mismatched.length === 0) {
    return null;
  }
  return `${viewport} Keeplore table controls differ in ${mismatched.join(", ")}`;
}

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
        headCommit: delegationCommitSchema,
        visualVerificationPassed: z.literal(true),
      })
      .strict(),
    delegationId: identifierSchema.regex(/^[A-Za-z0-9_-]+$/u),
    operation: z.literal("create-or-observe-pull-request"),
  })
  .strict();

export const keeploreCandidatePublicationResultSchema = z
  .object({
    headCommit: delegationCommitSchema,
    pullRequest: z
      .object({
        baseBranch: z.literal(keeploreProductionBranch),
        headBranch: z.string().min(1).max(200),
        headCommit: delegationCommitSchema,
        state: z.literal("open"),
        url: z.url().startsWith(`https://github.com/${keeploreRepository}/pull/`),
      })
      .strict(),
    repository: z.literal(keeploreRepository),
  })
  .strict();

/**
 * All the publisher will say about a refusal outside the Agent Host.
 *
 * The publisher re-derives production branch rules, App grants, and a
 * Delegation's registered assignment, so its reasons describe host state a
 * Subagent must not learn. The code names the phase that refused — enough for
 * the runner to report a boundary refusal rather than a rejected candidate —
 * and the reason itself stays in the publisher's journal. `unattributed` is
 * the publisher failing before it reached a check, which is a defect in that
 * service rather than a refusal of this candidate.
 */
export const keeploreCandidatePublicationRefusalSchema = z
  .object({
    error: z.literal("publication-refused"),
    refusal: z.enum([
      "candidate",
      "policy",
      "publication",
      "request",
      "unattributed",
    ]),
  })
  .strict();

export const keeploreWorktreeSchema = delegationWorktreeSchema;

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
        registeredCodebaseId: keeploreRegisteredCodebaseIdSchema,
        productionBranch: z.literal(keeploreProductionBranch),
        provider: z.literal("codex"),
        readScope: z.array(z.string().min(1).max(200)).min(1).max(20),
        repository: z.literal(keeploreRepository),
        revision: z.number().int().positive(),
        sourceCommit: delegationCommitSchema,
        verificationCommand: z.string().min(1).max(200),
        worktreeRoot: absolutePathSchema,
      })
      .strict(),
  })
  .strict();

export const keeploreComputedButtonStyleSchema = z
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
    /**
     * Whether the control's width follows its content. A control that did not
     * widen when probed is recorded as `fixed` rather than refused, so the
     * acceptance gates can name the width failure instead of reporting that no
     * measurement arrived at all.
     */
    widthMode: z.enum(["content", "fixed"]),
  })
  .strict();

export const keeploreScreenshotSchema = z
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

export const keeploreDelegationResultSchema = z
  .object({
    ...delegationResultSharedFields,
    delegationId: identifierSchema,
    cleanup: z
      .object({
        eligible: z.boolean(),
        quarantineReason: z.string().min(1).max(300).nullable(),
      })
      .strict(),
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
    verification: z
      .object({
        automated: delegationAutomatedVerificationResultsSchema,
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
                getRidOf: keeploreComputedButtonStyleSchema,
                remove: keeploreComputedButtonStyleSchema,
                viewport: z.enum(["desktop", "mobile"]),
              })
              .strict(),
          )
          .max(4),
        screenshots: z.array(keeploreScreenshotSchema).max(4),
      })
      .strict(),
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

export type KeeploreComputedButtonStyle = z.infer<
  typeof keeploreComputedButtonStyleSchema
>;
export type KeeploreWorktree = z.infer<typeof keeploreWorktreeSchema>;
export type KeeploreCandidatePublicationRequest = z.infer<
  typeof keeploreCandidatePublicationRequestSchema
>;
export type KeeploreCandidatePublicationResult = z.infer<
  typeof keeploreCandidatePublicationResultSchema
>;
export type KeeploreCandidatePublicationRefusal = z.infer<
  typeof keeploreCandidatePublicationRefusalSchema
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
