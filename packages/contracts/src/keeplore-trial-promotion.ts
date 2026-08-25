import { z } from "zod";

import {
  keeploreComputedButtonStyleSchema,
  keeploreScreenshotSchema,
} from "./keeplore-delegation.ts";
import { keeploreProductionBranch, keeploreRepository } from "./keeplore-onboarding.ts";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

/**
 * What the trusted verifier observed of Keeplore's *production* table view.
 *
 * The Delegation measured a candidate inside a Delegated Worktree; this is the
 * same measurement taken again against what production actually serves after a
 * Promotion switched to a Release. Nothing here is reported by a Subagent: the
 * Agent Host's own browser takes it, so a Delegation that claimed a passing
 * candidate cannot make production look verified.
 */
export const keeploreProductionAppearanceObservationSchema = z
  .object({
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
    health: z
      .object({
        actualStatus: z.number().int().min(0).max(599),
        expectedStatus: z.number().int().min(100).max(599),
      })
      .strict(),
    observedAt: timestampSchema,
    releaseCommit: commitSchema,
    screenshots: z.array(keeploreScreenshotSchema).max(4),
  })
  .strict();

export type KeeploreProductionAppearanceObservation = z.infer<
  typeof keeploreProductionAppearanceObservationSchema
>;

/**
 * The verdict a Promotion Attempt acts on: `failed` restores the retained
 * Release. `failures` names every unmet expectation rather than the first, so
 * one rollback report is enough to see what production actually rendered.
 */
export const keeploreProductionAppearanceVerdictSchema = z
  .object({
    failures: z.array(z.string().min(1).max(300)).max(20),
    outcome: z.enum(["failed", "passed"]),
  })
  .strict();

export type KeeploreProductionAppearanceVerdict = z.infer<
  typeof keeploreProductionAppearanceVerdictSchema
>;

export const keeploreTrialVerifiedConclusion =
  "Keeplore Button Trial is complete and verified in production." as const;
export const keeploreTrialRolledBackConclusion =
  "Keeplore Button Trial was promoted and rolled back; production is unchanged." as const;
export const keeploreTrialUnpromotedConclusion =
  "Keeplore Button Trial has not been promoted." as const;

export const keeploreButtonTrialConclusions = [
  keeploreTrialVerifiedConclusion,
  keeploreTrialRolledBackConclusion,
  keeploreTrialUnpromotedConclusion,
] as const;

/** One check run GitHub reported for a merge commit. */
export const keeploreRequiredCheckObservationSchema = z
  .object({
    conclusion: z.string().min(1).max(40),
    name: z.string().min(1).max(120),
  })
  .strict();

/**
 * The authenticated Voice Agent task link. A notice that pointed anywhere else
 * would be sending the owner somewhere they cannot open under their own
 * session, which is the one thing a Silent Notification is for.
 */
export function isAuthenticatedEvidenceRecordUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.origin === "https://voice.stephens.page" &&
    url.pathname === "/" &&
    url.searchParams.get("task") !== null
  );
}

export const authenticatedEvidenceRecordUrlSchema = z
  .url()
  .max(500)
  .refine(isAuthenticatedEvidenceRecordUrl, {
    message: "Evidence Record links must use the authenticated Voice Agent origin",
  });

/** How the owner was told the trial finished. */
export const keeploreTrialCompletionNoticeSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        evidenceRecordUrl: authenticatedEvidenceRecordUrlSchema,
        kind: z.literal("completion-callback"),
        outcome: z.literal("authorized"),
      })
      .strict(),
    z
      .object({
        evidenceRecordUrl: authenticatedEvidenceRecordUrlSchema,
        kind: z.literal("silent-notification"),
        // Why the generic email replaced the requested call, or that no call
        // was ever requested. The email itself carries no operational evidence.
        reason: z.enum([
          "callback-failed",
          "callback-unanswered",
          "callback-voicemail",
          "not-requested",
        ]),
      })
      .strict(),
  ]);

export type KeeploreTrialCompletionNotice = z.infer<
  typeof keeploreTrialCompletionNoticeSchema
>;

