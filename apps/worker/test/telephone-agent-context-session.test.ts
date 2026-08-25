import { initializeLogger, llm, voice } from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";
import {
  defaultRecognizedSpeechModel,
  recognizedSpeechModels,
  type RecognizedSpeechModel,
  type TelephoneConversationEvidenceEvent,
} from "@voice-agent/contracts";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  createConversationRecognitionSTT,
  runLiveKitTelephoneSession,
  type LiveKitTelephoneSessionDependencies,
} from "../src/livekit-telephone-session.ts";

initializeLogger({ level: "silent", pretty: false });
process.env.LIVEKIT_API_KEY ??= "agent-context-session-key";
process.env.LIVEKIT_API_SECRET ??= "agent-context-session-secret-context";
process.env.LIVEKIT_URL ??= "ws://127.0.0.1:1";

const contextual = recognizedSpeechModels["assemblyai/universal-3-5-pro"];
const openingText = "Voice Agent here. What can I do?";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("the reply the caller's next turn is recognized against", () => {
  test("each spoken reply reaches the transcriber before the caller answers it", async () => {
    const call = await runCall("contextual", contextual);

    // The opening is what the caller's first turn answers, and the response to
    // that turn is what their next one would.
    expect(call.agentContexts).toStrictEqual([
      openingText,
      call.spokenTexts[1],
    ]);
    // Nothing empty and nothing stale precedes them: the first value the
    // transcriber ever sees is the first thing the caller was told.
    expect(call.agentContexts.every((context) => context.length > 0)).toBe(true);
  });

  test("the entry's model is named on the speech-timing evidence of the turn", async () => {
    const call = await runCall("contextual-evidence", contextual);

    expect(
      call.evidence
        .filter((event) => event.kind === "telephone.provider.timing")
        .map((event) => event.details),
    ).toContainEqual(
      expect.objectContaining({
        model: "assemblyai/universal-3-5-pro",
        provider: "assemblyai",
        stage: "stt",
      }),
    );
  });

  test("an entry whose gateway does not accept it is sent no such option", async () => {
    const call = await runCall("default-entry", defaultRecognizedSpeechModel);

    expect(call.spokenTexts.length).toBeGreaterThan(1);
    expect(call.updatedOptions).toStrictEqual([]);
  });
});

/** One whole call, spoken through a transcriber that records its updates. */
async function runCall(
  suffix: string,
  recognitionModel: RecognizedSpeechModel,
): Promise<{
  readonly agentContexts: readonly string[];
  readonly evidence: readonly TelephoneConversationEvidenceEvent[];
  readonly spokenTexts: readonly string[];
  readonly updatedOptions: readonly Record<string, unknown>[];
}> {
  const directory = await mkdtemp(
    join(tmpdir(), `voice-agent-agent-context-${suffix}-`),
  );
  temporaryDirectories.push(directory);
  const store = createSqliteDurableTaskStore(join(directory, "voice-agent.sqlite"));
  await store.registerBountywell("2026-08-24T09:00:00.000Z");
  let taskSequence = 0;
  const tasks = createDurableTaskRuntime({
    applicationRegistry: store,
    healthObserver: {
      async observe() {
        return {
          checks: [
            {
              facts: { statusCode: 200 },
              outcome: "pass" as const,
              source: "public-health" as const,
              summary: "The public health endpoint responded successfully.",
            },
            {
              facts: { statusCode: 401 },
              outcome: "pass" as const,
              source: "authentication-boundary" as const,
              summary: "The protected data endpoint required authentication.",
            },
          ],
          observedAt: "2026-08-24T09:00:01.000Z",
          rejectedEvidenceCount: 0,
        };
      },
    },
    nextId: () => `${suffix}-task-${(taskSequence += 1)}`,
    now: () => "2026-08-24T09:00:00.000Z",
    store,
  });
  const evidence: TelephoneConversationEvidenceEvent[] = [];
  const harness = new AgentContextSessionHarness(recognitionModel);
  const dependencies: LiveKitTelephoneSessionDependencies = {
    createConversationSession: () => harness.asAgentSession(),
    createInterpreter: () => ({
      async close() {},
      async interpret() {
        return {
          durationMs: 24,
          intent: "bountywell-health" as const,
          provider: "deterministic-agent-context",
        };
      },
    }),
    logProviderFailure: () => {},
  };

  try {
    await runLiveKitTelephoneSession(
      {
        boundaries: telephoneBoundaries(),
        disconnected: Promise.resolve(),
        async endCall() {},
        openingText,
        recognitionModel,
        room: {} as Room,
        sessionEvidence: {
          async append(event) {
            evidence.push({
              ...event,
              sequence: evidence.length + 1,
            } as TelephoneConversationEvidenceEvent);
          },
        },
        tasks,
        telephoneSessionId: `telephone-session-agent-context-${suffix}`,
        usageRatesMicrousdPerMinute: {
          api: 1,
          "realtime-media": 1,
          telephony: 1,
        },
      },
      dependencies,
    );
  } finally {
    await tasks.close();
  }

  return {
    agentContexts: harness.updatedOptions.map((options) =>
      String(options.agent_context),
    ),
    evidence,
    spokenTexts: harness.spokenTexts,
    updatedOptions: harness.updatedOptions,
  };
}

