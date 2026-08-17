import { APITimeoutError } from "@livekit/agents";
import { describe, expect, test } from "vitest";

import { mapProviderFailureEvent } from "../src/livekit-telephone-session.ts";

describe("LiveKit telephone provider failures", () => {
  test("maps an STT timeout to the bounded provider-timeout contract", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "stt-timeout",
        error: new APITimeoutError({ message: "transcription timed out" }),
        occurredAt: "2026-08-17T19:00:00.000Z",
        stage: "stt",
      }),
    ).toEqual({
      deliveryId: "stt-timeout",
      kind: "provider-timeout",
      occurredAt: "2026-08-17T19:00:00.000Z",
      provider: "assemblyai",
      stage: "stt",
      timeoutMs: 5_000,
    });
  });

  test("maps sanitized coordinator and task-scoped TTS failures without raw errors", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "coordinator-failure",
        error: new Error("secret provider body"),
        occurredAt: "2026-08-17T19:00:01.000Z",
        stage: "coordinator",
      }),
    ).toEqual({
      deliveryId: "coordinator-failure",
      failure: "unavailable",
      kind: "provider-failure",
      occurredAt: "2026-08-17T19:00:01.000Z",
      provider: "openai",
      stage: "coordinator",
    });
    expect(
      mapProviderFailureEvent({
        deliveryId: "tts-timeout",
        error: new APITimeoutError({ message: "secret provider body" }),
        occurredAt: "2026-08-17T19:00:02.000Z",
        stage: "tts",
        taskId: "task-001",
      }),
    ).toMatchObject({
      kind: "provider-timeout",
      stage: "tts",
      taskId: "task-001",
      timeoutMs: 10_000,
    });
  });
});