const trialEvidenceEventSchema = z
  .object({
    details: z.record(
      z.string().min(1).max(80),
      z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
    ),
    id: identifierSchema,
    kind: z.enum([
      "checks.recorded",
      "delegation.published",
      "merge.accepted",
      "notice.delivered",
      "release.built",
      "release.rolled-back",
      "release.verified",
      "request.confirmed",
      "trial.concluded",
      "worktree.retained",
      "worktree.removed",
    ]),
    occurredAt: timestampSchema,
    sequence: z.number().int().positive(),
    summary: z.string().min(1).max(300),
  })
  .strict();

/**
 * The trial's single terminal Evidence Record.
 *
 * Slice three ends in one record rather than several: the confirmed telephone
 * request, the Delegation, the pull request an authenticated human merged, the
 * Release that merge promoted, what production was observed to render, any
 * rollback, and the notice the owner received all project from the same task
 * identity. A reader who has only this record can follow the whole trial.
 */
export const keeploreButtonTrialEvidenceRecordSchema = z
  .object({
    evidence: z.array(trialEvidenceEventSchema).max(100),
    task: z
      .object({
        conclusion: z.enum(keeploreButtonTrialConclusions),
        createdAt: timestampSchema,
        id: identifierSchema,
        kind: z.literal("keeplore.button-trial"),
        status: z.enum(["completed", "failed", "pending"]),
        updatedAt: timestampSchema,
      })
      .strict(),
    trial: z
      .object({
        delegation: z
          .object({
            branch: z.string().min(1).max(200),
            changedFiles: z.array(z.string().min(1).max(300)).max(20),
            commits: z.array(commitSchema).max(20),
            delegationId: identifierSchema,
            pullRequestUrl: z
              .url()
              .startsWith(`https://github.com/${keeploreRepository}/pull/`),
            status: z.enum(["completed", "failed", "stopped"]),
          })
          .strict(),
        merge: z
          .object({
            actor: z.string().min(1).max(120),
            branch: z.literal(keeploreProductionBranch),
            commit: commitSchema,
            mergedAt: timestampSchema,
            repository: z.literal(keeploreRepository),
            source: z.enum(["reconciliation", "webhook"]),
          })
          .strict()
          .optional(),
        notice: keeploreTrialCompletionNoticeSchema.optional(),
        /**
         * What was known before the Release was built: the required checks
         * GitHub reported for the merge commit and the Deployment Contract
         * revision the attempt was built under.
         */
        promotion: z
          .object({
            checks: z.array(keeploreRequiredCheckObservationSchema).max(20),
            contractRevision: z.number().int().positive(),
          })
          .strict()
          .optional(),
        release: z
          .object({
            commit: commitSchema,
            id: z.string().min(1).max(200),
            path: z.string().min(1).max(500).startsWith("/"),
          })
          .strict()
          .optional(),
        request: z
          .object({
            confirmedAt: timestampSchema,
            requestId: identifierSchema,
            taskId: identifierSchema,
          })
          .strict(),
        rollback: z
          .object({
            attemptedReleaseCommit: commitSchema.optional(),
            performed: z.boolean(),
            restoredReleaseCommit: commitSchema.optional(),
          })
          .strict(),
        verification: z
          .object({
            appearance: keeploreProductionAppearanceVerdictSchema.optional(),
            /** Card view before and after the switch, hashed either side. */
            cardView: z
              .object({
                afterHash: z.string().min(1).max(200),
                beforeHash: z.string().min(1).max(200),
                unchanged: z.boolean(),
              })
              .strict()
              .optional(),
            health: z
              .object({
                actualStatus: z.number().int().min(0).max(599),
                expectedStatus: z.number().int().min(100).max(599),
                outcome: z.enum(["healthy", "unhealthy"]),
              })
              .strict()
              .optional(),
            screenshots: z.array(keeploreScreenshotSchema).max(4),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type KeeploreButtonTrialEvidenceRecord = z.infer<
  typeof keeploreButtonTrialEvidenceRecordSchema
>;

/**
 * Where the Agent Host writes production appearance evidence.
 *
 * Delegation evidence lives under the Delegation's own directory; production
 * evidence is taken by the trusted promoter after the switch and is kept apart
 * from it, so a Subagent-written path can never be read back as proof of what
 * production rendered.
 */
export const keeploreProductionEvidenceRoot =
  "/var/lib/voice-agent-evidence/keeplore-production/" as const;
