/**
 * The Recognized Speech Model set.
 *
 * A speech model this system will accept a setting for, bound to the provider
 * identity recorded against its stage in evidence and to the options that
 * provider's own gateway accepts. The setting is a choice from this set rather
 * than a free string: a validated `provider/model` shape cannot tell a real
 * model from a mistyped one, and would deliver its refusal as a provider error
 * in the middle of a call. ADR-0057 records the reasoning.
 *
 * Entry data and the choice live here; constructing the agents framework's STT
 * options from an entry stays in the worker, so this package never depends on
 * `@livekit/agents`.
 */

/**
 * The domain terms a transcriber is biased toward, defined once. Each entry
 * spells them in its own provider's option, because a gateway silently ignores
 * an option shaped for a different one.
 */
export const speechRecognitionKeyterms = [
  "Bountywell",
  "Keeplore",
  "Get Rid Of",
] as const;

export const recognizedSpeechModelNames = [
  "assemblyai/universal-streaming-multilingual",
  "deepgram/flux-general-en",
] as const;
export type RecognizedSpeechModelName =
  (typeof recognizedSpeechModelNames)[number];

export type RecognizedSpeechModel =
  | {
      readonly model: "assemblyai/universal-streaming-multilingual";
      readonly modelOptions: { readonly keyterms_prompt: string[] };
      readonly provider: "assemblyai";
    }
  | {
      readonly model: "deepgram/flux-general-en";
      readonly modelOptions: { readonly keyterm: string[] };
      readonly provider: "deepgram";
    };

/**
 * The model in production today. An absent setting selects it, so introducing
 * the setting changes nothing on its own.
 */
export const defaultRecognizedSpeechModelName =
  "assemblyai/universal-streaming-multilingual" satisfies RecognizedSpeechModelName;

export const recognizedSpeechModels: {
  readonly [TName in RecognizedSpeechModelName]: Extract<
    RecognizedSpeechModel,
    { model: TName }
  >;
} = {
  "assemblyai/universal-streaming-multilingual": {
    model: "assemblyai/universal-streaming-multilingual",
    modelOptions: { keyterms_prompt: [...speechRecognitionKeyterms] },
    provider: "assemblyai",
  },
  // The fallback designated in research/2026-08-11-livekit-pipeline-providers.md.
  // Reachable through LiveKit Inference, so moving to it needs no new
  // credential or billing path.
  "deepgram/flux-general-en": {
    model: "deepgram/flux-general-en",
    modelOptions: { keyterm: [...speechRecognitionKeyterms] },
    provider: "deepgram",
  },
};

export const defaultRecognizedSpeechModel: RecognizedSpeechModel =
  recognizedSpeechModels[defaultRecognizedSpeechModelName];

/**
 * The entry a setting names, or `undefined` when it names nothing in the set.
 * The caller reports the refusal, because only it knows which setting was read.
 */
export function recognizedSpeechModel(
  name: string,
): RecognizedSpeechModel | undefined {
  return (recognizedSpeechModelNames as readonly string[]).includes(name)
    ? recognizedSpeechModels[name as RecognizedSpeechModelName]
    : undefined;
}
