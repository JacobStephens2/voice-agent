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

const activatedAtMs = Date.parse("2026-08-24T14:14:45.000Z");
/** The recognition timeout, fifteen seconds into the call. */
const recognitionTimeoutMs = activatedAtMs + 15_000;
/** When the caller actually left, forty-five seconds later. */
const callEndedAtMs = activatedAtMs + 60_000;

interface BoundaryEvidenceEntry {
  readonly kind: string;
  readonly occurredAt: string;
  readonly details: unknown;
}

describe("recognition timeout and the Telephone Session boundary record", () => {
  test("records the end of the call, not of the recognition timeout the caller survived", async () => {
    const call = await startRecognitionTimeoutCall("survived");
    // The caller repeats, is answered, stays on the line, and then hangs up.
    call.setNow(callEndedAtMs);
    call.hangUp();
    await call.finished;

    expect(endings(call.boundaryEvidence)).toEqual([
      {
        durationMs: callEndedAtMs - activatedAtMs,
        occurredAt: new Date(callEndedAtMs).toISOString(),
        reason: "disconnected",
      },
    ]);
  });

  test("still ends the record when a second recognition timeout ends the call", async () => {
    const call = await startRecognitionTimeoutCall("terminal");
    // The session grants one retry per call, so this fault ends it.
    const secondTimeoutMs = recognitionTimeoutMs + 20_000;
    call.setNow(secondTimeoutMs);
    call.recognitionTimeout();
    await call.finished;

    expect(endings(call.boundaryEvidence)).toEqual([
      {
        durationMs: secondTimeoutMs - activatedAtMs,
        occurredAt: new Date(secondTimeoutMs).toISOString(),
        reason: "provider-failure",
      },
    ]);
  });
});

function endings(
  boundaryEvidence: readonly BoundaryEvidenceEntry[],
): readonly unknown[] {
  return boundaryEvidence
    .filter((event) => event.kind === "telephone.session.ended")
    .map((event) => ({
      ...(event.details as { durationMs: number; reason: string }),
      occurredAt: event.occurredAt,
    }));
}

/**
 * Runs a call through one recognition-stage timeout and returns it still live,
 * with the clock and the caller's departure under the test's control.
 */
async function startRecognitionTimeoutCall(suffix: string): Promise<{
  readonly boundaryEvidence: readonly BoundaryEvidenceEntry[];
  readonly finished: Promise<void>;
  hangUp(): void;
  recognitionTimeout(): void;
  setNow(milliseconds: number): void;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), `voice-agent-recognition-timeout-${suffix}-`),
  );
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const taskStore = createSqliteDurableTaskStore(databasePath);
  await taskStore.registerBountywell("2026-08-24T09:00:00.000Z");
  let taskSequence = 0;
  const tasks = createDurableTaskRuntime({
    applicationRegistry: taskStore,
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
    store: taskStore,
  });

  // The clock the boundary reads: it stands where the live call stood.
  let nowMs = activatedAtMs;
  let boundarySequence = 0;
  const boundaryEvidence: BoundaryEvidenceEntry[] = [];
  const boundaries = createTelephoneBoundaryRuntime({
    evidence: {
      async append(_sessionId, event) {
        boundaryEvidence.push(event as BoundaryEvidenceEntry);
      },
    },
    nextId: () => `${suffix}-boundary-${(boundarySequence += 1)}`,
    now: () => new Date(nowMs).toISOString(),
    store: createSqliteTelephoneBoundaryStore(databasePath),
  });
  const sessionId = `telephone-session-recognition-timeout-${suffix}`;
  await boundaries.reserveWarmSession(sessionId);
  await boundaries.activateSession(sessionId);

  // Holds the harness at the moment a fault is being handled, so the boundary
  // is written against the clock the live call saw rather than a later one.
  let resolveFailureHandled: () => void = () => {};
  let failureHandled = new Promise<void>((resolve) => {
    resolveFailureHandled = resolve;
  });
  const observedBoundaries = {
    ...boundaries,
    async recordProviderFailure(
      input: Parameters<typeof boundaries.recordProviderFailure>[0],
    ) {
      try {
        return await boundaries.recordProviderFailure(input);
      } finally {
        resolveFailureHandled();
      }
    },
  };

  const harness = new RecognitionTimeoutSessionHarness(() => failureHandled);
  let resolveDisconnected: () => void = () => {};
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnected = resolve;
  });
  const dependencies: LiveKitTelephoneSessionDependencies = {
    createConversationSession: () => harness.asAgentSession(),
    createInterpreter: () => ({
      async close() {},
      async interpret() {
        return {
          durationMs: 24,
          intent: "bountywell-health" as const,
          provider: "deterministic-recognition-timeout",
        };
      },
    }),
    logProviderFailure: () => {},
  };

  nowMs = recognitionTimeoutMs;
  const run = runLiveKitTelephoneSession(
    {
      boundaries: observedBoundaries,
      disconnected,
      async endCall() {},
      room: {} as Room,
      sessionEvidence: { async append() {} },
      tasks,
      telephoneSessionId: sessionId,
      usageRatesMicrousdPerMinute: {
        api: 1,
        "realtime-media": 1,
        telephony: 1,
      },
    },
    dependencies,
  );
  await harness.started;

  return {
    boundaryEvidence,
    finished: run.finally(async () => {
      await tasks.close();
      boundaries.close();
    }),
    hangUp: resolveDisconnected,
    recognitionTimeout() {
      failureHandled = new Promise<void>((resolve) => {
        resolveFailureHandled = resolve;
      });
      harness.recognitionTimeout();
    },
    setNow(milliseconds: number) {
      nowMs = milliseconds;
    },
  };
}

class RecognitionTimeoutSessionHarness {
  readonly started: Promise<void>;
  readonly #handlers = new Map<string, (event: never) => void>();
  readonly #failureHandled: () => Promise<void>;
  #resolveStarted: () => void = () => {};

  constructor(failureHandled: () => Promise<void>) {
    this.#failureHandled = failureHandled;
    this.started = new Promise<void>((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  recognitionTimeout(): void {
    this.emit(voice.AgentSessionEventTypes.UserTranscriptionTimeout, {});
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
      say() {
        return {
          done: () => true,
          exception: () => undefined,
          interrupted: false,
          async waitForPlayout() {
            // A working provider plays its first synthesized frame, which is
            // what moves the agent into speaking.
            harness.emit(voice.AgentSessionEventTypes.AgentStateChanged, {
              newState: "speaking",
            });
          },
        };
      },
      async start(input: { agent: voice.Agent }) {
        harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
          createdAt: activatedAtMs,
          newState: "speaking",
        });
        harness.recognitionTimeout();
        await harness.#failureHandled();
        harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
          createdAt: recognitionTimeoutMs + 1_000,
          newState: "speaking",
        });
        // The caller repeats and is answered, so the call continues.
        await input.agent.onUserTurnCompleted(
          llm.ChatContext.empty(),
          llm.ChatMessage.create({
            content: "Is Bountywell healthy?",
            createdAt: recognitionTimeoutMs + 2_000,
            id: "recognition-timeout-turn-001",
            role: "user",
          }),
        );
        harness.#resolveStarted();
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
