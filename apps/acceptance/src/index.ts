import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const releaseCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const verificationChecksSchema = z.object({
  deploymentHealth: z.literal("passed"),
  metricsScrape: z.literal("passed"),
  testSuite: z.literal("passed"),
  typecheck: z.literal("passed"),
}).strict();
const automatedVerificationEventSchema = z.object({
  checks: verificationChecksSchema,
  commit: releaseCommitSchema,
  kind: z.literal("automated-verification"),
  recordedAt: timestampSchema,
}).strict();
const pstnRunEventSchema = z.object({
  boundaries: z.enum(["failed", "passed"]),
  bountywellAnswer: z.enum(["correct", "incorrect"]),
  callbackHandshake: z.enum(["failed", "passed"]),
  carrier: z.enum(["att", "tello"]),
  completionNotice: z.enum(["failed", "not-requested", "sent"]),
  environment: z.enum(["indoor", "outdoor-walking"]),
  evidenceRecord: z.enum(["complete", "incomplete"]),
  interruptions: z.object({
    count: z.number().int().nonnegative().max(100),
    observation: z.string().min(1).max(500),
  }).strict(),
  kind: z.literal("pstn-run"),
  latency: z.object({
    callbackMs: z.number().int().nonnegative().max(120_000),
    healthAnswerMs: z.number().int().nonnegative().max(120_000),
  }).strict(),
  manualIntervention: z.boolean(),
  notes: z.string().min(1).max(500).optional(),
  recordedAt: timestampSchema,
  result: z.enum(["failed", "passed"]),
  sequence: z.number().int().positive(),
  taskUrl: z.string().url().max(500).refine(isAuthenticatedTaskUrl, {
    message: "Task link must use the authenticated Voice Agent origin",
  }),
  transcriptionObservation: z.string().min(1).max(500),
}).strict();
const sliceOneAcceptedEventSchema = z.object({
  acceptedBy: z.literal("owner"),
  kind: z.literal("slice-one-accepted"),
  recordedAt: timestampSchema,
}).strict();
const sliceOneAcceptanceEventSchema = z.discriminatedUnion("kind", [
  automatedVerificationEventSchema,
  pstnRunEventSchema,
  sliceOneAcceptedEventSchema,
]);
const sliceOneAcceptanceRecordSchema = z.object({
  campaignId: identifierSchema,
  events: z.array(sliceOneAcceptanceEventSchema).max(1_000),
  releaseCommit: releaseCommitSchema,
  schemaVersion: z.literal(1),
}).strict();

export type AutomatedVerificationEvent = z.infer<
  typeof automatedVerificationEventSchema
>;
export type PstnRunEvent = z.infer<typeof pstnRunEventSchema>;
export type SliceOneAcceptanceEvent = z.infer<
  typeof sliceOneAcceptanceEventSchema
>;
export type SliceOneAcceptanceRecord = z.infer<
  typeof sliceOneAcceptanceRecordSchema
>;

export interface SliceOneAcceptanceEvaluation {
  readonly accepted: boolean;
  readonly errors: readonly string[];
  readonly qualifyingRunSequences: readonly number[];
  readonly ready: boolean;
}

export function createSliceOneAcceptanceRecord(input: {
  readonly campaignId: string;
  readonly releaseCommit: string;
}): SliceOneAcceptanceRecord {
  return sliceOneAcceptanceRecordSchema.parse({
    ...input,
    events: [],
    schemaVersion: 1,
  });
}

export function parseSliceOneAcceptanceRecord(
  input: unknown,
): SliceOneAcceptanceRecord {
  return sliceOneAcceptanceRecordSchema.parse(input);
}

export function appendSliceOneAcceptanceEvent(
  untrustedRecord: SliceOneAcceptanceRecord,
  untrustedEvent: unknown,
): SliceOneAcceptanceRecord {
  const record = sliceOneAcceptanceRecordSchema.parse(untrustedRecord);
  const event = sliceOneAcceptanceEventSchema.parse(untrustedEvent);
  if (record.events.some((candidate) => candidate.kind === "slice-one-accepted")) {
    throw new Error("Accepted slice-one records are terminal");
  }
  const previousEvent = record.events.at(-1);
  if (
    previousEvent !== undefined &&
    event.recordedAt.localeCompare(previousEvent.recordedAt) < 0
  ) {
    throw new Error("Acceptance Events must be appended in recorded-time order");
  }
  if (event.kind === "automated-verification" && event.commit !== record.releaseCommit) {
    throw new Error("Automated verification must match the release commit");
  }
  if (event.kind === "pstn-run") {
    const expectedSequence =
      record.events.filter((candidate) => candidate.kind === "pstn-run").length + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(`PSTN run sequence must be ${expectedSequence}`);
    }
  }
  return sliceOneAcceptanceRecordSchema.parse({
    ...record,
    events: [...record.events, event],
  });
}

export function evaluateSliceOneAcceptance(
  untrustedRecord: SliceOneAcceptanceRecord,
): SliceOneAcceptanceEvaluation {
  const record = sliceOneAcceptanceRecordSchema.parse(untrustedRecord);
  const errors: string[] = [];
  const automatedVerificationPassed = record.events.some(
    (event) =>
      event.kind === "automated-verification" &&
      event.commit === record.releaseCommit,
  );
  if (!automatedVerificationPassed) {
    errors.push("Automated verification has not passed for the release commit.");
  }
  const runs = record.events.filter(
    (event): event is PstnRunEvent => event.kind === "pstn-run",
  );
  const consecutivePassingRuns: PstnRunEvent[] = [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run === undefined || !isPassingRun(run)) break;
    consecutivePassingRuns.unshift(run);
  }
  const qualifyingRuns =
    consecutivePassingRuns.length < 5
      ? []
      : consecutivePassingRuns.slice(-5);
  if (qualifyingRuns.length < 5) {
    errors.push("Five consecutive complete passing PSTN runs are required.");
  } else {
    if (!qualifyingRuns.some((run) => run.carrier === "att")) {
      errors.push("The qualifying sequence does not include the AT&T line.");
    }
    if (!qualifyingRuns.some((run) => run.carrier === "tello")) {
      errors.push("The qualifying sequence does not include the Tello line.");
    }
    if (!qualifyingRuns.some((run) => run.environment === "outdoor-walking")) {
      errors.push("The qualifying sequence does not include an outdoor walking run.");
    }
  }
  return {
    accepted: record.events.some((event) => event.kind === "slice-one-accepted"),
    errors,
    qualifyingRunSequences: qualifyingRuns.map((run) => run.sequence),
    ready: errors.length === 0,
  };
}

export function markSliceOneAccepted(
  record: SliceOneAcceptanceRecord,
  input: { readonly recordedAt: string },
): SliceOneAcceptanceRecord {
  if (!evaluateSliceOneAcceptance(record).ready) {
    throw new Error("Slice one is not ready for acceptance");
  }
  return appendSliceOneAcceptanceEvent(record, {
    acceptedBy: "owner",
    kind: "slice-one-accepted",
    recordedAt: input.recordedAt,
  });
}

function isPassingRun(run: PstnRunEvent): boolean {
  return run.result === "passed" &&
    run.callbackHandshake === "passed" &&
    run.bountywellAnswer === "correct" &&
    run.evidenceRecord === "complete" &&
    run.completionNotice !== "failed" &&
    !run.manualIntervention &&
    run.boundaries === "passed";
}

function isAuthenticatedTaskUrl(value: string): boolean {
  const url = new URL(value);
  return url.origin === "https://voice.stephens.page" &&
    url.pathname === "/" &&
    url.searchParams.get("task") !== null;
}
