import { z } from "zod";

import type { GrokRunnerPin } from "./grok-delegation.ts";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const absolutePathSchema = z.string().min(1).max(500).startsWith("/");
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);

const runnerSchema = z
  .object({
    configurationPath: absolutePathSchema,
    digest: digestSchema,
    version: versionSchema,
  })
  .strict();

/**
 * Every ending this provider must demonstrate before it is used for work.
 *
 * The state each condition must reach is fixed here, so a drill cannot be
 * recorded as proving something it did not prove. A quota refusal that "failed"
 * would have lost the Durable Task; a malformed result that "paused" would wait
 * forever for a provider that is behaving normally.
 */
export const grokFailureDrillOutcomes = {
  "authentication-failure": "paused",
  "entitlement-failure": "paused",
  "malformed-output": "failed",
  "provider-contract-drift": "paused",
  "quota-exhaustion": "paused",
  "signal-interruption": "stopped",
  timeout: "failed",
  "turn-limit": "failed",
} as const;

export const grokContractFailureConditions = [
  "authentication-failure",
  "entitlement-failure",
  "malformed-output",
  "provider-contract-drift",
  "quota-exhaustion",
  "signal-interruption",
  "timeout",
  "turn-limit",
] as const satisfies ReadonlyArray<keyof typeof grokFailureDrillOutcomes>;

export type GrokContractFailureCondition =
  (typeof grokContractFailureConditions)[number];

const runnerPinnedEventSchema = z
  .object({
    configurationPath: absolutePathSchema,
    digest: digestSchema,
    kind: z.literal("runner-pinned"),
    recordedAt: timestampSchema,
    selfUpdateDisabled: z.literal(true),
    version: versionSchema,
  })
  .strict();

/**
 * The attended device authorization, and the two things it must have left
 * true: no API key is available to the runner, and the provider's code-data
 * retention setting was observed rather than assumed.
 */
const subscriptionEnrolledEventSchema = z
  .object({
    apiKeyAbsent: z.literal(true),
    authenticationRoute: z.literal("subscription-oauth"),
    codeRetentionDisabled: z.boolean(),
    kind: z.literal("subscription-enrolled"),
    recordedAt: timestampSchema,
  })
  .strict();

/** One real run, described by what the provider itself reported about it. */
const contractRunEventSchema = z
  .object({
    authenticationRoute: z.literal("subscription-oauth"),
    kind: z.literal("contract-run"),
    model: z.string().min(1).max(200),
    recordedAt: timestampSchema,
    runner: runnerSchema,
    sessionId: z.string().min(1).max(200),
    stopReason: z.string().min(1).max(120),
    usageIncomplete: z.boolean(),
  })
  .strict();

const custodyProbeEventSchema = z
  .object({
    canarySecretsFound: z.number().int().nonnegative(),
    kind: z.literal("custody-probe"),
    readableBoundaryPaths: z.number().int().nonnegative(),
    recordedAt: timestampSchema,
  })
  .strict();

const failureDrillEventSchema = z
  .object({
    condition: z.enum(grokContractFailureConditions),
    fellBackToAnotherProvider: z.boolean(),
    kind: z.literal("failure-drill"),
    outcome: z.enum(["failed", "paused", "stopped"]),
    recordedAt: timestampSchema,
  })
  .strict();

const stopDrillEventSchema = z
  .object({
    commitsPreserved: z.boolean(),
    destructiveGitCommands: z.number().int().nonnegative(),
    kind: z.literal("stop-drill"),
    recordedAt: timestampSchema,
    unfinishedWorkPreserved: z.boolean(),
  })
  .strict();

const acceptedEventSchema = z
  .object({
    acceptedBy: z.literal("owner"),
    kind: z.literal("grok-enrollment-accepted"),
    recordedAt: timestampSchema,
  })
  .strict();

const grokEnrollmentEventSchema = z.discriminatedUnion("kind", [
  runnerPinnedEventSchema,
  subscriptionEnrolledEventSchema,
  contractRunEventSchema,
  custodyProbeEventSchema,
  failureDrillEventSchema,
  stopDrillEventSchema,
  acceptedEventSchema,
]);

const grokEnrollmentRecordSchema = z
  .object({
    campaignId: identifierSchema,
    events: z.array(grokEnrollmentEventSchema).max(1_000),
    schemaVersion: z.literal(1),
  })
  .strict();

export type GrokEnrollmentEvent = z.infer<typeof grokEnrollmentEventSchema>;
export type GrokEnrollmentRecord = z.infer<typeof grokEnrollmentRecordSchema>;

export interface GrokEnrollmentEvaluation {
  /** The provider may be used for work right now. */
  readonly activated: boolean;
  readonly errors: readonly string[];
  readonly pinnedRunner: GrokRunnerPin | null;
  readonly ready: boolean;
}

export function createGrokEnrollmentRecord(input: {
  readonly campaignId: string;
}): GrokEnrollmentRecord {
  return grokEnrollmentRecordSchema.parse({
    ...input,
    events: [],
    schemaVersion: 1,
  });
}

export function parseGrokEnrollmentRecord(input: unknown): GrokEnrollmentRecord {
  return grokEnrollmentRecordSchema.parse(input);
}

