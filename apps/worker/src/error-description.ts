/**
 * How this worker names a thrown value and writes about it.
 *
 * Two bounded failures are reported to the operator from this worker — a
 * telephone provider fault (ADR-0050) and a failed Keeplore Delegation
 * (ADR-0051). They describe different things, but a divergence in how they
 * name an error or shape a log line would show up as two log formats in one
 * journal, so the naming, the sanitizing, and the envelope live here.
 */

/** Name a thrown value by its type. */
export function describeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return error === null ? "null" : typeof error;
  return error.constructor.name === "" ? "Error" : error.constructor.name;
}

/** Reduce a message to one bounded log-safe line, or nothing if it is empty. */
export function sanitizeErrorMessage(
  message: string,
  maximumLength: number,
): string | undefined {
  // Control characters would split one failure across several log lines.
  const collapsed = message.replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length > maximumLength
    ? `${collapsed.slice(0, maximumLength - 1)}…`
    : collapsed;
}

/**
 * The worker's other log lines come from the agents framework's own logger, so
 * an operator report matches their shape and lands in the same journal without
 * adding a logging dependency to a privileged service.
 */
export function writeOperatorLogLine(entry: {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}): void {
  process.stderr.write(`${JSON.stringify({ time: Date.now(), ...entry })}\n`);
}
