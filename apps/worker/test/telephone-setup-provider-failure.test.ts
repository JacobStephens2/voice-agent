import { APITimeoutError } from "@livekit/agents";
import { describe, expect, test, vi } from "vitest";

import {
  recordTelephoneSetupProviderFailure,
  TelephoneSetupProviderError,
} from "../src/telephone-setup-provider-failure.ts";

describe("fixed-speech Telephone Session setup failures", () => {
  test("classifies an unwrapped session-start error as sanitized setup failure", async () => {
    const append = vi.fn(async () => undefined);
    const recordProviderFailure = vi.fn(async () => ({ ended: true as const }));

    await recordTelephoneSetupProviderFailure({
      append,
      error: new Error("raw LiveKit room details"),
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
