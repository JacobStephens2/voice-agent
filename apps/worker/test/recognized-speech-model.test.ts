import {
  defaultRecognizedSpeechModelName,
  recognizedSpeechModelNames,
  recognizedSpeechModels,
  speechRecognitionKeyterms,
} from "@voice-agent/contracts";
import { describe, expect, test } from "vitest";

import { resolveTelephoneWorkerSettings } from "../src/telephone-worker-settings.ts";
import { wellFormedTelephoneWorkerEnvironment as wellFormedEnvironment } from "./telephone-worker-environment.ts";

describe("the Recognized Speech Model set", () => {
  test("carries the model in production today, the contextual model, and the researched fallback", () => {
    expect(recognizedSpeechModelNames).toStrictEqual([
      "assemblyai/universal-streaming-multilingual",
      "assemblyai/universal-3-5-pro",
      "deepgram/flux-general-en",
    ]);
    expect(defaultRecognizedSpeechModelName).toBe(
      "assemblyai/universal-streaming-multilingual",
    );
  });

  test("each entry names the provider recorded against its stage", () => {
    expect(
      recognizedSpeechModels["assemblyai/universal-streaming-multilingual"],
    ).toMatchObject({
      model: "assemblyai/universal-streaming-multilingual",
      provider: "assemblyai",
    });
    expect(
      recognizedSpeechModels["assemblyai/universal-3-5-pro"],
    ).toMatchObject({
      model: "assemblyai/universal-3-5-pro",
      provider: "assemblyai",
    });
    expect(recognizedSpeechModels["deepgram/flux-general-en"]).toMatchObject({
      model: "deepgram/flux-general-en",
      provider: "deepgram",
    });
  });

  test("the contextual entry spells its own options and bounds the reply it accepts", () => {
    const contextual = recognizedSpeechModels["assemblyai/universal-3-5-pro"];

    expect(contextual.modelOptions).toStrictEqual({
      keyterms_prompt: [...speechRecognitionKeyterms],
      // The provider's own voice-agent preset, which the research note starts at.
      mode: "balanced",
    });
    expect(contextual.agentContext).toStrictEqual({ maximumCharacters: 1_500 });
    // Provider Voice Focus is deliberately absent while BVCTelephony is the
    // enabled noise layer.
    expect(contextual.modelOptions).not.toHaveProperty("voice_focus");
  });

  test("no other entry claims to accept the agent's last reply", () => {
    expect(
      recognizedSpeechModels["assemblyai/universal-streaming-multilingual"]
        .agentContext,
    ).toBeUndefined();
    expect(
      recognizedSpeechModels["deepgram/flux-general-en"].agentContext,
    ).toBeUndefined();
  });

  test("each entry spells the same domain keyterms in its own provider's option", () => {
    const assemblyai =
      recognizedSpeechModels["assemblyai/universal-streaming-multilingual"];
    const deepgram = recognizedSpeechModels["deepgram/flux-general-en"];

    expect(assemblyai.modelOptions).toStrictEqual({
      keyterms_prompt: [...speechRecognitionKeyterms],
    });
    expect(deepgram.modelOptions).toStrictEqual({
      keyterm: [...speechRecognitionKeyterms],
    });
    // The Deepgram entry must never receive the AssemblyAI-shaped option, which
    // its own gateway would ignore without reporting anything.
    expect(deepgram.modelOptions).not.toHaveProperty("keyterms_prompt");
    expect(assemblyai.modelOptions).not.toHaveProperty("keyterm");
  });
});

describe("resolving the recognition model setting", () => {
  test("an absent setting selects the model in production today", () => {
    expect(
      resolveTelephoneWorkerSettings(wellFormedEnvironment).recognitionModel,
    ).toStrictEqual(
      recognizedSpeechModels["assemblyai/universal-streaming-multilingual"],
    );
  });

  test("a recognized setting selects that entry", () => {
    expect(
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_STT_MODEL: "deepgram/flux-general-en",
      }).recognitionModel,
    ).toStrictEqual(recognizedSpeechModels["deepgram/flux-general-en"]);
  });

  test("the contextual entry is selectable by the same setting", () => {
    expect(
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_STT_MODEL: "assemblyai/universal-3-5-pro",
      }).recognitionModel,
    ).toStrictEqual(recognizedSpeechModels["assemblyai/universal-3-5-pro"]);
  });

  test("a model outside the set names the setting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        // The same generation under the name the agents framework's model
        // union carries, which is not a LiveKit Inference model ID.
        VOICE_AGENT_STT_MODEL: "assemblyai/u3-rt-pro",
      }),
    ).toThrow(/VOICE_AGENT_STT_MODEL/u);
  });

  test("a malformed setting names the setting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_STT_MODEL: "assemblyai",
      }),
    ).toThrow(/VOICE_AGENT_STT_MODEL/u);
  });

  test("an empty setting names the setting rather than silently defaulting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_STT_MODEL: "",
      }),
    ).toThrow(/VOICE_AGENT_STT_MODEL/u);
  });

  test("the refusal lists the models an operator may choose", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_STT_MODEL: "deepgram/nova-3",
      }),
    ).toThrow(/deepgram\/flux-general-en/u);
  });
});
