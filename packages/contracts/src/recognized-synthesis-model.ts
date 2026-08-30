/**
 * The Recognized Synthesis Model set.
 *
 * A speech model this system will accept a setting for synthesising with,
 * bound to the provider identity recorded against the synthesis stage in
 * evidence and to the voice that provider names its speakers by. The setting
 * is a choice from this set rather than a free string for the reason ADR-0057
 * records for the recognition side: a validated `provider/model` shape cannot
 * tell a real model from a mistyped one, and would deliver its refusal as a
 * provider error in the middle of a call.
 *
 * Entry data and the choice live here; constructing the agents framework's TTS
 * options from an entry stays in the worker, so this package never depends on
 * `@livekit/agents`.
 */

export const recognizedSynthesisModelNames = [
  "inworld/inworld-tts-2",
  "cartesia/sonic-3.5",
] as const;
export type RecognizedSynthesisModelName =
  (typeof recognizedSynthesisModelNames)[number];

/**
 * One entry, with the voice it speaks in when the voice setting names none.
 *
 * A voice belongs to its own provider, so an entry carries a default only
 * where this system has a researched choice for one. An entry without a
 * default is selectable, but only alongside a voice named for it.
 */
export type RecognizedSynthesisModel =
  | {
      readonly defaultVoice: "Sarah";
      readonly model: "inworld/inworld-tts-2";
      readonly provider: "inworld";
    }
  | {
      readonly defaultVoice: undefined;
      readonly model: "cartesia/sonic-3.5";
      readonly provider: "cartesia";
    };

/**
 * The model in production today. An absent setting selects it, so introducing
 * the setting changes nothing on its own.
 */
export const defaultRecognizedSynthesisModelName =
  "inworld/inworld-tts-2" satisfies RecognizedSynthesisModelName;

export const recognizedSynthesisModels: {
  readonly [TName in RecognizedSynthesisModelName]: Extract<
    RecognizedSynthesisModel,
    { model: TName }
  >;
} = {
  // The synthesis provider designated in
  // research/2026-08-11-livekit-pipeline-providers.md, with the stock voice
  // that note starts from.
  "inworld/inworld-tts-2": {
    defaultVoice: "Sarah",
    model: "inworld/inworld-tts-2",
    provider: "inworld",
  },
  // The fallback designated in the same note, which names this generation by
  // its dated pin `cartesia/sonic-3.5-2026-05-04`; only this string is a
  // LiveKit Inference model ID, and it is not the `sonic-latest` alias that
  // note refuses. Reachable through LiveKit Inference, so moving to it needs no
  // new credential or billing path. Cartesia names its speakers by identifier
  // and the note designates none, so the entry carries no default voice and
  // selecting it means naming one.
  "cartesia/sonic-3.5": {
    defaultVoice: undefined,
    model: "cartesia/sonic-3.5",
    provider: "cartesia",
  },
};

const defaultEntry = recognizedSynthesisModels[defaultRecognizedSynthesisModelName];

export const defaultRecognizedSynthesisModel: RecognizedSynthesisModel =
  defaultEntry;

/**
 * The entry a setting names, or `undefined` when it names nothing in the set.
 * The caller reports the refusal, because only it knows which setting was read.
 */
export function recognizedSynthesisModel(
  name: string,
): RecognizedSynthesisModel | undefined {
  return (recognizedSynthesisModelNames as readonly string[]).includes(name)
    ? recognizedSynthesisModels[name as RecognizedSynthesisModelName]
    : undefined;
}

/**
 * The entry in use together with the voice it speaks in: what the worker
 * synthesises through and what a synthesis-stage fault is recorded against.
 * The voice is always present here, because an entry that names no default is
 * refused at startup unless the voice setting supplies one.
 */
export interface ConfiguredSpeechSynthesis {
  readonly model: RecognizedSynthesisModelName;
  readonly provider: RecognizedSynthesisModel["provider"];
  readonly voice: string;
}

/**
 * Pair an entry with a configured voice, or report that neither the setting
 * nor the entry names one. The caller reports the refusal, because only it
 * knows which settings were read.
 */
export function configuredSpeechSynthesis(
  entry: RecognizedSynthesisModel,
  configuredVoice: string | undefined,
): ConfiguredSpeechSynthesis | undefined {
  const voice = configuredVoice ?? entry.defaultVoice;
  return voice === undefined
    ? undefined
    : { model: entry.model, provider: entry.provider, voice };
}

/**
 * The model and voice an absent pair of settings selects, read from the
 * default entry rather than written out a second time: a default voice spelled
 * here as well is the literal this set exists to remove.
 */
export const defaultConfiguredSpeechSynthesis: ConfiguredSpeechSynthesis = {
  model: defaultEntry.model,
  provider: defaultEntry.provider,
  voice: defaultEntry.defaultVoice,
};