export function appendGrokEnrollmentEvent(
  untrustedRecord: GrokEnrollmentRecord,
  untrustedEvent: unknown,
): GrokEnrollmentRecord {
  const record = grokEnrollmentRecordSchema.parse(untrustedRecord);
  const event = grokEnrollmentEventSchema.parse(untrustedEvent);
  const previousEvent = record.events.at(-1);
  if (
    previousEvent !== undefined &&
    event.recordedAt.localeCompare(previousEvent.recordedAt) < 0
  ) {
    throw new Error("Enrollment Events must be appended in recorded-time order");
  }
  // A run proves the boundaries of the binary it ran. Recording one against a
  // different build would let a reviewed contract vouch for unreviewed bytes.
  if (event.kind === "contract-run") {
    const pinned = pinnedRunnerOf(record.events);
    if (
      pinned === null ||
      pinned.configurationPath !== event.runner.configurationPath ||
      pinned.digest !== event.runner.digest ||
      pinned.version !== event.runner.version
    ) {
      throw new Error("A contract run must be recorded against the pinned runner");
    }
  }
  if (
    event.kind === "failure-drill" &&
    grokFailureDrillOutcomes[event.condition] !== event.outcome
  ) {
    throw new Error(
      `A ${event.condition} drill must end ${grokFailureDrillOutcomes[event.condition]}, not ${event.outcome}`,
    );
  }
  if (event.kind === "grok-enrollment-accepted" && !evaluateGrokEnrollment(record).ready) {
    throw new Error(
      "Grok is accepted only after the contract test passes for the pinned runner",
    );
  }
  return grokEnrollmentRecordSchema.parse({
    ...record,
    events: [...record.events, event],
  });
}

/**
 * Judge the enrollment of the runner that is pinned right now.
 *
 * Everything is evaluated from the most recent `runner-pinned` event forward.
 * That is what makes a provider upgrade unable to inherit the previous build's
 * acceptance: pinning new bytes discards every proof that belonged to the old
 * ones, and the contract has to pass again before the provider is activated.
 */
export function evaluateGrokEnrollment(
  untrustedRecord: GrokEnrollmentRecord,
): GrokEnrollmentEvaluation {
  const record = grokEnrollmentRecordSchema.parse(untrustedRecord);
  const pinnedRunner = pinnedRunnerOf(record.events);
  if (pinnedRunner === null) {
    return {
      activated: false,
      errors: ["No reviewed runner version and digest are pinned."],
      pinnedRunner: null,
      ready: false,
    };
  }
  const events = record.events.slice(
    record.events.findLastIndex((event) => event.kind === "runner-pinned"),
  );
  const errors: string[] = [];
  if (!events.some((event) => event.kind === "subscription-enrolled")) {
    errors.push("No attended subscription device authorization has been recorded.");
  }
  if (!events.some((event) => event.kind === "contract-run")) {
    errors.push("No Grok Build run has completed through subscription OAuth.");
  }
  const probe = events.findLast((event) => event.kind === "custody-probe");
  if (probe === undefined) {
    errors.push("The Credential Custody Boundary has not been probed.");
  } else if (probe.readableBoundaryPaths > 0 || probe.canarySecretsFound > 0) {
    errors.push("The model process reached the Credential Custody Boundary.");
  }
  const drilled = new Set(
    events
      .filter((event) => event.kind === "failure-drill")
      .map((event) => event.condition),
  );
  const undrilled = grokContractFailureConditions.filter(
    (condition) => !drilled.has(condition),
  );
  if (undrilled.length > 0) {
    errors.push(
      `These failure conditions have not produced a durable pause or terminal state: ${undrilled.join(", ")}.`,
    );
  }
  if (
    events.some(
      (event) => event.kind === "failure-drill" && event.fellBackToAnotherProvider,
    )
  ) {
    errors.push("A failure drill fell back to another provider or billing route.");
  }
  const stop = events.findLast((event) => event.kind === "stop-drill");
  if (stop === undefined) {
    errors.push("Stopping a run has not been drilled.");
  } else if (
    !stop.commitsPreserved ||
    !stop.unfinishedWorkPreserved ||
    stop.destructiveGitCommands > 0
  ) {
    errors.push(
      "Stopping a run did not preserve completed commits and unfinished work.",
    );
  }
  return {
    activated:
      errors.length === 0 &&
      events.some((event) => event.kind === "grok-enrollment-accepted"),
    errors,
    pinnedRunner,
    ready: errors.length === 0,
  };
}

export function markGrokEnrollmentAccepted(
  record: GrokEnrollmentRecord,
  input: { readonly recordedAt: string },
): GrokEnrollmentRecord {
  return appendGrokEnrollmentEvent(record, {
    acceptedBy: "owner",
    kind: "grok-enrollment-accepted",
    recordedAt: input.recordedAt,
  });
}

function pinnedRunnerOf(
  events: readonly GrokEnrollmentEvent[],
): GrokRunnerPin | null {
  const pinned = events.findLast((event) => event.kind === "runner-pinned");
  return pinned === undefined
    ? null
    : {
        configurationPath: pinned.configurationPath,
        digest: pinned.digest,
        version: pinned.version,
      };
}
