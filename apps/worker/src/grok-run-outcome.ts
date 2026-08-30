import {
  grokAuthenticationRoute,
  grokContractRunOutcomeSchema,
  grokModelReportSchema,
  grokModelSelector,
  grokProvider,
  type GrokContractRunOutcome,
  type GrokRunEvidence,
  type GrokRunnerPin,
} from "@voice-agent/contracts";
import { z } from "zod";

/**
 * The largest final result this contract will attempt to read.
 *
 * A structured result is a few kilobytes. Anything beyond this is a stream, a
 * transcript, or a runaway, and parsing it would be the first step towards
 * persisting it.
 */
const maximumResultBytes = 64_000;

/**
 * The provider's headless envelope around the model's own result.
 *
 * Only the fields this system records are read. The envelope may carry more,
 * and none of it is copied: durable evidence holds identity, stop reason, and
 * usage, never events or output.
 */
const envelopeSchema = z
  .object({
    auth_source: z.string().min(1).max(60),
    model: z.string().min(1).max(200),
    request_id: z.string().min(1).max(200).nullish(),
    result: z.union([z.string(), z.record(z.string(), z.unknown())]),
    session_id: z.string().min(1).max(200).nullish(),
    stop_reason: z.string().min(1).max(120),
    usage: z
      .object({
        cost: z
          .object({ amount: z.number().nonnegative(), currency: z.string().length(3) })
          .nullish(),
        incomplete: z.boolean(),
        input_tokens: z.number().int().nonnegative().nullish(),
        output_tokens: z.number().int().nonnegative().nullish(),
      })
      .loose(),
  })
  .loose();

const turnLimitStopReasons = new Set(["max_turns", "turn_limit"]);

/**
 * What the provider says when this subscription may not run right now.
 *
 * Each of these ends the run in a pause the owner can clear, so they are
 * matched before a nonzero exit is treated as a defect. The matching reads
 * only the runner's own standard error, and none of that text reaches the
 * outcome: the sentences below are authored here.
 */
