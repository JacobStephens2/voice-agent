import { APITimeoutError, llm } from "@livekit/agents";
import { describe, expect, test } from "vitest";

import {
  boundedProviderConnectOptions,
  LiveKitTelephoneTurnAdapter,
  mapCompletedTelephoneTurnEvent,
  mapProviderFailureEvent,
} from "../src/livekit-telephone-session.ts";

describe("LiveKit finalized telephone turns", () => {
  test("rejects a completed turn without a LiveKit turn identity", () => {
    expect(() =>
      mapCompletedTelephoneTurnEvent({
        createdAt: 1_776_444_000_500,
        itemId: null,
        speechStartedAt: undefined,
        telephoneSessionId: "telephone-session-001",
        transcript: "Is Bountywell healthy?",
      }),
    ).toThrow("Completed telephone turn identity is unavailable");
  });

  test("keeps interim and STT-final segments non-authoritative", () => {
    const adapter = new LiveKitTelephoneTurnAdapter(
      "telephone-session-001",
    );
    const interim = adapter.transcription({
      createdAt: 1_776_444_000_250,
      isFinal: false,
      itemId: "provider-item-001",
      transcript: "Is Bountywell",
    });
    const providerFinal = adapter.transcription({
      createdAt: 1_776_444_000_500,
      isFinal: true,
      itemId: "provider-item-002",
      transcript: "Is Bountywell healthy?",
    });

    expect(interim.kind).toBe("speech-hypothesis");
    expect(providerFinal.kind).toBe("speech-hypothesis");
  });

  test("assigns authoritative identity only to completed LiveKit turns", () => {
    const adapter = new LiveKitTelephoneTurnAdapter(
      "telephone-session-001",
    );
    adapter.speechStarted(1_776_444_000_000);
    const first = adapter.completedTurn(
      llm.ChatMessage.create({
        content: "Is Bountywell healthy?",
        createdAt: 1_776_444_000_500,
        id: "completed-item-001",
        role: "user",
      }),
    );
    adapter.speechStarted(1_776_444_010_000);
    const repeatedLater = adapter.completedTurn(
      llm.ChatMessage.create({
        content: "Is Bountywell healthy?",
        createdAt: 1_776_444_010_500,
        id: "completed-item-002",
        role: "user",
      }),
    );

    expect(first.kind).toBe("turn-finalized");
    expect(repeatedLater.kind).toBe("turn-finalized");
    if (first.kind !== "turn-finalized" || repeatedLater.kind !== "turn-finalized") {
      throw new Error("Expected two completed LiveKit turns");
    }
    expect(repeatedLater.deliveryId).not.toBe(first.deliveryId);
    expect(repeatedLater.turnId).not.toBe(first.turnId);
  });

  test("rejects a completed turn without a speech timing boundary", () => {
    const adapter = new LiveKitTelephoneTurnAdapter(
      "telephone-session-001",
    );

    expect(() =>
      adapter.completedTurn(
        llm.ChatMessage.create({
          content: "Is Bountywell healthy?",
          createdAt: 1_776_444_000_500,
          id: "completed-item-001",
          role: "user",
        }),
      ),
    ).toThrow("Completed telephone turn speech boundary is unavailable");
  });

  test("keeps a late completed LiveKit turn after the accepted answer non-authoritative", () => {
    const adapter = new LiveKitTelephoneTurnAdapter(
      "telephone-session-001",
    );
    adapter.speechStarted(1_787_026_448_269);
    const first = adapter.completedTurn(
      llm.ChatMessage.create({
        content: "Is Bounty Well Healthy.",
        createdAt: 1_787_026_450_226,
        id: "completed-item-001",
        role: "user",
      }),
    );
    const late = adapter.completedTurn(
      llm.ChatMessage.create({
        content: "Is Bounty Well Healthy.",
        createdAt: 1_787_026_450_386,
        id: "completed-item-001-late",
        role: "user",
      }),
    );

    expect(first).toMatchObject({
      kind: "turn-finalized",
      transcript: "Is Bounty Well Healthy.",
    });
    expect(late).toEqual({
      deliveryId: expect.any(String),
      kind: "speech-hypothesis",
      occurredAt: "2026-08-18T04:14:10.386Z",
      telephoneSessionId: "telephone-session-001",
      transcript: "Is Bounty Well Healthy.",
    });
  });
});

describe("LiveKit telephone provider failures", () => {
  test("uses one transient retry with a finite timeout for each selected provider", () => {
    expect(boundedProviderConnectOptions("stt")).toEqual({
      maxRetry: 1,
      retryIntervalMs: 250,
      timeoutMs: 5_000,
    });
    expect(boundedProviderConnectOptions("coordinator")).toEqual({
      maxRetry: 1,
      retryIntervalMs: 250,
      timeoutMs: 8_000,
    });
    expect(boundedProviderConnectOptions("tts")).toEqual({
      maxRetry: 1,
      retryIntervalMs: 250,
      timeoutMs: 10_000,
    });
  });

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

  test("does not invent a timeout duration for an unclassified setup failure", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "setup-failure",
        error: new APITimeoutError({ message: "unclassified setup timeout" }),
        occurredAt: "2026-08-17T19:00:03.000Z",
        stage: "setup",
      }),
    ).toEqual({
      deliveryId: "setup-failure",
      failure: "unavailable",
      kind: "provider-failure",
      occurredAt: "2026-08-17T19:00:03.000Z",
      provider: "livekit",
      stage: "setup",
    });
  });
});
