import { initializeLogger } from "@livekit/agents";
import {
  defaultConfiguredSpeechSynthesis,
  defaultRecognizedSpeechModel,
  type ConfiguredSpeechSynthesis,
} from "@voice-agent/contracts";
import { describe, expect, test } from "vitest";

import {
  createSpeechSynthesisTTS,
  mapProviderFailureEvent,
} from "../src/livekit-telephone-session.ts";

initializeLogger({ level: "silent", pretty: false });
process.env.LIVEKIT_API_KEY ??= "synthesis-model-key";
process.env.LIVEKIT_API_SECRET ??= "synthesis-model-secret-synthesis";
process.env.LIVEKIT_URL ??= "ws://127.0.0.1:1";

const cartesia: ConfiguredSpeechSynthesis = {
  model: "cartesia/sonic-3.5",
  provider: "cartesia",
  voice: "6f84f4b8-58a2-430c-8c79-688dad597532",
};

/** The voice the framework was actually constructed with. */
function voiceOf(tts: unknown): string | undefined {
  return (tts as { readonly opts: { readonly voice?: string } }).opts.voice;
}

describe("the synthesizer a Recognized Synthesis Model builds", () => {
  test("the default entry speaks with the model and voice in production today", () => {
    const tts = createSpeechSynthesisTTS(defaultConfiguredSpeechSynthesis);

    expect(tts.model).toBe("inworld/inworld-tts-2");
    expect(voiceOf(tts)).toBe("Sarah");
  });

  test("a selected entry speaks with its own model and the voice named for it", () => {
    const tts = createSpeechSynthesisTTS(cartesia);

    expect(tts.model).toBe("cartesia/sonic-3.5");
    expect(voiceOf(tts)).toBe("6f84f4b8-58a2-430c-8c79-688dad597532");
  });
});

describe("the provider a synthesis-stage fault is recorded against", () => {
  test("follows the configured entry rather than the stage", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "delivery-synthesis",
        error: new Error("gateway is unavailable"),
        occurredAt: "2026-08-30T12:00:00.000Z",
        recognition: defaultRecognizedSpeechModel,
        stage: "tts",
        synthesis: cartesia,
      }).provider,
    ).toBe("cartesia");
  });

  test("is inworld for the entry an absent setting selects", () => {
    expect(
      mapProviderFailureEvent({
        deliveryId: "delivery-synthesis-default",
        error: new Error("gateway is unavailable"),
        occurredAt: "2026-08-30T12:00:00.000Z",
        recognition: defaultRecognizedSpeechModel,
        stage: "tts",
        synthesis: defaultConfiguredSpeechSynthesis,
      }).provider,
    ).toBe("inworld");
  });

  test("leaves every other stage's provider alone", () => {
    for (const [stage, provider] of [
      ["agent", "voice-agent"],
      ["coordinator", "openai"],
      ["setup", "livekit"],
      ["stt", "assemblyai"],
    ] as const) {
      expect(
        mapProviderFailureEvent({
          deliveryId: `delivery-${stage}`,
          error: new Error("gateway is unavailable"),
          occurredAt: "2026-08-30T12:00:00.000Z",
          recognition: defaultRecognizedSpeechModel,
          stage,
          synthesis: cartesia,
        }).provider,
      ).toBe(provider);
    }
  });
});
