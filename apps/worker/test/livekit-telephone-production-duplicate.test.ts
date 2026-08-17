import { llm, voice } from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  runLiveKitTelephoneSession,
  type LiveKitTelephoneSessionDependencies,
} from "../src/livekit-telephone-session.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("production-shaped LiveKit telephone turns", () => {
  test("one semantic question produces one Task, Operation, and spoken response", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-livekit-production-duplicate-"),
    );
    temporaryDirectories.push(directory);
    const store = createSqliteDurableTaskStore(
      join(directory, "voice-agent.sqlite"),
    );
    await store.registerBountywell("2026-08-17T19:57:00.000Z");
    const ids = Array.from(
      { length: 12 },
      (_, index) => `production-id-${index + 1}`,
    );
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
                summary:
                  "The protected data endpoint required authentication.",
              },
            ],
            observedAt: "2026-08-17T19:57:17.000Z",
            rejectedEvidenceCount: 0,
          };
        },
      },
      nextId() {
        const id = ids.shift();
        if (id === undefined) {
          throw new Error("The regression exhausted its deterministic IDs");
        }
        return id;
      },
      now: () => "2026-08-17T19:57:16.917Z",
      store,
    });
    const session = new LiveKitSessionHarness();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-regression",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          boundaries: {
            async claimRawAudioCapture() {
              return {
                decision: "rejected" as const,
                reason: "debug-grant-required" as const,
              };
            },
            async endSession() {
              return { ended: false as const };
            },
            async noteActivity() {},
            async recordProviderFailure() {
              return { ended: false as const };
            },
            async recordUsage() {
              return {
                disposition: "continue" as const,
                month: "2026-08",
                totalMicrousd: 1,
                warnings: [],
              };
            },
          },
          disconnected: Promise.resolve(),
          async endCall() {},
          room: {} as Room,
          sessionEvidence: { async append() {} },
          tasks,
          telephoneSessionId: "199afc7a-9d64-4aac-987b-aa734e19553b",
          usageRatesMicrousdPerMinute: {
            api: 1,
            "realtime-media": 1,
            telephony: 1,
          },
        },
        dependencies,
      );

      const summaries = await tasks.listEvidenceRecords();
      expect(summaries).toHaveLength(1);
      const summary = summaries[0];
      if (summary === undefined) {
        throw new Error("Expected one Durable Task");
      }
      const record = await tasks.getEvidenceRecord(summary.id);
      expect(
        record?.evidence.filter((event) => event.kind === "task.accepted"),
      ).toHaveLength(1);
      expect(
        record?.evidence.filter(
          (event) => event.kind === "operation.accepted",
        ),
      ).toHaveLength(1);
      expect(
        record?.evidence.filter(
          (event) => event.kind === "operation.completed",
        ),
      ).toHaveLength(1);
      expect(
        record?.evidence.filter(
          (event) => event.kind === "telephone.semantic.response",
        ),
      ).toHaveLength(1);
      const sttTiming = record?.evidence.find(
        (event) =>
          event.kind === "telephone.provider.timing" &&
          event.details.stage === "stt",
      );
      if (sttTiming?.kind !== "telephone.provider.timing") {
        throw new Error("Expected retained STT timing");
      }
      expect(sttTiming.details.durationMs).toBe(3_162);
      expect(session.spokenTexts).toHaveLength(1);
    } finally {
      await tasks.close();
    }
  });
});

class LiveKitSessionHarness {
  readonly spokenTexts: string[] = [];
  readonly #handlers = new Map<string, (event: never) => void>();

  asAgentSession(): voice.AgentSession {
    const harness = this;
    return {
      async close() {},
      on(eventType: string, handler: (event: never) => void) {
        harness.#handlers.set(eventType, handler);
        return this;
      },
      say(text: string) {
        harness.spokenTexts.push(text);
        return {
          interrupted: false,
          async waitForPlayout() {},
        };
      },
      async start(input: { agent: voice.Agent }) {
        harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
          createdAt: 1_786_996_633_755,
          newState: "speaking",
        });
        harness.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
          createdAt: 1_786_996_633_878,
          isFinal: true,
          itemId: "production-segment-001",
          transcript: "Is Bountywell Healthy.",
        });
        harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
          createdAt: 1_786_996_634_235,
          newState: "speaking",
        });
        harness.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
          createdAt: 1_786_996_636_917,
          isFinal: true,
          itemId: "production-segment-002",
          transcript: "is bountywell healthy",
        });
        await input.agent.onUserTurnCompleted(
          llm.ChatContext.empty(),
          llm.ChatMessage.create({
            content: "Is Bountywell healthy?",
            createdAt: 1_786_996_636_917,
            id: "production-completed-turn-001",
            role: "user",
          }),
        );
      },
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
