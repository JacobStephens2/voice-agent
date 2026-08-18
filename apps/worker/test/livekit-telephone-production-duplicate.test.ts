import { llm, voice } from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";
import {
  createDurableTaskRuntime,
  createTelephoneBoundaryRuntime,
} from "@voice-agent/runtime";
import {
  createSqliteDurableTaskStore,
  createSqliteTelephoneBoundaryStore,
} from "@voice-agent/sqlite-store";
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
            async releaseStateChangingTask() {
              return {};
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

  test.each([
    postStartFailureCase("stt", "stt_error", "error"),
    postStartFailureCase("stt", "stt_error", "close"),
    postStartFailureCase("coordinator", "llm_error", "error"),
    postStartFailureCase("coordinator", "llm_error", "close"),
    postStartFailureCase("tts", "tts_error", "error"),
    postStartFailureCase("tts", "tts_error", "close"),
  ])(
    "an unrecoverable post-start $stage $kind event ends through the local fail-closed path",
    ({ event, stage, suffix }) =>
      expectPostStartProviderFailure(event, stage, suffix),
  );

  test("an unknown session-start failure is not attributed to a speech provider", async () => {
    const session = new StartFailureSessionHarness();
    const endCall = vi.fn(async () => undefined);
    const endSession = vi.fn(
      async (_sessionId: string, _reason: "provider-failure") => ({
        durationMs: 0,
        ended: true as const,
        reason: "provider-failure" as const,
      }),
    );
    const recordProviderFailure = vi.fn(async () =>
      endSession("telephone-session-start-failure", "provider-failure"),
    );
    const evidence: unknown[] = [];
    const notifications: unknown[] = [];

    await runLiveKitTelephoneSession(
      {
        boundaries: {
          async claimStateChangingTask() {
            return { decision: "accepted", resource: "state-changing-task" };
          },
          endSession,
          async noteActivity() {},
          recordProviderFailure,
          async releaseStateChangingTask() {
            return {};
          },
          async reserveUsageSlice() {
            throw new Error("Usage must not start after session startup fails");
          },
        } as unknown as Parameters<
          typeof runLiveKitTelephoneSession
        >[0]["boundaries"],
        disconnected: new Promise<void>(() => {}),
        endCall,
        room: {} as Room,
        sessionEvidence: {
          async append(event) {
            evidence.push(event);
          },
          async requestFailureNotification(input) {
            notifications.push(input);
          },
        },
        tasks: {} as Parameters<typeof runLiveKitTelephoneSession>[0]["tasks"],
        telephoneSessionId: "telephone-session-start-failure",
        usageRatesMicrousdPerMinute: {
          api: 1,
          "realtime-media": 1,
          telephony: 1,
        },
      },
      {
        createConversationSession: () => session.asAgentSession(),
        createInterpreter: () => ({
          async close() {},
          async interpret() {
            throw new Error("Interpreter must not run after startup failure");
          },
        }),
      },
    );

    expect(recordProviderFailure).toHaveBeenCalledWith({
      failureClass: "unavailable",
      sessionId: "telephone-session-start-failure",
      stage: "setup",
    });
    expect(endSession).toHaveBeenCalledWith(
      "telephone-session-start-failure",
      "provider-failure",
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          failure: "unavailable",
          provider: "livekit",
          stage: "setup",
        }),
        kind: "telephone.provider.failure",
      }),
    ]);
    expect(notifications).toHaveLength(1);
    expect(session.playedFailureFrames).toBeGreaterThan(0);
    expect(endCall).toHaveBeenCalledOnce();
  });
});

