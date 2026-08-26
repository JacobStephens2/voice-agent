import { z } from "zod";

import {
  keeploreProductionAppearanceVerdictSchema,
  keeploreRequiredCheckObservationSchema,
} from "./keeplore-trial-promotion.ts";

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const timestampSchema = z.iso.datetime();

/**
 * One line of the Agent Host's append-only Promotion Attempt journal.
 *
 * The journal is written by root-owned Bash outside this process, so it is
 * untrusted input (ADR-0042): every line is validated before it can contribute
 * to an Evidence Record, and a malformed line is skipped rather than trusted.
 */
export const keeplorePromotionAttemptRecordSchema = z
  .object({
    application: z.literal("keeplore-production"),
    attemptedAt: timestampSchema,
    /**
     * The required checks GitHub reported for the merge commit, read before the
     * Release was built. A Promotion that recorded no checks is not one that
     * found them passing.
     */
    checks: z.array(keeploreRequiredCheckObservationSchema).max(20).optional(),
    commit: commitSchema,
    /** The Deployment Contract revision this attempt was built under. */
    contractRevision: z.number().int().positive().optional(),
    merge: z
      .object({
        actor: z.string().min(1).max(120),
        mergedAt: timestampSchema,
        // `attended` is an operator-run re-promotion of a merge already
        // serving. The merge itself is still the original Human Merge; only
        // the way this attempt reached the promoter differs.
        source: z.enum(["attended", "reconciliation", "webhook"]),
      })
      .strict()
      .optional(),
    previous: z.union([commitSchema, z.literal("-"), z.string().max(300)]),
    release: z
      .object({
        id: z.string().min(1).max(200),
        path: z.string().min(1).max(500).startsWith("/"),
      })
      .strict()
      .optional(),
    /**
     * Present only on the attempts a re-promotion makes, which is what keeps a
     * re-promotion distinguishable from a first Promotion of the same commit.
     *
     * `step-back` switches production to the retained Release so the merge has
     * a genuinely different baseline to be measured against; `candidate`
     * promotes the merge commit again and is the attempt that carries the
     * appearance verdict; `restore` returns production to the merge commit
     * after a failed or timed-out `candidate`, so no run ends on the retained
     * Release. `mergeCommit` is the merge being re-verified, which is what ties
     * a `step-back` attempt of some other Release to this one.
     */
    repromotion: z
      .object({
        kind: z.enum(["candidate", "restore", "step-back"]),
        mergeCommit: commitSchema,
      })
      .strict()
      .optional(),
    restored: z.union([commitSchema, z.literal("")]).optional(),
    result: z.enum(["failed", "succeeded"]),
    stage: z.string().regex(/^[a-z-]+$/u).max(60),
    verification: z
      .object({
        actualStatus: z.number().int().min(0).max(599),
        // What the trusted Agent Host browser saw production render after the
        // switch. Absent on an attempt that never reached appearance
        // verification, which is why an unverified appearance can never read
        // as a passing one.
        appearance: keeploreProductionAppearanceVerdictSchema.optional(),
        expectedStatus: z.number().int().min(100).max(599),
      })
      .strict()
      .optional(),
  })
  .strict();

export type KeeplorePromotionAttemptRecord = z.infer<
  typeof keeplorePromotionAttemptRecordSchema
>;
