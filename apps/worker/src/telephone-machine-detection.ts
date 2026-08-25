import {
  isAPIError,
  UnexpectedModelBehavior,
  voice,
} from "@livekit/agents";

import { boundedProviderConnectOptions } from "./livekit-telephone-session.ts";
import { ProviderReportedError } from "./provider-error-description.ts";
import { ObservedSpeechProviderSTT } from "./speech-provider-error-frame.ts";
import { TelephoneSetupProviderError } from "./telephone-setup-provider-failure.ts";

/**
 * Machine detection with its recognition provider in view.
 *
 * The detector runs its own transcriber, and the framework runs that
 * transcriber in a private pump whose faults reach nobody: a gateway error is
 * emitted on the recognition provider and, with no listener for it, swallowed
 * where the pump is started. Detection then reaches its no-speech timeout and
 * returns `uncertain`, which this system fails as a machine — so a recognition
 * outage silently voicemails every callback and records no provider failure at
 * all. Owning the transcriber is what gives that fault somewhere to arrive.
 */
export interface BoundedMachineDetector {
  /** Close the detector and the transcriber it was given. */
  close(): Promise<void>;
  readonly detector: voice.AMD;
  /**
   * A fatal fault of the detector's recognition provider, raised at the
   * recognition stage. Rejects only; it never resolves.
   */
  readonly recognitionFailure: Promise<never>;
}

export function createBoundedMachineDetector(
  session: voice.AgentSession,
  participantIdentity: string,
): BoundedMachineDetector {
  const recognition = new ObservedSpeechProviderSTT({
    connOptions: boundedProviderConnectOptions("stt"),
    language: "en",
    model: "assemblyai/universal-streaming-multilingual",
  });
  let raiseRecognitionFailure: (error: unknown) => void = () => undefined;
  const recognitionFailure = new Promise<never>((_resolve, reject) => {
    raiseRecognitionFailure = reject;
  });
  // A detection that finishes first leaves this rejection unclaimed, and an
  // unclaimed rejection must not become the process's problem.
  recognitionFailure.catch(() => undefined);
  recognition.on("error", (event) => {
    if (event.recoverable) return;
    // The framework named the provider behind this, so its message is that
    // provider's own account of the caller's audio however it was raised.
    raiseRecognitionFailure(
      new TelephoneSetupProviderError(
        "stt",
        new ProviderReportedError(event.error ?? event),
      ),
    );
  });
  const detector = new voice.AMD(session, {
    detectionTimeoutMs: 10_000,
    interruptOnMachine: true,
    llm: "openai/gpt-5.4",
    noSpeechTimeoutMs: 5_000,
    participantIdentity,
    stt: recognition,
    waitUntilFinished: false,
  });
  return {
    async close() {
      await detector.aclose().catch(() => undefined);
      // The detector did not construct this transcriber, so it does not close
      // it either.
      await recognition.close().catch(() => undefined);
    },
    detector,
    recognitionFailure,
  };
}

export async function executeMachineDetection(
  bounded: BoundedMachineDetector,
): ReturnType<voice.AMD["execute"]> {
  try {
    return await Promise.race([
      bounded.detector.execute(),
      bounded.recognitionFailure,
    ]);
  } catch (error) {
    if (error instanceof TelephoneSetupProviderError) throw error;
    throw new TelephoneSetupProviderError(
      detectionFailureStage(error),
      error,
    );
  }
}

/**
 * Name the stage that raised a fault escaping the detector.
 *
 * Only the classifier's own call reaches this system as a provider's error: an
 * SDK error class or a framework report of unexpected model behaviour is that
 * provider's account of itself. Everything else the detector raises is its
 * lifecycle — a detector closed underneath a run, a run started twice — which
 * is this system's fault and was reported as an OpenAI outage for as long as
 * this whole path was marked as the interpretation provider's.
 */
function detectionFailureStage(
  error: unknown,
): "agent" | "coordinator" {
  return (error instanceof Error && isAPIError(error)) ||
    error instanceof UnexpectedModelBehavior
    ? "coordinator"
    : "agent";
}