const pauseSignals = [
  {
    detail:
      "The provider rejected the subscription login; a fresh device authorization is required.",
    pattern: /\b(?:401|unauthori[sz]ed|invalid[_ -]?token|login has expired|not logged in|reauthenticate)\b/iu,
    reason: "provider-authentication",
  },
  {
    detail:
      "The subscription is not entitled to this model; the task waits rather than changing route.",
    pattern: /\b(?:403|forbidden|not entitled|entitlement|subscription (?:does not|doesn't) (?:include|cover))\b/iu,
    reason: "provider-entitlement",
  },
  {
    detail:
      "The subscription's usage allowance is exhausted; the task waits for it to return.",
    pattern: /\b(?:429|rate[_ -]?limit(?:ed)?|quota|usage limit|too many requests)\b/iu,
    reason: "provider-quota",
  },
] as const;

export interface GrokRunObservation {
  /** The run was stopped for writing more than a structured result may hold. */
  readonly exceededOutputBound: boolean;
  readonly exitCode: number | null;
  readonly pin: GrokRunnerPin;
  /** The run's process group was terminated because Stop was requested. */
  readonly signalled: boolean;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/**
 * Name how one bounded provider execution ended.
 *
 * Every ending is explicit. A run that returns nothing readable is a failure
 * with a reason rather than an empty success, a run the provider refused is a
 * pause the owner can clear, and a run the owner stopped is neither. No
 * ending names another provider or another billing route, because there is no
 * ending that has one: the Durable Task and its worktrees outlive all four.
 */
export function describeGrokRunOutcome(
  observation: GrokRunObservation,
): GrokContractRunOutcome {
  return grokContractRunOutcomeSchema.parse(classify(observation));
}

function classify(observation: GrokRunObservation): GrokContractRunOutcome {
  if (observation.signalled) {
    return {
      detail:
        "Execution stopped at the owner's request; completed commits and unfinished work were left in place.",
      evidence: null,
      state: "stopped",
    };
  }
  if (observation.timedOut) {
    return {
      detail: "The run passed its time bound and its process group was stopped.",
      evidence: null,
      reason: "timeout",
      state: "failed",
    };
  }
  // A provider that refused this subscription is a pause however it said so.
  // Checking the runner's own error output only when nothing parsed would let
  // a well-formed envelope alongside a 401 fail the Durable Task instead.
  if (observation.exitCode !== 0) {
    const paused = pausedByProvider(observation.stderr);
    if (paused !== null) return paused;
  }
  const envelope = readEnvelope(observation.stdout, observation.exceededOutputBound);
  if (envelope === "oversized") {
    return {
      detail: "The provider returned more output than a structured result may contain.",
      evidence: null,
      reason: "malformed-output",
      state: "failed",
    };
  }
  if (envelope === "unreadable") {
    if (observation.exitCode !== 0) {
      return {
        detail: `The runner exited with code ${observation.exitCode ?? "unknown"} without returning a structured result.`,
        evidence: null,
        reason: "runner-execution",
        state: "failed",
      };
    }
    return {
      detail: "The provider returned output that is not one structured result.",
      evidence: null,
      reason: "malformed-output",
      state: "failed",
    };
  }
  if (envelope === "drifted") {
    return {
      detail:
        "The provider's headless result does not have the shape this contract was accepted against.",
      evidence: null,
      reason: "provider-contract-drift",
      state: "paused",
    };
  }
  if (envelope.auth_source !== "oauth") {
    return {
      detail: `The provider reported the ${envelope.auth_source} authentication route rather than the subscription.`,
      evidence: null,
      reason: "provider-contract-drift",
      state: "paused",
    };
  }
  const evidence = buildEvidence(envelope, observation.pin);
  if (turnLimitStopReasons.has(envelope.stop_reason)) {
    return {
      detail: "The provider stopped at the reviewed turn bound before returning a result.",
      evidence,
      reason: "turn-limit",
      state: "failed",
    };
  }
  const report = readReport(envelope.result);
  if (report === null) {
    return {
      detail:
        "The provider returned a final result that does not match the reviewed structured schema.",
      evidence,
      reason: "malformed-output",
      state: "failed",
    };
  }
  if (observation.exitCode !== 0) {
    return {
      detail: `The runner exited with code ${observation.exitCode ?? "unknown"} after returning a structured result.`,
      evidence,
      reason: "runner-execution",
      state: "failed",
    };
  }
  return { evidence, report, state: "completed" };
}

function readEnvelope(
  stdout: string,
  exceededOutputBound: boolean,
): z.infer<typeof envelopeSchema> | "drifted" | "oversized" | "unreadable" {
  if (exceededOutputBound) return "oversized";
  if (Buffer.byteLength(stdout, "utf8") > maximumResultBytes) return "oversized";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "unreadable";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unreadable";
  }
  const envelope = envelopeSchema.safeParse(parsed);
  return envelope.success ? envelope.data : "drifted";
}

function readReport(
  result: string | Record<string, unknown>,
): z.infer<typeof grokModelReportSchema> | null {
  let candidate: unknown = result;
  if (typeof result === "string") {
    try {
      candidate = JSON.parse(result);
    } catch {
      return null;
    }
  }
  const report = grokModelReportSchema.safeParse(candidate);
  return report.success ? report.data : null;
}

function pausedByProvider(stderr: string): GrokContractRunOutcome | null {
  for (const signal of pauseSignals) {
    if (signal.pattern.test(stderr)) {
      return {
        detail: signal.detail,
        evidence: null,
        reason: signal.reason,
        state: "paused",
      };
    }
  }
  return null;
}

function buildEvidence(
  envelope: z.infer<typeof envelopeSchema>,
  pin: GrokRunnerPin,
): GrokRunEvidence {
  return {
    authenticationRoute: grokAuthenticationRoute,
    model: { providerReported: envelope.model, selector: grokModelSelector },
    provider: grokProvider,
    requestId: envelope.request_id ?? null,
    runner: pin,
    sessionId: envelope.session_id ?? null,
    stopReason: envelope.stop_reason,
    usage: {
      // A subscription-backed run may report no cost at all. Recording that as
      // zero would claim the owner's allowance was not spent.
      cost: envelope.usage.cost ?? "unknown",
      incomplete: envelope.usage.incomplete,
      inputTokens: envelope.usage.input_tokens ?? null,
      outputTokens: envelope.usage.output_tokens ?? null,
    },
  };
}
