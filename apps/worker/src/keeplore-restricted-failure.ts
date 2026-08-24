import type { KeeploreDelegationFailure } from "@voice-agent/contracts";

const maximumMessageLength = 300;
const maximumRetainedStderrBytes = 64_000;

/**
 * Markers that only the sandbox itself writes.
 *
 * `bwrap` reports a mount, namespace, or Landlock setup failure on its own
 * standard error before the model process exists. A restricted run that ends
 * this way never reached the model, so it is a different fault from a model
 * that ran and declined to prepare a candidate.
 */
const sandboxInitializationMarkers = [
  /\bbwrap\b/iu,
  /\blandlock\b/iu,
  /\bseccomp\b/iu,
  /\bpivot_root\b/iu,
  /\bnamespace\b/iu,
  /sandbox[^\n]{0,40}(?:setup|initiali[sz])/iu,
  /(?:mount|bind)[^\n]{0,40}failed/iu,
] as const;

/** A restricted run that ended without a candidate, and what ended it. */
export class RestrictedRunFailure extends Error {
  readonly kind: KeeploreDelegationFailure["kind"];

  constructor(kind: KeeploreDelegationFailure["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * What the restricted runner said about its own failure.
 *
 * This is the runner's exit status and its standard error, and nothing else.
 * A Delegation Brief carries no raw voice transcript, and neither the brief
 * nor the prompt built from it reaches this record: the only input is the
 * bounded output of the command the trusted runner spawned.
 */
export interface RestrictedRunnerEvidence {
  readonly exitCode: number | null;
  readonly kind: KeeploreDelegationFailure["kind"];
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export const restrictedRunnerEvidenceFileName = "restricted-runner-failure.json";

/**
 * Build the retained account of a restricted run that produced no candidate.
 *
 * The kind is read from the runner's own output unless the caller already
 * knows it — a model that ran and declined leaves an ordinary zero exit.
 */
export function buildRestrictedRunnerEvidence(
  run: { readonly exitCode: number | null; readonly stderr: string },
  knownKind?: KeeploreDelegationFailure["kind"],
): RestrictedRunnerEvidence {
  const truncated = run.stderr.length > maximumRetainedStderrBytes;
  return {
    exitCode: run.exitCode,
    kind:
      knownKind ??
      (sandboxInitializationMarkers.some((marker) => marker.test(run.stderr))
        ? "sandbox-initialization"
        : "restricted-runner"),
    // The tail is what names the failure; the head is startup chatter.
    stderr: truncated
      ? run.stderr.slice(run.stderr.length - maximumRetainedStderrBytes)
      : run.stderr,
    stderrTruncated: truncated,
  };
}

/**
 * Describe the error that ended a Delegation for its Delegation Result.
 *
 * The restricted model's own report is the least reliable account of a run it
 * could not complete. This is the trusted runner's account of the same run:
 * the error's type, its message, the failure kind, and where the retained
 * evidence for it lives. Every message described here is authored in this
 * codebase or by a command it spawned, never by a caller.
 */
export function describeDelegationFailure(
  error: unknown,
  evidencePaths: readonly string[],
): KeeploreDelegationFailure {
  return {
    evidencePaths: [...evidencePaths],
    kind:
      error instanceof RestrictedRunFailure ? error.kind : "delegation-execution",
    message:
      (error instanceof Error ? sanitizeMessage(error.message) : undefined) ??
      "Restricted execution failed without a described error",
    name:
      error instanceof Error
        ? error.constructor.name === ""
          ? "Error"
          : error.constructor.name
        : error === null
          ? "null"
          : typeof error,
  };
}

/**
 * The operator's copy of a failed Delegation.
 *
 * The Subagent Runner forwards this executor's standard error to its own, so
 * this line lands in the Agent Host journal beside the service that ran it.
 */
export function logDelegationFailure(entry: {
  readonly delegationId: string;
  readonly failure: KeeploreDelegationFailure;
}): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 50,
      msg: "keeplore delegation failed",
      time: Date.now(),
      ...entry,
    })}\n`,
  );
}

function sanitizeMessage(message: string): string | undefined {
  // Control characters would split one failure across several log lines.
  const collapsed = message.replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length > maximumMessageLength
    ? `${collapsed.slice(0, maximumMessageLength - 1)}…`
    : collapsed;
}
