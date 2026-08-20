import { z } from "zod";

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
    commit: commitSchema,
    merge: z
      .object({
        actor: z.string().min(1).max(120),
        mergedAt: timestampSchema,
        source: z.enum(["reconciliation", "webhook"]),
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
    restored: z.union([commitSchema, z.literal("")]).optional(),
    result: z.enum(["failed", "succeeded"]),
    stage: z.string().regex(/^[a-z-]+$/u).max(60),
    verification: z
      .object({
        actualStatus: z.number().int().min(0).max(599),
        expectedStatus: z.number().int().min(100).max(599),
      })
      .strict()
      .optional(),
  })
  .strict();

export type KeeplorePromotionAttemptRecord = z.infer<
  typeof keeplorePromotionAttemptRecordSchema
>;
