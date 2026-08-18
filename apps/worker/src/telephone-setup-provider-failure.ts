import { createHash } from "node:crypto";

import type {
  TelephoneEvidenceEvent,
  TelephoneProviderFailureStage,
} from "@voice-agent/contracts";

import { mapProviderFailureEvent } from "./livekit-telephone-session.ts";

export class TelephoneSetupProviderError extends Error {
  constructor(
    readonly stage: TelephoneProviderFailureStage,
    readonly providerError: unknown,
  ) {
    super(`Telephone ${stage} setup provider failed`);
  }
}

export async function recordTelephoneSetupProviderFailure(input: {
  readonly append: (
    event: Omit<TelephoneEvidenceEvent, "sequence">,
  ) => Promise<unknown>;
  readonly error: unknown;
  readonly failureEventId: string;
  readonly occurredAt: string;
  readonly recordProviderFailure: (input: {
    readonly failureClass: "timeout" | "unavailable";
    readonly sessionId: string;
    readonly stage: TelephoneProviderFailureStage;
  }) => Promise<unknown>;
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
    stage: classified.stage,
  });
  const failureClass =
    failure.kind === "provider-timeout" ? "timeout" : "unavailable";
  await input.append({
    details:
      failure.kind === "provider-timeout"
        ? {
            failure: "timeout",
            provider: failure.provider,
            stage: failure.stage,
            timeoutMs: failure.timeoutMs,
          }
        : {
            failure: "unavailable",
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
