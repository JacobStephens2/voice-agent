import {
  defaultRecognizedSynthesisModelName,
  recognizedSynthesisModelNames,
  recognizedSynthesisModels,
} from "@voice-agent/contracts";
import { describe, expect, test } from "vitest";

import { resolveTelephoneWorkerSettings } from "../src/telephone-worker-settings.ts";
import { wellFormedTelephoneWorkerEnvironment as wellFormedEnvironment } from "./telephone-worker-environment.ts";

describe("the Recognized Synthesis Model set", () => {
  test("carries the model in production today and the researched fallback", () => {
    expect(recognizedSynthesisModelNames).toStrictEqual([
      "inworld/inworld-tts-2",
      "cartesia/sonic-3.5",
    ]);
    expect(defaultRecognizedSynthesisModelName).toBe("inworld/inworld-tts-2");
  });

  test("each entry names the provider recorded against its stage", () => {
    expect(recognizedSynthesisModels["inworld/inworld-tts-2"]).toStrictEqual({
      defaultVoice: "Sarah",
      model: "inworld/inworld-tts-2",
      provider: "inworld",
    });
    expect(
      recognizedSynthesisModels["cartesia/sonic-3.5"],
    ).toStrictEqual({
      // A Cartesia voice is an identifier this system carries no researched
      // choice for, so selecting that entry requires naming one.
      defaultVoice: undefined,
      model: "cartesia/sonic-3.5",
      provider: "cartesia",
    });
  });
});

describe("resolving the synthesis model setting", () => {
  test("an absent setting selects the model and voice in production today", () => {
    expect(
      resolveTelephoneWorkerSettings(wellFormedEnvironment).synthesisModel,
    ).toStrictEqual({
      model: "inworld/inworld-tts-2",
      provider: "inworld",
      voice: "Sarah",
    });
  });

  test("the configured voice overrides the entry's own default", () => {
    expect(
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_TTS_VOICE: "Ashley",
      }).synthesisModel,
    ).toStrictEqual({
      model: "inworld/inworld-tts-2",
      provider: "inworld",
      voice: "Ashley",
    });
  });

  test("a recognized setting selects that entry with the voice named for it", () => {
    expect(
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_TTS_MODEL: "cartesia/sonic-3.5",
        VOICE_AGENT_TTS_VOICE: "6f84f4b8-58a2-430c-8c79-688dad597532",
      }).synthesisModel,
    ).toStrictEqual({
      model: "cartesia/sonic-3.5",
      provider: "cartesia",
      voice: "6f84f4b8-58a2-430c-8c79-688dad597532",
    });
  });

  test("an entry carrying no default voice refuses a setting that names none", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_TTS_MODEL: "cartesia/sonic-3.5",
      }),
    ).toThrow(/VOICE_AGENT_TTS_VOICE/u);
  });

  test("a model outside the set names the setting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        // The dated pin the research note names this generation by, which is
        // not a LiveKit Inference model ID.
        VOICE_AGENT_TTS_MODEL: "cartesia/sonic-3.5-2026-05-04",
      }),
    ).toThrow(/VOICE_AGENT_TTS_MODEL/u);
  });

  test("an empty model setting names the setting rather than silently defaulting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_TTS_MODEL: "",
      }),
    ).toThrow(/VOICE_AGENT_TTS_MODEL/u);
  });

  test("an empty voice setting names the setting rather than silently defaulting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_TTS_VOICE: "",
      }),
    ).toThrow(/VOICE_AGENT_TTS_VOICE/u);
  });

  test("the refusal lists the models an operator may choose", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_TTS_MODEL: "inworld/inworld-tts-3",
      }),
    ).toThrow(/cartesia\/sonic-3\.5/u);
  });
});
