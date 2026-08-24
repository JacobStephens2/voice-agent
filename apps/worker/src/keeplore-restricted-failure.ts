import type { KeeploreDelegationFailure } from "@voice-agent/contracts";

import {
  describeErrorName,
  sanitizeErrorMessage,
  writeOperatorLogLine,
} from "./error-description.ts";

const maximumMessageLength = 300;
const maximumRetainedStderrBytes = 64_000;

/**
 * What the sandbox itself says when it never started.
 *
 * `bwrap` reports a mount, namespace, or Landlock setup failure on its own
 * standard error, prefixed with its name, before the model process exists. A
 * restricted run that ends this way never reached the model, so it is a
 * different fault from a model that ran and declined to prepare a candidate.
 * One line must name both the sandbox and a failure: a runner that merely
 * mentions its sandbox while failing at something else is not this fault.
 */
const bwrapReport = /^\s*bwrap:/u;
const sandboxSubject =
  /\b(?:bwrap|landlock|seccomp|pivot_root|namespace|mount|bind|sandbox)\b/iu;
const failureSubject =
  /\b(?:fail(?:ed|ure)?|denied|refused|unable|not permitted)\b/iu;

/** What a bounded command had already said when its bound stopped it. */
export interface BoundedCommandResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

/**
 * A command stopped by its own bounds, with whatever it had already said.
 *
 * The output that names the fault would otherwise be discarded with the bound
 * that threw it away, so a flooded or hung restricted runner keeps its partial
 * account of itself.
 */
export class BoundedCommandError extends Error {
  readonly result: BoundedCommandResult;

  constructor(message: string, result: BoundedCommandResult) {
    super(message);
    this.result = result;
  }
}

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
  run: BoundedCommandResult,
  knownKind?: KeeploreDelegationFailure["kind"],
): RestrictedRunnerEvidence {
  const truncated = run.stderr.length > maximumRetainedStderrBytes;
  return {
    exitCode: run.exitCode,
    kind:
      knownKind ??
      (namesSandboxInitialization(run.stderr)
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
 * The runner's account of a run that ended in this error, when it has one.
 *
 * A run stopped by its own output or time bound never returned a result, so
 * the partial output carried by that bound is the only account of it.
 */
export function restrictedRunEvidenceFor(
  error: unknown,
  runnerResult: BoundedCommandResult | undefined,
): RestrictedRunnerEvidence | undefined {
  if (error instanceof BoundedCommandError) {
    return buildRestrictedRunnerEvidence(error.result);
  }
  if (runnerResult === undefined) return undefined;
  return buildRestrictedRunnerEvidence(
    runnerResult,
    error instanceof RestrictedRunFailure ? error.kind : "delegation-execution",
  );
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
    ...describeError(error),
  };
}

/** Name a thrown value by its type and its own bounded message. */
export function describeError(error: unknown): {
  readonly message: string;
  readonly name: string;
} {
  return {
    message:
      (error instanceof Error
        ? sanitizeErrorMessage(error.message, maximumMessageLength)
        : undefined) ?? "Restricted execution failed without a described error",
    name: describeErrorName(error),
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
  writeOperatorLogLine({
    level: 50,
    msg: "keeplore delegation failed",
    ...entry,
  });
}

/**
 * Say when evidence was lost.
 *
 * Retaining evidence is best effort, but a directory the restricted identity
 * cannot write is exactly the fault this reporting exists to name. Losing it
 * silently would repeat the defect one level down.
 */
export function logEvidenceRetentionFailure(entry: {
  readonly delegationId: string;
  readonly error: unknown;
}): void {
  writeOperatorLogLine({
    level: 40,
    msg: "keeplore delegation evidence was not retained",
    delegationId: entry.delegationId,
    error: describeError(entry.error),
  });
}

function namesSandboxInitialization(stderr: string): boolean {
  return stderr
    .split("\n")
    .some(
      (line) =>
        bwrapReport.test(line) ||
        (sandboxSubject.test(line) && failureSubject.test(line)),
    );
}
