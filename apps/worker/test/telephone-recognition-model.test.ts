import { initializeLogger } from "@livekit/agents";
import {
  defaultRecognizedSpeechModel,
  recognizedSpeechModels,
} from "@voice-agent/contracts";
import { describe, expect, test } from "vitest";

import {
  createConversationRecognitionSTT,
  createDetectionRecognitionSTT,
  mapCompletedTelephoneTurnEvent,
  mapProviderFailureEvent,
} from "../src/livekit-telephone-session.ts";

initializeLogger({ level: "silent", pretty: false });
process.env.LIVEKIT_API_KEY ??= "recognition-model-key";
process.env.LIVEKIT_API_SECRET ??= "recognition-model-secret-recognition";
process.env.LIVEKIT_URL ??= "ws://127.0.0.1:1";

const contextual = recognizedSpeechModels["assemblyai/universal-3-5-pro"];
const deepgram = recognizedSpeechModels["deepgram/flux-general-en"];

/** The options the framework was actually constructed with. */
function modelOptionsOf(stt: unknown): Record<string, unknown> {
  const options = (stt as { readonly opts: { readonly modelOptions: unknown } })
    .opts.modelOptions;
  return options as Record<string, unknown>;
}

describe("the transcriber a Recognized Speech Model builds", () => {
  test("the default entry recognizes speech with the model in production today", () => {
    const stt = createConversationRecognitionSTT(defaultRecognizedSpeechModel);

    expect(stt.model).toBe("assemblyai/universal-streaming-multilingual");
    expect(modelOptionsOf(stt)).toMatchObject({
      keyterms_prompt: ["Bountywell", "Keeplore", "Get Rid Of"],
    });
  });

  test("the Deepgram entry receives its own option spelling and no AssemblyAI-shaped option", () => {
    const stt = createConversationRecognitionSTT(deepgram);

    expect(stt.model).toBe("deepgram/flux-general-en");
    expect(modelOptionsOf(stt)).toMatchObject({
      keyterm: ["Bountywell", "Keeplore", "Get Rid Of"],
    });
    expect(modelOptionsOf(stt)).not.toHaveProperty("keyterms_prompt");
  });

  test("the contextual entry recognizes speech with its own mode and keyterms", () => {
    const stt = createConversationRecognitionSTT(contextual);

    expect(stt.model).toBe("assemblyai/universal-3-5-pro");
    expect(modelOptionsOf(stt)).toMatchObject({
      keyterms_prompt: ["Bountywell", "Keeplore", "Get Rid Of"],
      mode: "balanced",
    });
    // The reply that biases a turn is per-turn, so it is absent until one has
    // been spoken rather than fixed when the transcriber is built.
    expect(modelOptionsOf(stt)).not.toHaveProperty("agent_context");
  });

  test("the machine detector's transcriber takes the model without the keyterms", () => {
    const stt = createDetectionRecognitionSTT(deepgram);

    // A voicemail greeting carries none of the domain terms, so detection is
    // left unbiased as it has always been; only the model is configured.
    expect(stt.model).toBe("deepgram/flux-general-en");
    expect(modelOptionsOf(stt)).not.toHaveProperty("keyterm");
    expect(modelOptionsOf(stt)).not.toHaveProperty("keyterms_prompt");
  });
});

describe("the provider a recognition-stage fault is recorded against", () => {
  test("follows the configured entry rather than the stage", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "delivery-recognition",
        error: new Error("gateway is unavailable"),
        occurredAt: "2026-08-25T12:00:00.000Z",
        recognition: deepgram,
        stage: "stt",
      }).provider,
    ).toBe("deepgram");
  });

  test("is assemblyai for the entry an absent setting selects", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "delivery-recognition-default",
        error: new Error("gateway is unavailable"),
        occurredAt: "2026-08-25T12:00:00.000Z",
        recognition: defaultRecognizedSpeechModel,
        stage: "stt",
      }).provider,
    ).toBe("assemblyai");
  });

  test("is assemblyai for the contextual entry", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "delivery-recognition-contextual",
        error: new Error("gateway is unavailable"),
        occurredAt: "2026-08-25T12:00:00.000Z",
        recognition: contextual,
        stage: "stt",
      }).provider,
    ).toBe("assemblyai");
  });

  test("a finalized turn on the contextual entry names its provider", () => {
    expect(
      mapCompletedTelephoneTurnEvent({
        createdAt: 1_787_000_002_000,
        itemId: "item-recognition-contextual",
        recognition: contextual,
        speechStartedAt: 1_787_000_001_000,
        telephoneSessionId: "telephone-session-recognition-contextual",
        transcript: "Yes, I confirm.",
      }).stt.provider,
    ).toBe("assemblyai");
  });

  test("leaves every other stage's provider alone", () => {
    for (const [stage, provider] of [
      ["agent", "voice-agent"],
      ["coordinator", "openai"],
      ["setup", "livekit"],
      ["tts", "inworld"],
    ] as const) {
      expect(
        mapProviderFailureEvent({
          deliveryId: `delivery-${stage}`,
          error: new Error("gateway is unavailable"),
          occurredAt: "2026-08-25T12:00:00.000Z",
          recognition: deepgram,
          stage,
        }).provider,
      ).toBe(provider);
    }
  });

  test("a finalized turn names the configured entry's provider", () => {
    expect(
      mapCompletedTelephoneTurnEvent({
        createdAt: 1_787_000_002_000,
        itemId: "item-recognition",
        recognition: deepgram,
        speechStartedAt: 1_787_000_001_000,
        telephoneSessionId: "telephone-session-recognition",
        transcript: "Yes, I confirm.",
      }).stt.provider,
    ).toBe("deepgram");
  });
});
