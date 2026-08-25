import { isAPIError, UnexpectedModelBehavior } from "@livekit/agents";
import type {
  TelephoneProviderFailureRecovery,
  TelephoneProviderFailureStage,
} from "@voice-agent/contracts";

import {
  describeErrorName,
  sanitizeErrorMessage,
  writeOperatorLogLine,
} from "./error-description.ts";
import type {
  SpeechProviderErrorFrame,
  SpeechProviderFaultClass,
} from "./speech-provider-error-frame.ts";

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
  /** Which kind of fault the provider reported, when it said so. */
  readonly fault?: SpeechProviderFaultClass;
  readonly message?: string;
  readonly name: string;
  /** Whether the provider called the fault retryable, when it said so. */
  readonly retryable?: boolean;
  readonly status?: number;
}

/**
 * An error the agents framework reported on a speech or interpretation
 * provider's behalf.
 *
 * The framework names the failing provider on its session error events, so a
 * fault arriving that way is a provider's account of itself whatever class it
 * happens to be, and its message is treated as the provider's own.
 */
export class ProviderReportedError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("A speech provider reported a failure");
    this.cause = cause;
  }
}

/** The error a provider actually raised, whoever reported it. */
export function underlyingProviderError(error: unknown): unknown {
  return error instanceof ProviderReportedError ? error.cause : error;
}

/**
 * Describe a provider error without carrying caller content into the log.
 *
 * A message is withheld only where it may quote what the stage was handed:
 * recognition is given the caller's audio and interpretation is given the
 * resulting transcript in its prompt, so an error raised by either one's SDK —
 * or by a schema that names the value it rejected — is logged by type alone.
 * Every other error in this path is text authored in this repository, and
 * withholding those is what left a reproducible fault unnamed for three rounds
 * of diagnosis.
 *
 * Synthesis sees only the agent's own text, which is already recorded as
 * evidence, and session setup and the agent's own turn pipeline see no
 * provider output at all, so nothing is withheld at those stages.
 */
export function describeProviderError(
  reported: unknown,
  stage: TelephoneProviderFailureStage,
  frame?: SpeechProviderErrorFrame,
): ProviderErrorDescription {
  const error = underlyingProviderError(reported);
  const gateway = describeErrorFrame(frame, stage);
  if (!(error instanceof Error)) {
    return { ...gateway, name: describeErrorName(error) };
  }
  const carrier = error as unknown as Record<string, unknown>;
  const code = typeof carrier.code === "string" ? carrier.code : undefined;
  const status = describeStatus(carrier);
  const withheld =
    stageSeesCallerSpeech(stage) &&
    (reported instanceof ProviderReportedError ||
      messageMayQuoteItsInput(error));
  const message = withheld
    ? undefined
    : sanitizeErrorMessage(error.message, maximumMessageLength);
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...gateway,
    name: describeErrorName(error),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * What the provider's own error frame adds to the description.
 *
 * The gateway's code, fault class, and retryable flag are enumerated tokens it
 * wrote about itself, so they are kept at every stage; its free-text reason is
 * withheld under the same rule as any other provider message, since the stages
 * that see the caller's speech could have it quoted back to them.
 */
function describeErrorFrame(
  frame: SpeechProviderErrorFrame | undefined,
  stage: TelephoneProviderFailureStage,
): Partial<ProviderErrorDescription> {
  if (frame === undefined) return {};
  const reason = stageSeesCallerSpeech(stage) ? undefined : frame.reason;
  return {
    ...(frame.code === undefined ? {} : { code: frame.code }),
    fault: frame.fault,
    ...(reason === undefined ? {} : { message: reason }),
    ...(frame.retryable === undefined ? {} : { retryable: frame.retryable }),
  };
}

/**
 * Whether this error was written about something the stage was given rather
 * than about this system's own state.
 *
 * A speech or interpretation SDK error, a framework report of unexpected model
 * behaviour, and a schema validation error all describe untrusted input; a
 * validator is included by name because a rejected value is quoted in its
 * message and the schema instance that raised it may not be this module's.
 */
function messageMayQuoteItsInput(error: Error): boolean {
  return (
    isAPIError(error) ||
    error instanceof UnexpectedModelBehavior ||
    error.name === "ZodError"
  );
}

/** A provider SDK reports its response status under its own field name. */
function describeStatus(
  carrier: Record<string, unknown>,
): number | undefined {
  if (typeof carrier.status === "number") return carrier.status;
  // An SDK status error carries -1 where the request never reached a response.
  return typeof carrier.statusCode === "number" && carrier.statusCode >= 0
    ? carrier.statusCode
    : undefined;
}

function stageSeesCallerSpeech(
  stage: TelephoneProviderFailureStage,
): boolean {
  return stage === "stt" || stage === "coordinator";
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

/** The default sink: one operator log line on this worker's standard error. */
export const logProviderFailureToStandardError: ProviderFailureLogger = (
  entry,
) => {
  writeOperatorLogLine({
    level: 50,
    msg: "bounded telephone provider failure",
    ...entry,
  });
};