async function expectPostStartProviderFailure(
  event: PostStartFailureEvent,
  stage: "coordinator" | "stt" | "tts",
  suffix: string,
): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "voice-agent-livekit-provider-failure-"),
  );
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const taskStore = createSqliteDurableTaskStore(databasePath);
  const tasks = createDurableTaskRuntime({
    nextId: () => "unused-provider-failure-id",
    now: () => "2026-08-17T20:00:00.000Z",
    store: taskStore,
  });
  const boundaryStore = createSqliteTelephoneBoundaryStore(databasePath);
  let boundarySequence = 0;
  const boundaries = createTelephoneBoundaryRuntime({
    nextId: () => `boundary-event-${(boundarySequence += 1)}`,
    now: () => "2026-08-17T20:00:00.000Z",
    store: boundaryStore,
  });
  const sessionId = `telephone-session-failure-${suffix}`;
  await boundaries.reserveWarmSession(sessionId);
  await boundaries.activateSession(sessionId);
  const session = new PostStartFailureSessionHarness(event);
  const evidence: unknown[] = [];
  const notifications: unknown[] = [];
  const endCall = vi.fn(async () => undefined);
  const disconnected = new Promise<void>(() => {});

  try {
    await runLiveKitTelephoneSession(
      {
        boundaries,
        disconnected,
        endCall,
        room: {} as Room,
        sessionEvidence: {
          async append(evidenceEvent) {
            evidence.push(evidenceEvent);
          },
          async requestFailureNotification(input) {
            notifications.push(input);
          },
        },
        tasks,
        telephoneSessionId: sessionId,
        usageRatesMicrousdPerMinute: {
          api: 1,
          "realtime-media": 1,
          telephony: 1,
        },
      },
      {
        createConversationSession: () => session.asAgentSession(),
        createInterpreter: () => ({
          async close() {},
          async interpret() {
            throw new Error("Interpreter must not run after provider failure");
          },
        }),
      },
    );

    expect(endCall).toHaveBeenCalledOnce();
    expect(session.playedFailureFrames).toBeGreaterThan(0);
    expect(evidence).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ stage }),
        kind: "telephone.provider.failure",
      }),
    ]);
    expect(notifications).toHaveLength(1);
    await expect(boundaries.readSession(sessionId)).resolves.toMatchObject({
      state: "ended",
    });
  } finally {
    await boundaries.close();
    await tasks.close();
  }
}

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

interface PostStartFailureDetails {
  readonly error: {
    readonly error: Error;
    readonly label: string;
    readonly recoverable: boolean;
    readonly timestamp: number;
    readonly type: "llm_error" | "stt_error" | "tts_error";
  };
}

type PostStartFailureEvent =
  | (PostStartFailureDetails & { readonly kind: "error" })
  | (PostStartFailureDetails & {
      readonly kind: "close";
      readonly reason: voice.CloseReason.ERROR;
    });

function postStartFailureCase(
  stage: "coordinator" | "stt" | "tts",
  type: PostStartFailureDetails["error"]["type"],
  kind: "close" | "error",
): {
  readonly event: PostStartFailureEvent;
  readonly kind: "close" | "error";
  readonly stage: "coordinator" | "stt" | "tts";
  readonly suffix: string;
} {
  const error = {
    error: new Error(`secret ${stage} response`),
    label: stage,
    recoverable: false,
    timestamp: 1_776_444_000_000,
    type,
  };
  return {
    event:
      kind === "error"
        ? { error, kind }
        : { error, kind, reason: voice.CloseReason.ERROR },
    kind,
    stage,
    suffix: `${stage}-${kind}`,
  };
}

class PostStartFailureSessionHarness {
  playedFailureFrames = 0;
  readonly #event: PostStartFailureEvent;
  readonly #handlers = new Map<string, (event: never) => void>();

  constructor(event: PostStartFailureEvent) {
    this.#event = event;
  }

  asAgentSession(): voice.AgentSession {
    const harness = this;
    return {
      async close() {},
      on(eventType: string, handler: (event: never) => void) {
        harness.#handlers.set(eventType, handler);
        return this;
      },
      output: {
        audio: {
          async captureFrame() {
            harness.playedFailureFrames += 1;
          },
          flush() {},
          async waitForPlayout() {},
        },
      },
      async start() {
        const eventType =
          harness.#event.kind === "error"
            ? voice.AgentSessionEventTypes.Error
            : voice.AgentSessionEventTypes.Close;
        const handler = harness.#handlers.get(eventType);
        handler?.(
          harness.#event.kind === "error"
            ? ({
                createdAt: 1_776_444_000_000,
                error: harness.#event.error,
                type: "error",
              } as never)
            : ({
                createdAt: 1_776_444_000_000,
                error: harness.#event.error,
                reason: harness.#event.reason,
                type: "close",
              } as never),
        );
      },
    } as unknown as voice.AgentSession;
  }
}

class StartFailureSessionHarness {
  playedFailureFrames = 0;

  asAgentSession(): voice.AgentSession {
    const harness = this;
    return {
      async close() {},
      on() {
        return this;
      },
      output: {
        audio: {
          async captureFrame() {
            harness.playedFailureFrames += 1;
          },
          flush() {},
          async waitForPlayout() {},
        },
      },
      async start() {
        throw new Error("unknown LiveKit setup failure");
      },
    } as unknown as voice.AgentSession;
  }
}
