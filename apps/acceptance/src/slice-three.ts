import { z } from "zod";

import { isAuthenticatedTaskUrl } from "./authenticated-task-url.ts";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const evidenceRecordUrlSchema = z
  .url()
  .max(500)
  .refine(isAuthenticatedTaskUrl, {
    message: "Evidence Record links must use the authenticated Voice Agent origin",
  });

const trialPublishedEventSchema = z
  .object({
    branch: z.string().min(1).max(200),
    kind: z.literal("trial-published"),
    pullRequestUrl: z.url().startsWith("https://github.com/").max(500),
    recordedAt: timestampSchema,
  })
  .strict();

const humanMergeEventSchema = z
  .object({
    actor: z.string().min(1).max(120),
    commit: commitSchema,
    kind: z.literal("human-merge"),
    mergedAt: timestampSchema,
    recordedAt: timestampSchema,
  })
  .strict();

/**
 * One post-Promotion observation of production. It records the real outcome —
 * including a rollback — so a failed verification is retained rather than
 * retried away, and acceptance can never be reached without a passing one.
 */
const productionVerificationEventSchema = z
  .object({
    appearance: z.enum(["failed", "passed"]),
    cardView: z.enum(["regressed", "unchanged"]),
    commit: commitSchema,
    evidenceRecordUrl: evidenceRecordUrlSchema,
    health: z.enum(["healthy", "unhealthy"]),
    kind: z.literal("production-verification"),
    recordedAt: timestampSchema,
    rollback: z.enum(["none", "performed"]),
    screenshots: z
      .object({ desktop: z.boolean(), mobile: z.boolean() })
      .strict(),
  })
  .strict();

const sliceThreeAcceptedEventSchema = z
  .object({
    acceptedBy: z.literal("owner"),
    kind: z.literal("slice-three-accepted"),
    recordedAt: timestampSchema,
  })
  .strict();

const sliceThreeAcceptanceEventSchema = z.discriminatedUnion("kind", [
  trialPublishedEventSchema,
  humanMergeEventSchema,
  productionVerificationEventSchema,
  sliceThreeAcceptedEventSchema,
]);

const sliceThreeAcceptanceRecordSchema = z
  .object({
    campaignId: identifierSchema,
    events: z.array(sliceThreeAcceptanceEventSchema).max(1_000),
    schemaVersion: z.literal(1),
  })
  .strict();

export type SliceThreeAcceptanceEvent = z.infer<
  typeof sliceThreeAcceptanceEventSchema
>;
export type SliceThreeProductionVerificationEvent = z.infer<
  typeof productionVerificationEventSchema
>;
export type SliceThreeAcceptanceRecord = z.infer<
  typeof sliceThreeAcceptanceRecordSchema
>;

export interface SliceThreeAcceptanceEvaluation {
  readonly accepted: boolean;
  readonly errors: readonly string[];
  readonly ready: boolean;
  readonly verifiedCommit: string | null;
}

export function createSliceThreeAcceptanceRecord(input: {
  readonly campaignId: string;
}): SliceThreeAcceptanceRecord {
  return sliceThreeAcceptanceRecordSchema.parse({
    ...input,
    events: [],
    schemaVersion: 1,
  });
}

export function parseSliceThreeAcceptanceRecord(
  input: unknown,
): SliceThreeAcceptanceRecord {
  return sliceThreeAcceptanceRecordSchema.parse(input);
}

export function appendSliceThreeAcceptanceEvent(
  untrustedRecord: SliceThreeAcceptanceRecord,
  untrustedEvent: unknown,
): SliceThreeAcceptanceRecord {
  const record = sliceThreeAcceptanceRecordSchema.parse(untrustedRecord);
  const event = sliceThreeAcceptanceEventSchema.parse(untrustedEvent);
  if (record.events.some((candidate) => candidate.kind === "slice-three-accepted")) {
    throw new Error("Accepted slice-three records are terminal");
  }
  const previousEvent = record.events.at(-1);
  if (
    previousEvent !== undefined &&
    event.recordedAt.localeCompare(previousEvent.recordedAt) < 0
  ) {
    throw new Error("Acceptance Events must be appended in recorded-time order");
  }
  // Production can only be verified for a commit an authenticated human merged;
  // a verification recorded against anything else is not this trial's.
  if (event.kind === "production-verification") {
    const merged = record.events.some(
      (candidate) =>
        candidate.kind === "human-merge" && candidate.commit === event.commit,
    );
    if (!merged) {
      throw new Error(
        "Production verification must follow the Human Merge of the same commit",
      );
    }
  }
  return sliceThreeAcceptanceRecordSchema.parse({
    ...record,
    events: [...record.events, event],
  });
}

export function evaluateSliceThreeAcceptance(
  untrustedRecord: SliceThreeAcceptanceRecord,
): SliceThreeAcceptanceEvaluation {
  const record = sliceThreeAcceptanceRecordSchema.parse(untrustedRecord);
  const errors: string[] = [];
  if (!record.events.some((event) => event.kind === "trial-published")) {
    errors.push("The trial has not published a reviewed pull request.");
  }
  const merge = record.events.findLast((event) => event.kind === "human-merge");
  if (merge === undefined) {
    errors.push("No authenticated Human Merge has been recorded.");
  }
  const verification = record.events.findLast(
    (event): event is SliceThreeProductionVerificationEvent =>
      event.kind === "production-verification" &&
      (merge === undefined || event.commit === merge.commit),
  );
  if (verification === undefined) {
    errors.push("Production has not been verified after the Human Merge.");
  } else {
    if (verification.health !== "healthy") {
      errors.push("Production health verification did not pass.");
    }
    if (verification.appearance !== "passed") {
      errors.push("Production table-view appearance verification did not pass.");
    }
    if (verification.cardView !== "unchanged") {
      errors.push("Card view regressed in production.");
    }
    if (!verification.screenshots.desktop || !verification.screenshots.mobile) {
      errors.push(
        "Authenticated production desktop and mobile evidence is incomplete.",
      );
    }
    if (verification.rollback !== "none") {
      errors.push("The Promotion rolled back, so the feature is not complete.");
    }
  }
  return {
    accepted: record.events.some((event) => event.kind === "slice-three-accepted"),
    errors,
    ready: errors.length === 0,
    verifiedCommit: errors.length === 0 ? (verification?.commit ?? null) : null,
  };
}

export function markSliceThreeAccepted(
  record: SliceThreeAcceptanceRecord,
  input: { readonly recordedAt: string },
): SliceThreeAcceptanceRecord {
  if (!evaluateSliceThreeAcceptance(record).ready) {
    throw new Error(
      "Slice three is accepted only after production verification succeeds following Human Merge",
    );
  }
  return appendSliceThreeAcceptanceEvent(record, {
    acceptedBy: "owner",
    kind: "slice-three-accepted",
    recordedAt: input.recordedAt,
  });
}
