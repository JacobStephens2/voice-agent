import { APITimeoutError } from "@livekit/agents";
import { defaultRecognizedSpeechModel } from "@voice-agent/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  recordTelephoneSetupProviderFailure,
  TelephoneSetupProviderError,
} from "../src/telephone-setup-provider-failure.ts";

describe("fixed-speech Telephone Session setup failures", () => {
  test("does not attribute an unclassified catch-path error to a provider", async () => {
    const append = vi.fn(async () => undefined);
    const recordProviderFailure = vi.fn(async () => ({ ended: true as const }));

    await recordTelephoneSetupProviderFailure({
      recognition: defaultRecognizedSpeechModel,
      append,
      error: new Error("durable application write failed"),
      failureEventId: "unclassified-catch-path-failure",
      occurredAt: "2026-08-17T20:00:00.000Z",
      recordProviderFailure,
      telephoneSessionId: "telephone-session-unclassified",
    });

    expect(append).not.toHaveBeenCalled();
    expect(recordProviderFailure).not.toHaveBeenCalled();
  });

  test("logs the classified setup failure so the fault has an operator copy", async () => {
    const append = vi.fn(async () => undefined);
    const recordProviderFailure = vi.fn(async () => ({ ended: true as const }));
    const log = vi.fn();

    await recordTelephoneSetupProviderFailure({
      recognition: defaultRecognizedSpeechModel,
      append,
      error: new TelephoneSetupProviderError(
        "setup",
        Object.assign(new Error("room join refused"), { status: 503 }),
      ),
      failureEventId: "logged-session-start-failure",
      log,
      occurredAt: "2026-08-17T20:00:00.000Z",
      recordProviderFailure,
      telephoneSessionId: "telephone-session-logged-start",
    });

    expect(log).toHaveBeenCalledWith({
      error: { message: "room join refused", name: "Error", status: 503 },
      provider: "livekit",
      recovery: "terminal",
      stage: "setup",
      telephoneSessionId: "telephone-session-logged-start",
    });
  });

  test("logs nothing for an error it does not attribute to a provider", async () => {
    const log = vi.fn();

    await recordTelephoneSetupProviderFailure({
      recognition: defaultRecognizedSpeechModel,
      append: vi.fn(async () => undefined),
      error: new Error("durable application write failed"),
      failureEventId: "unlogged-catch-path-failure",
      log,
      occurredAt: "2026-08-17T20:00:00.000Z",
      recordProviderFailure: vi.fn(async () => ({ ended: true as const })),
      telephoneSessionId: "telephone-session-unlogged",
    });

    expect(log).not.toHaveBeenCalled();
  });

  test("records a classified session-start failure as sanitized setup failure", async () => {
    const append = vi.fn(async () => undefined);
    const recordProviderFailure = vi.fn(async () => ({ ended: true as const }));

    await recordTelephoneSetupProviderFailure({
      recognition: defaultRecognizedSpeechModel,
      append,
      error: new TelephoneSetupProviderError(
        "setup",
        new Error("raw LiveKit room details"),
      ),
      failureEventId: "fixed-session-start-failure",
      occurredAt: "2026-08-17T20:00:00.000Z",
      recordProviderFailure,
      telephoneSessionId: "telephone-session-fixed-start",
    });

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          failure: "unavailable",
          provider: "livekit",
          stage: "setup",
        },
        kind: "telephone.provider.failure",
      }),
    );
    expect(recordProviderFailure).toHaveBeenCalledWith({
      failureClass: "unavailable",
      sessionId: "telephone-session-fixed-start",
      stage: "setup",
    });
  });

  test("retains a known bounded speech-provider classification", async () => {
    const append = vi.fn(async () => undefined);
    const recordProviderFailure = vi.fn(async () => ({ ended: true as const }));

    await recordTelephoneSetupProviderFailure({
      recognition: defaultRecognizedSpeechModel,
      append,
      error: new TelephoneSetupProviderError(
        "tts",
        new APITimeoutError({ message: "provider body" }),
      ),
      failureEventId: "fixed-tts-failure",
      occurredAt: "2026-08-17T20:00:01.000Z",
      recordProviderFailure,
      telephoneSessionId: "telephone-session-fixed-tts",
    });

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          failure: "timeout",
          provider: "inworld",
          stage: "tts",
          timeoutMs: 10_000,
        },
        kind: "telephone.provider.failure",
      }),
    );
    expect(recordProviderFailure).toHaveBeenCalledWith({
      failureClass: "timeout",
      sessionId: "telephone-session-fixed-tts",
      stage: "tts",
    });
  });
});
