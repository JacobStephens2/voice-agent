import {
  APIStatusError,
  initializeLogger,
  voice,
} from "@livekit/agents";
import {
  defaultRecognizedSpeechModel,
  recognizedSpeechModels,
} from "@voice-agent/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  createBoundedMachineDetector,
  executeMachineDetection,
  type BoundedMachineDetector,
} from "../src/telephone-machine-detection.ts";
import {
  recordTelephoneSetupProviderFailure,
  TelephoneSetupProviderError,
} from "../src/telephone-setup-provider-failure.ts";

initializeLogger({ pretty: false, level: "silent" });

/** A gateway on a closed port: the recognition provider never answers. */
process.env.LIVEKIT_URL = "ws://127.0.0.1:1";
process.env.LIVEKIT_API_KEY = "detection-probe-key";
process.env.LIVEKIT_API_SECRET = "detection-probe-secret-detection-probe";

function stubSession(): voice.AgentSession {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    _activity: undefined,
    _roomIO: undefined,
    _setAmd: () => undefined,
    _subscribeAudioStream: () => new ReadableStream({ start() {} }),
    interrupt: () => ({ await: Promise.resolve() }),
    llm: undefined,
    off: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    pauseReplyAuthorization: () => undefined,
    resumeReplyAuthorization: () => undefined,
    rootSpanContext: undefined,
  } as unknown as voice.AgentSession;
}

describe("a recognition failure during machine detection", () => {
  test("is recorded against the recognition provider, not the classifier's", async () => {
    const detector = createBoundedMachineDetector(
      stubSession(),
      "sip_detection_probe",
      defaultRecognizedSpeechModel,
    );
    const outcome = await executeMachineDetection(detector)
      .then((prediction) => ({ kind: "prediction" as const, prediction }))
      .catch((error: unknown) => ({ kind: "raised" as const, error }));
    await detector.close();

    // Detection that returns `uncertain` here is failed as a machine, so a
    // silent recognition outage voicemails an answered callback.
    expect(outcome.kind).toBe("raised");
    if (outcome.kind !== "raised") return;
    expect(outcome.error).toBeInstanceOf(TelephoneSetupProviderError);
    expect((outcome.error as TelephoneSetupProviderError).stage).toBe("stt");

    const append = vi.fn(async () => undefined);
    const log = vi.fn();
    const recordProviderFailure = vi.fn(async () => ({ ended: true as const }));
    await recordTelephoneSetupProviderFailure({
      append,
      error: outcome.error,
      failureEventId: "detection-recognition-failure",
      log,
      occurredAt: "2026-08-25T18:00:00.000Z",
      recognition: defaultRecognizedSpeechModel,
      recordProviderFailure,
      telephoneSessionId: "telephone-session-detection",
    });

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "assemblyai",
        recovery: "terminal",
        stage: "stt",
        telephoneSessionId: "telephone-session-detection",
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          model: "assemblyai/universal-streaming-multilingual",
          provider: "assemblyai",
          stage: "stt",
        }),
        kind: "telephone.provider.failure",
      }),
    );
    expect(recordProviderFailure).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "stt" }),
    );
  }, 20_000);

  test("keeps the classifier's own fault at the interpretation stage", async () => {
    const raised = await executeMachineDetection(
      detectorRaising(
        new APIStatusError({ message: "classifier body", options: { statusCode: 503 } }),
      ),
    ).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(TelephoneSetupProviderError);
    expect((raised as TelephoneSetupProviderError).stage).toBe("coordinator");
  });

  test("attributes the detector's own lifecycle fault to this system", async () => {
    const raised = await executeMachineDetection(
      detectorRaising(new Error("AMD closed")),
    ).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(TelephoneSetupProviderError);
    expect((raised as TelephoneSetupProviderError).stage).toBe("agent");
  });
});

/** A detector whose run raises, with no recognition fault behind it. */
function detectorRaising(error: unknown): BoundedMachineDetector {
  const recognitionFailure = new Promise<never>(() => undefined);
  return {
    close: async () => undefined,
    detector: {
      execute: async () => {
        throw error;
      },
    } as unknown as voice.AMD,
    recognitionFailure,
  };
}

describe("the machine detector's transcriber", () => {
  test("recognizes speech with the configured Recognized Speech Model", async () => {
    const detector = createBoundedMachineDetector(
      stubSession(),
      "sip_detection_probe",
      recognizedSpeechModels["deepgram/flux-general-en"],
    );

    try {
      const recognition = (
        detector.detector as unknown as {
          readonly stt: {
            readonly model: string;
            readonly opts: { readonly modelOptions: Record<string, unknown> };
          };
        }
      ).stt;
      expect(recognition.model).toBe("deepgram/flux-general-en");
      // Configured from the same entry, but detection stays unbiased: it never
      // receives the conversation's domain keyterms in either spelling.
      expect(recognition.opts.modelOptions).not.toHaveProperty("keyterm");
      expect(recognition.opts.modelOptions).not.toHaveProperty(
        "keyterms_prompt",
      );
    } finally {
      await detector.close();
    }
  });
});

describe("a detection-time recognition fault under a configured model", () => {
  test("records the configured entry's provider and model", async () => {
    const append = vi.fn(async () => undefined);
    const log = vi.fn();

    await recordTelephoneSetupProviderFailure({
      append,
      error: new TelephoneSetupProviderError(
        "stt",
        new APIStatusError({ message: "gateway is unavailable", options: {} }),
      ),
      failureEventId: "detection-recognition-configured",
      log,
      occurredAt: "2026-08-25T18:00:00.000Z",
      recognition: recognizedSpeechModels["deepgram/flux-general-en"],
      recordProviderFailure: vi.fn(async () => ({ ended: true as const })),
      telephoneSessionId: "telephone-session-detection-configured",
    });

    // The detector raises its recognition faults through the setup path, so
    // this evidence must be readable against the model that raised them.
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          model: "deepgram/flux-general-en",
          provider: "deepgram",
          stage: "stt",
        }),
        kind: "telephone.provider.failure",
      }),
    );
  });

  test("names no model for a stage the recognition setting does not configure", async () => {
    const appended: { readonly details: Record<string, unknown> }[] = [];
    const append = async (event: unknown) => {
      appended.push(event as { readonly details: Record<string, unknown> });
    };

    await recordTelephoneSetupProviderFailure({
      append,
      error: new TelephoneSetupProviderError(
        "tts",
        new APIStatusError({ message: "gateway is unavailable", options: {} }),
      ),
      failureEventId: "detection-synthesis-configured",
      log: vi.fn(),
      occurredAt: "2026-08-25T18:00:00.000Z",
      recognition: recognizedSpeechModels["deepgram/flux-general-en"],
      recordProviderFailure: vi.fn(async () => ({ ended: true as const })),
      telephoneSessionId: "telephone-session-detection-synthesis",
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]?.details).not.toHaveProperty("model");
    expect(appended[0]?.details).toMatchObject({
      provider: "inworld",
      stage: "tts",
    });
  });
});