function telephoneBoundaries(): Parameters<
  typeof runLiveKitTelephoneSession
>[0]["boundaries"] {
  return {
    async claimRawAudioCapture() {
      return {
        decision: "rejected" as const,
        reason: "debug-grant-required" as const,
      };
    },
    async claimStateChangingTask() {
      return {
        decision: "accepted" as const,
        resource: "state-changing-task" as const,
      };
    },
    async endSession() {
      return { ended: false as const };
    },
    async noteActivity() {},
    async recordProviderFailure() {
      return { ended: false as const };
    },
    async releaseStateChangingTask() {
      return {};
    },
    async reserveUsageSlice() {
      return {
        disposition: "continue" as const,
        month: "2026-08",
        reservedSources: [
          "api" as const,
          "telephony" as const,
          "realtime-media" as const,
        ],
        totalMicrousd: 1,
        warnings: [],
      };
    },
  } as unknown as Parameters<typeof runLiveKitTelephoneSession>[0]["boundaries"];
}

/**
 * A session whose transcriber records the option updates it is given, in the
 * order they arrive relative to the responses actually spoken.
 */
class AgentContextSessionHarness {
  readonly spokenTexts: string[] = [];
  readonly updatedOptions: Record<string, unknown>[] = [];
  readonly #handlers = new Map<string, (event: never) => void>();
  readonly #transcriber: ReturnType<typeof createConversationRecognitionSTT>;

  constructor(recognition: RecognizedSpeechModel) {
    // The transcriber the entry actually builds, so the per-turn option
    // travels the seam it travels in a real call.
    this.#transcriber = createConversationRecognitionSTT(recognition);
    const updatedOptions = this.updatedOptions;
    this.#transcriber.updateOptions = (options: {
      readonly modelOptions?: Record<string, unknown>;
    }) => {
      if (options.modelOptions !== undefined) {
        updatedOptions.push(options.modelOptions);
      }
    };
  }

  asAgentSession(): voice.AgentSession {
    const harness = this;
    return {
      async close() {},
      async interrupt() {},
      on(eventType: string, handler: (event: never) => void) {
        harness.#handlers.set(eventType, handler);
        return this;
      },
      output: {
        audio: {
          async captureFrame() {},
          flush() {},
          async waitForPlayout() {},
        },
      },
      say(text: string) {
        harness.spokenTexts.push(text);
        return {
          done: () => true,
          exception: () => undefined,
          interrupted: false,
          async waitForPlayout() {
            harness.emit(voice.AgentSessionEventTypes.AgentStateChanged, {
              newState: "speaking",
            });
          },
        };
      },
      async start(input: { agent: voice.Agent }) {
        harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
          createdAt: 1_787_000_000_000,
          newState: "speaking",
        });
        await input.agent.onUserTurnCompleted(
          llm.ChatContext.empty(),
          llm.ChatMessage.create({
            content: "Is Bountywell healthy?",
            createdAt: 1_787_000_002_000,
            id: "agent-context-turn-001",
            role: "user",
          }),
        );
      },
      stt: harness.#transcriber,
    } as unknown as voice.AgentSession;
  }

  private emit(eventType: string, event: unknown): void {
    const handler = this.#handlers.get(eventType);
    if (handler === undefined) {
      throw new Error(`Missing LiveKit handler for ${eventType}`);
    }
    handler(event as never);
  }
}
