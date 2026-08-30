import { createHash } from "node:crypto";

import { speechStageModel } from "@voice-agent/contracts";
import type {
  ConfiguredSpeechSynthesis,
  RecognizedSpeechModel,
  TelephoneEvidenceEvent,
  TelephoneProviderFailureStage,
} from "@voice-agent/contracts";

import { mapProviderFailureEvent } from "./livekit-telephone-session.ts";
import {
  describeProviderError,
  logProviderFailureToStandardError,
  type ProviderFailureLogger,
} from "./provider-error-description.ts";

export class TelephoneSetupProviderError extends Error {
  readonly stage: TelephoneProviderFailureStage;
  readonly providerError: unknown;

  constructor(
    stage: TelephoneProviderFailureStage,
    providerError: unknown,
  ) {
    super(`Telephone ${stage} setup provider failed`);
    this.stage = stage;
    this.providerError = providerError;
  }
}

export async function recordTelephoneSetupProviderFailure(input: {
  readonly append: (
    event: Omit<TelephoneEvidenceEvent, "sequence">,
  ) => Promise<unknown>;
  readonly error: unknown;
  readonly failureEventId: string;
  /** Defaults to the operator journal; a test supplies its own sink. */
  readonly log?: ProviderFailureLogger;
  readonly occurredAt: string;
  /**
   * The Recognized Speech Model in use: the machine detector raises its
   * recognition faults through this path, so the provider recorded for them
   * must follow the configured entry too.
   */
  readonly recognition: RecognizedSpeechModel;
  readonly recordProviderFailure: (input: {
    readonly failureClass: "timeout" | "unavailable";
    readonly sessionId: string;
    readonly stage: TelephoneProviderFailureStage;
  }) => Promise<unknown>;
  /**
   * The Recognized Synthesis Model in use: a fixed text this path plays is
   * spoken through it, so a synthesis fault recorded here names the provider
   * and model that actually raised it.
   */
  readonly synthesis: ConfiguredSpeechSynthesis;
  readonly telephoneSessionId: string;
}): Promise<void> {
  if (!(input.error instanceof TelephoneSetupProviderError)) return;
  const classified = {
    error: input.error.providerError,
    stage: input.error.stage,
  };
  const correlation = createHash("sha256")
    .update(input.failureEventId)
    .digest("hex")
    .slice(0, 32);
  const failure = mapProviderFailureEvent({
    deliveryId: correlation,
    error: classified.error,
    occurredAt: input.occurredAt,
    recognition: input.recognition,
    stage: classified.stage,
    synthesis: input.synthesis,
  });
  const failureClass =
    failure.kind === "provider-timeout" ? "timeout" : "unavailable";
  // The detector raises its recognition faults here and a fixed text is spoken
  // here, so this evidence carries the configured model of whichever speech
  // stage raised the fault, for the same reason the session's does.
  const speechModel = speechStageModel(
    { recognition: input.recognition, synthesis: input.synthesis },
    failure.stage,
  );
  // Setup faults end the call before it is answered, so this line is the only
  // description of them that survives.
  (input.log ?? logProviderFailureToStandardError)({
    error: describeProviderError(classified.error, classified.stage),
    provider: failure.provider,
    recovery: "terminal",
    stage: failure.stage,
    telephoneSessionId: input.telephoneSessionId,
  });
  await input.append({
    details:
      failure.kind === "provider-timeout"
        ? {
            failure: "timeout",
            ...speechModel,
            provider: failure.provider,
            stage: failure.stage,
            timeoutMs: failure.timeoutMs,
          }
        : {
            failure: "unavailable",
            ...speechModel,
            provider: failure.provider,
            stage: failure.stage,
          },
    id: `setup-provider-failure:${correlation}`,
    kind: "telephone.provider.failure",
    occurredAt: input.occurredAt,
    summary: "Telephone setup reached a bounded provider failure.",
  });
  await input.recordProviderFailure({
    failureClass,
    sessionId: input.telephoneSessionId,
    stage: failure.stage,
  });
}
