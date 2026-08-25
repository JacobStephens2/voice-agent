import {
  defaultRecognizedSpeechModelName,
  recognizedSpeechModel,
  recognizedSpeechModelNames,
  type RecognizedSpeechModel,
} from "@voice-agent/contracts";

/**
 * Every setting the telephone worker cannot accept is refused here, when the
 * process starts, rather than inside the job that first reads it. A worker that
 * only reads its settings per job starts cleanly, passes a Promotion Attempt's
 * post-Promotion health verification, and then fails callers one at a time; the
 * automatic rollback that exists for exactly that misconfiguration never fires.
 * Ending the process instead puts a bad setting in front of that machinery, so
 * it becomes a rejected Release rather than a live outage. ADR-0057 records the
 * reasoning.
 */
export interface TelephoneWorkerSettings {
  readonly brokerSocketPath: string;
  readonly databasePath: string;
  readonly keeplore: KeeploreDelegationSettings | undefined;
  readonly liveKitApiKey: string;
  readonly liveKitApiSecret: string;
  readonly liveKitUrl: string;
  readonly prolongedSilenceMs: number;
  readonly rawAudioDebugDirectory: string;
  /** The Recognized Speech Model both transcribers recognize speech with. */
  readonly recognitionModel: RecognizedSpeechModel;
}

export interface KeeploreDelegationSettings {
  readonly sourceCommit: string;
  readonly subagentSocketPath: string;
}

const minimumProlongedSilenceSeconds = 30;
const maximumProlongedSilenceSeconds = 900;

export function resolveTelephoneWorkerSettings(
  environment: NodeJS.ProcessEnv = process.env,
): TelephoneWorkerSettings {
  const sourceCommit = environment.KEEPLORE_SOURCE_COMMIT;
  return {
    brokerSocketPath: requireSetting(environment, "VOICE_AGENT_BROKER_SOCKET_PATH"),
    databasePath: requireSetting(environment, "VOICE_AGENT_DATABASE_PATH"),
    // A configured source commit is what makes the Subagent socket required; a
    // Keeplore registration is durable state read later, not a setting.
    keeplore:
      sourceCommit === undefined
        ? undefined
        : {
            sourceCommit,
            subagentSocketPath: requireSetting(
              environment,
              "VOICE_AGENT_SUBAGENT_SOCKET_PATH",
            ),
          },
    liveKitApiKey: requireSetting(environment, "LIVEKIT_API_KEY"),
    liveKitApiSecret: requireSetting(environment, "LIVEKIT_API_SECRET"),
    liveKitUrl: requireSetting(environment, "LIVEKIT_URL"),
    prolongedSilenceMs: resolveProlongedSilenceMs(environment),
    rawAudioDebugDirectory:
      environment.VOICE_AGENT_RAW_AUDIO_DEBUG_DIRECTORY ??
      "/var/lib/voice-agent/raw-audio-debug",
    recognitionModel: resolveRecognitionModel(environment),
  };
}

/**
 * A setting naming anything outside the Recognized Speech Model set is refused
 * here, so a mistyped model ends this process and fails a Promotion Attempt's
 * health verification rather than arriving as a provider error mid-call.
 */
function resolveRecognitionModel(
  environment: NodeJS.ProcessEnv,
): RecognizedSpeechModel {
  const configured =
    environment.VOICE_AGENT_STT_MODEL ?? defaultRecognizedSpeechModelName;
  const entry = recognizedSpeechModel(configured);
  if (entry === undefined) {
    throw new Error(
      `VOICE_AGENT_STT_MODEL must name a Recognized Speech Model: ${recognizedSpeechModelNames.join(", ")}`,
    );
  }
  return entry;
}

function resolveProlongedSilenceMs(environment: NodeJS.ProcessEnv): number {
  const configured = Number(
    environment.VOICE_AGENT_PROLONGED_SILENCE_SECONDS ?? "60",
  );
  if (
    !Number.isInteger(configured) ||
    configured < minimumProlongedSilenceSeconds ||
    configured > maximumProlongedSilenceSeconds
  ) {
    throw new Error(
      `VOICE_AGENT_PROLONGED_SILENCE_SECONDS must be between ${minimumProlongedSilenceSeconds} and ${maximumProlongedSilenceSeconds}`,
    );
  }
  return configured * 1_000;
}

function requireSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
