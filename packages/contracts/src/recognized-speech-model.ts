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
  "assemblyai/universal-3-5-pro",
  "deepgram/flux-general-en",
] as const;
export type RecognizedSpeechModelName =
  (typeof recognizedSpeechModelNames)[number];

/**
 * What one entry's gateway does with the Voice Agent's most recent spoken
 * reply, for the entries whose gateway takes it at all.
 *
 * The reply is a per-turn value rather than a fixed option: it changes as the
 * conversation proceeds and is pushed to the live transcriber before the
 * caller answers. An entry without this accepts no such option, and is never
 * sent one — a gateway silently ignores an option it does not know, so sending
 * it anyway would look like the bias was applied. ADR-0060 records the
 * reasoning, including why the option's own spelling stays in the worker.
 */
export interface AgentContextBias {
  /**
   * The longest reply the gateway accepts. LiveKit's model documentation
   * states 1750 characters and the agents framework's own option documentation
   * states 1500; the lower of the two is what both accept, so a longer reply
   * is truncated to it rather than sent whole.
   */
  readonly maximumCharacters: number;
}

export type RecognizedSpeechModel =
  | {
      readonly agentContext: undefined;
      readonly model: "assemblyai/universal-streaming-multilingual";
      readonly modelOptions: { readonly keyterms_prompt: string[] };
      readonly provider: "assemblyai";
    }
  | {
      readonly agentContext: AgentContextBias;
      readonly model: "assemblyai/universal-3-5-pro";
      readonly modelOptions: {
        readonly keyterms_prompt: string[];
        readonly mode: "balanced";
      };
      readonly provider: "assemblyai";
    }
  | {
      readonly agentContext: undefined;
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
    agentContext: undefined,
    model: "assemblyai/universal-streaming-multilingual",
    modelOptions: { keyterms_prompt: [...speechRecognitionKeyterms] },
    provider: "assemblyai",
  },
  // The contextual generation designated in
  // research/2026-08-11-livekit-pipeline-providers.md. `assemblyai/u3-rt-pro`
  // names the same generation in the agents framework's model union, but only
  // this string is a LiveKit Inference model ID whose gateway is documented to
  // accept the contextual options; the research note records the resolution.
  // `mode` is the provider's own voice-agent preset. Voice Focus is
  // deliberately absent: `BVCTelephony` is the enabled noise layer, and the
  // research note refuses to stack the two before measurement.
  "assemblyai/universal-3-5-pro": {
    agentContext: { maximumCharacters: 1_500 },
    model: "assemblyai/universal-3-5-pro",
    modelOptions: {
      keyterms_prompt: [...speechRecognitionKeyterms],
      mode: "balanced",
    },
    provider: "assemblyai",
  },
  // The fallback designated in research/2026-08-11-livekit-pipeline-providers.md.
  // Reachable through LiveKit Inference, so moving to it needs no new
  // credential or billing path.
  "deepgram/flux-general-en": {
    agentContext: undefined,
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
