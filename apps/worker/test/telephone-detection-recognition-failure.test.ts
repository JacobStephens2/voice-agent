import {
  APIStatusError,
  initializeLogger,
  voice,
} from "@livekit/agents";
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
