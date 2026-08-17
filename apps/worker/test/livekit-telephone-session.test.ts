import { APITimeoutError } from "@livekit/agents";
import { describe, expect, test } from "vitest";

import {
  mapFinalizedTranscriptionEvent,
  mapProviderFailureEvent,
} from "../src/livekit-telephone-session.ts";

describe("LiveKit finalized telephone turns", () => {
  test("rejects a finalized turn without a speech boundary", () => {
    expect(() =>
      mapFinalizedTranscriptionEvent({
        createdAt: 1_776_444_000_500,
        itemId: null,
        speechStartedAt: undefined,
        telephoneSessionId: "telephone-session-001",
        transcript: "Is Bountywell healthy?",
      }),
    ).toThrow("Finalized telephone turn boundary is unavailable");
  });

  test("keeps provider deliveries distinct while preserving one logical speech turn", () => {
    const first = mapFinalizedTranscriptionEvent({
      createdAt: 1_776_444_000_500,
      itemId: "provider-item-001",
      speechStartedAt: 1_776_444_000_000,
      telephoneSessionId: "telephone-session-001",
      transcript: "Is Bountywell healthy?",
    });
    const redelivered = mapFinalizedTranscriptionEvent({
      createdAt: 1_776_444_000_717,
      itemId: "provider-item-002",
      speechStartedAt: 1_776_444_000_000,
      telephoneSessionId: "telephone-session-001",
      transcript: "Is Bountywell healthy?",
    });

    expect(redelivered.deliveryId).not.toBe(first.deliveryId);
    expect(redelivered.turnId).toBe(first.turnId);
  });

  test("assigns a new logical identity to a later speech turn", () => {
    const first = mapFinalizedTranscriptionEvent({
      createdAt: 1_776_444_000_500,
      itemId: null,
      speechStartedAt: 1_776_444_000_000,
      telephoneSessionId: "telephone-session-001",
      transcript: "Is Bountywell healthy?",
    });
    const repeatedLater = mapFinalizedTranscriptionEvent({
      createdAt: 1_776_444_010_500,
      itemId: null,
      speechStartedAt: 1_776_444_010_000,
      telephoneSessionId: "telephone-session-001",
      transcript: "Is Bountywell healthy?",
    });

    expect(repeatedLater.deliveryId).not.toBe(first.deliveryId);
    expect(repeatedLater.turnId).not.toBe(first.turnId);
  });
});

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
