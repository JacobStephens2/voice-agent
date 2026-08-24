import { APITimeoutError, llm, voice } from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";
import type { TelephoneConversationEvidenceEvent } from "@voice-agent/contracts";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

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

describe("bounded LiveKit telephone provider recovery", () => {
  test("one transient coordinator failure is retried under the same durable turn identity", async () => {
    const tasks = await createTasks("coordinator-retry");
    const session = new RecoverySessionHarness();
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    let attempts = 0;
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          attempts += 1;
          if (attempts === 1) {
            throw new APITimeoutError({ message: "Coordinator timed out" });
          }
          return {
            durationMs: 31,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks,
          telephoneSessionId: "telephone-session-coordinator-retry",
        }),
        dependencies,
      );

      expect(attempts).toBe(2);
      expect(session.spokenTexts).toHaveLength(1);
      expect(session.spokenTexts[0]).toContain("Bountywell's API is healthy.");
      expect(session.failurePlaybacks).toBe(0);
      expect(recordProviderFailure).toHaveBeenCalledTimes(1);
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "coordinator" }),
      );
      const retries = evidence.filter(
        (event) => event.kind === "telephone.provider.retry",
      );
      expect(retries).toHaveLength(1);
      expect(retries[0]?.details).toMatchObject({
        provider: "openai",
        stage: "coordinator",
        turnId: turnIdentityOf(evidence),
      });
      const summaries = await tasks.listEvidenceRecords();
      expect(summaries).toHaveLength(1);
    } finally {
      await tasks.close();
    }
  });

  test("a transient recognition failure asks the caller to repeat instead of ending", async () => {
    const tasks = await createTasks("stt-retry");
    const session = new RecoverySessionHarness({ transcriptionTimeout: true });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-stt-retry",
          }),
          endCall,
        },
        dependencies,
      );

      expect(session.spokenTexts).toContain(
        "Sorry, I did not catch that. Please say that again.",
      );
      expect(session.failurePlaybacks).toBe(0);
      expect(endCall).not.toHaveBeenCalled();
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "stt" }),
      );
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.retry"),
      ).toHaveLength(1);
      // The caller repeats and is answered under a fresh turn identity.
      expect(session.spokenTexts.at(-1)).toContain(
        "Bountywell's API is healthy.",
      );
    } finally {
      await tasks.close();
    }
  });

  test("a retry that replays an already-answered turn still ends the call once", async () => {
    const pendingRecord = {
      evidence: [],
      task: {
        conclusion: "Bountywell inquiry is pending.",
        createdAt: "2026-08-24T09:00:00.000Z",
        id: "task-pending-recovery",
        kind: "bountywell.health.inquiry",
        question: "Is Bountywell healthy?",
        status: "pending",
        updatedAt: "2026-08-24T09:00:00.000Z",
      },
    };
    const session = new RecoverySessionHarness({
      extraCompletedTurns: [
        llm.ChatMessage.create({
          content: "Yes, I confirm.",
          createdAt: 1_787_000_004_000,
          id: "recovery-completed-turn-002",
          role: "user",
        }),
      ],
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    await runLiveKitTelephoneSession(
      {
        ...sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          // The Completion Callback control is absent, so accepting the offer
          // throws after the coordinator has already answered that turn.
          tasks: {
            async appendTelephoneEvidence() {
              return pendingRecord;
            },
            async submitTelephoneBountywellHealthInquiry() {
              return pendingRecord;
            },
          } as unknown as ReturnType<typeof createDurableTaskRuntime>,
          telephoneSessionId: "telephone-session-answered-replay",
        }),
        endCall,
      },
      dependencies,
    );

    expect(
      evidence.filter((event) => event.kind === "telephone.provider.retry"),
    ).toHaveLength(1);
    expect(session.failurePlaybacks).toBe(1);
    expect(endCall).toHaveBeenCalledTimes(1);
  });

  test("a remaining speech failure plays one prerecorded response and ends the call once", async () => {
    const tasks = await createTasks("tts-terminal");
    const session = new RecoverySessionHarness({ failEverySay: true });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-tts-terminal",
          }),
          endCall,
        },
        dependencies,
      );

      // The answer is attempted, retried once under its own identity, and then
      // abandoned for the one prerecorded terminal response.
      expect(session.attemptedSays).toBe(2);
      expect(session.failurePlaybacks).toBe(1);
      expect(endCall).toHaveBeenCalledTimes(1);
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.retry"),
      ).toHaveLength(1);
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.failure"),
      ).toHaveLength(2);
      const summaries = await tasks.listEvidenceRecords();
      expect(summaries).toHaveLength(1);
      const record = await tasks.getEvidenceRecord(summaries[0]?.id ?? "");
      // The accepted Durable Task survives the failed call for recovery.
      expect(record?.task.conclusion).toBe("Bountywell API is healthy.");
    } finally {
      await tasks.close();
    }
  });
});

