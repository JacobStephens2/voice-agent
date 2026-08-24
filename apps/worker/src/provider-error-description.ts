import type {
  TelephoneProviderFailureRecovery,
  TelephoneProviderFailureStage,
} from "@voice-agent/contracts";
import { TelephoneSessionFault } from "@voice-agent/runtime";

const maximumMessageLength = 200;

/**
 * What a bounded provider failure may say about itself in a log line.
 *
 * A Telephone Session that dies on a provider fault is otherwise indist-
 * inguishable from any other provider fault: the durable Evidence Record
 * deliberately carries only the stage and the failure class. This is the
 * operator's copy — enough to name the fault, and nothing that would move
 * the caller's speech out of the Telephone Session.
 */
export interface ProviderErrorDescription {
  readonly code?: string;
  readonly message?: string;
  readonly name: string;
  readonly status?: number;
}

/**
 * Describe a provider error without carrying caller content into the log.
 *
 * A provider's message is kept only for the stages whose provider never
 * receives the caller's words. Recognition is given the caller's audio and may
 * quote the transcript back in its error; interpretation is given that
 * transcript in its prompt and may echo it the same way. Synthesis and session
 * setup see only the agent's own text, which is already recorded as evidence,
 * so their messages are the ones worth keeping.
 *
 * A [TelephoneSessionFault] is this codebase describing its own broken
 * invariant in a fixed string, so its message is kept at every stage.
 */
export function describeProviderError(
  error: unknown,
  stage: TelephoneProviderFailureStage,
): ProviderErrorDescription {
  if (!(error instanceof Error)) {
    return { name: error === null ? "null" : typeof error };
  }
  const carrier = error as unknown as Record<string, unknown>;
  const code = typeof carrier.code === "string" ? carrier.code : undefined;
  const status = typeof carrier.status === "number" ? carrier.status : undefined;
  const message =
    error instanceof TelephoneSessionFault || !stageSeesCallerSpeech(stage)
      ? sanitizeMessage(error.message)
      : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    name: error.constructor.name === "" ? "Error" : error.constructor.name,
    ...(status === undefined ? {} : { status }),
  };
}

function stageSeesCallerSpeech(
  stage: TelephoneProviderFailureStage,
): boolean {
  return stage === "stt" || stage === "coordinator";
}

function sanitizeMessage(message: string): string | undefined {
  // Control characters would split one failure across several log lines.
  const collapsed = message
    .replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  if (collapsed === "") return undefined;
  return collapsed.length > maximumMessageLength
    ? `${collapsed.slice(0, maximumMessageLength - 1)}…`
    : collapsed;
}

/** One operator-facing report of a bounded provider failure. */
export interface ProviderFailureLogEntry {
  readonly error: ProviderErrorDescription;
  readonly provider: string;
  readonly recovery: TelephoneProviderFailureRecovery;
  readonly stage: TelephoneProviderFailureStage;
  readonly telephoneSessionId: string;
}

export type ProviderFailureLogger = (entry: ProviderFailureLogEntry) => void;

/**
 * The default sink. The worker's other log lines come from the agents
 * framework's own logger, so this matches their shape and lands in the same
 * journal without adding a logging dependency to a privileged service.
 */
export const logProviderFailureToStandardError: ProviderFailureLogger = (
  entry,
) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 50,
      msg: "bounded telephone provider failure",
      time: Date.now(),
      ...entry,
    })}\n`,
  );
};