function turnIdentityOf(
  evidence: readonly TelephoneConversationEvidenceEvent[],
): string {
  const finalized = evidence.find(
    (event) => event.kind === "telephone.turn.finalized",
  );
  if (finalized?.kind !== "telephone.turn.finalized") {
    throw new Error("Expected one finalized telephone turn in evidence");
  }
  return finalized.details.turnId;
}

async function createTasks(
  suffix: string,
): Promise<ReturnType<typeof createDurableTaskRuntime>> {
  const directory = await mkdtemp(
    join(tmpdir(), `voice-agent-livekit-recovery-${suffix}-`),
  );
  temporaryDirectories.push(directory);
  const store = createSqliteDurableTaskStore(
    join(directory, "voice-agent.sqlite"),
  );
  await store.registerBountywell("2026-08-24T09:00:00.000Z");
  const ids = Array.from(
    { length: 16 },
    (_, index) => `${suffix}-id-${index + 1}`,
  );
  return createDurableTaskRuntime({
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
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The recovery test exhausted its deterministic IDs");
      }
      return id;
    },
    now: () => "2026-08-24T09:00:00.000Z",
    store,
  });
}

function sessionOptions(input: {
  readonly evidence: TelephoneConversationEvidenceEvent[];
  readonly recordProviderFailure: () => Promise<{ readonly ended: false }>;
  readonly session: RecoverySessionHarness;
  readonly tasks: ReturnType<typeof createDurableTaskRuntime>;
  readonly telephoneSessionId: string;
}): Parameters<typeof runLiveKitTelephoneSession>[0] {
  return {
    boundaries: {
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
      recordProviderFailure: input.recordProviderFailure,
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
    } as unknown as Parameters<
      typeof runLiveKitTelephoneSession
    >[0]["boundaries"],
    disconnected: Promise.resolve(),
    async endCall() {},
    room: {} as Room,
    sessionEvidence: {
      async append(event) {
        input.evidence.push({
          ...event,
          sequence: input.evidence.length + 1,
        } as TelephoneConversationEvidenceEvent);
      },
    },
    tasks: input.tasks,
    telephoneSessionId: input.telephoneSessionId,
    usageRatesMicrousdPerMinute: {
      api: 1,
      "realtime-media": 1,
      telephony: 1,
    },
  };
}

class RecoverySessionHarness {
  attemptedSays = 0;
  failurePlaybacks = 0;
  readonly spokenTexts: string[] = [];
  readonly #extraCompletedTurns: readonly llm.ChatMessage[];
  readonly #failEverySay: boolean;
  readonly #handlers = new Map<string, (event: never) => void>();
  readonly #transcriptionTimeout: boolean;

  constructor(
    options: {
      readonly extraCompletedTurns?: readonly llm.ChatMessage[];
      readonly failEverySay?: boolean;
      readonly transcriptionTimeout?: boolean;
    } = {},
  ) {
    this.#extraCompletedTurns = options.extraCompletedTurns ?? [];
    this.#failEverySay = options.failEverySay ?? false;
    this.#transcriptionTimeout = options.transcriptionTimeout ?? false;
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
          flush() {
            harness.failurePlaybacks += 1;
          },
          async waitForPlayout() {},
        },
      },
      say(text: string) {
        harness.attemptedSays += 1;
        if (harness.#failEverySay) {
          throw new APITimeoutError({ message: "Speech synthesis timed out" });
        }
        harness.spokenTexts.push(text);
        return {
          interrupted: false,
          async waitForPlayout() {},
        };
      },
      async start(input: { agent: voice.Agent }) {
        harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
          createdAt: 1_787_000_000_000,
          newState: "speaking",
        });
        if (harness.#transcriptionTimeout) {
          harness.emit(
            voice.AgentSessionEventTypes.UserTranscriptionTimeout,
            {},
          );
          harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
            createdAt: 1_787_000_001_000,
            newState: "speaking",
          });
        }
        await input.agent.onUserTurnCompleted(
          llm.ChatContext.empty(),
          llm.ChatMessage.create({
            content: "Is Bountywell healthy?",
            createdAt: 1_787_000_002_000,
            id: "recovery-completed-turn-001",
            role: "user",
          }),
        );
        for (const extra of harness.#extraCompletedTurns) {
          harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
            createdAt: extra.createdAt - 1_000,
            newState: "speaking",
          });
          await input.agent.onUserTurnCompleted(llm.ChatContext.empty(), extra);
        }
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
