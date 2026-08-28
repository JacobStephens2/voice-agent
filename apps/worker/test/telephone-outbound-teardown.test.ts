import { voice } from "@livekit/agents";
import { RoomEvent, type RemoteParticipant, type Room } from "@livekit/rtc-node";
import {
  createCallbackHandshakeRuntime,
  createTelephoneBoundaryRuntime,
} from "@voice-agent/runtime";
import {
  createSqliteCallbackHandshakeStore,
  createSqliteTelephoneBoundaryStore,
} from "@voice-agent/sqlite-store";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { CallbackHandshakeDependencies } from "../src/telephone-agent.ts";
import { wellFormedTelephoneWorkerEnvironment } from "./telephone-worker-environment.ts";

// The worker resolves its settings as it loads, so they are in place before
// this module imports it, and one load then serves every test here.
for (const [name, value] of Object.entries(
  wellFormedTelephoneWorkerEnvironment,
)) {
  process.env[name] = value;
}
const { handleOutbound } = await import("../src/telephone-agent.ts");
const { runLiveKitTelephoneSession } = await import(
  "../src/livekit-telephone-session.ts"
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("what an authenticated call leaves behind", () => {
  test("speech overlapping the non-interruptible confirmation receives one retry prompt after handoff", async () => {
    const liveSession = new LiveTelephoneSessionDouble();

    const call = await runAuthenticatedCall(
      "confirmation-overlap",
      {
        runTelephoneSession: async (options) =>
          runLiveKitTelephoneSession(
            { ...options, disconnected: Promise.resolve() },
            {
              createConversationSession: () => liveSession.asAgentSession(),
              createInterpreter: () => ({
                async close() {},
                async interpret() {
                  throw new Error(
                    "An untranscribed authentication overlap must not be interpreted",
                  );
                },
              }),
            },
          ),
      },
      async () => undefined,
      true,
    );

    expect(liveSession.spokenTexts).toStrictEqual([
      "Sorry, I did not catch that. Please say that again.",
    ]);
    expect(liveSession.allowInterruptions).toStrictEqual([true]);
    expect(call.fixedSpeechAllowInterruptions).not.toHaveLength(0);
    expect(call.fixedSpeechAllowInterruptions.every((value) => !value)).toBe(
      true,
    );
  });

  test("completion handoff finishes its protected opening before asking for the overlapped turn again", async () => {
    const liveSession = new LiveTelephoneSessionDouble();
    const openingText = "Your task concluded: The requested work is complete.";

    await runAuthenticatedCall(
      "completion-confirmation-overlap",
      {
        runTelephoneSession: async (options) =>
          runLiveKitTelephoneSession(
            {
              ...options,
              disconnected: Promise.resolve(),
              openingText,
            },
            {
              createConversationSession: () => liveSession.asAgentSession(),
              createInterpreter: () => ({
                async close() {},
                async interpret() {
                  throw new Error(
                    "An untranscribed completion overlap must not be interpreted",
                  );
                },
              }),
            },
          ),
      },
      async () => undefined,
      true,
    );

    expect(liveSession.spokenTexts).toStrictEqual([
      openingText,
      "Sorry, I did not catch that. Please say that again.",
    ]);
    expect(liveSession.allowInterruptions).toStrictEqual([false, true]);
  });

  test("the room the live session already ended is not deleted a second time", async () => {
    const call = await runAuthenticatedCall("single-teardown");

    // The live Telephone Session ends the call itself. A second delete reaches
    // LiveKit for a room that no longer exists, which is the 404 the caller
    // heard as a stuttered disconnect.
    expect(call.deleteRoom).toHaveBeenCalledTimes(1);
  });

  test("the authentication session the live session replaced is closed once", async () => {
    const call = await runAuthenticatedCall("single-close");

    expect(call.closes).toBe(1);
  });

  test("a delete the provider refused is tried again as the call unwinds", async () => {
    let refusals = 1;
    const call = await runAuthenticatedCall("refused-delete", {}, async () => {
      if (refusals-- > 0) throw new Error("the room could not be deleted");
    });

    // The first delete never happened, so the room is still this handler's to
    // delete: recording the intent instead of the deletion would leak it.
    expect(call.deleteRoom).toHaveBeenCalledTimes(2);
  });

  test("a live session that fails before ending the call leaves no room behind", async () => {
    const call = await runAuthenticatedCall("failed-handoff", {
      async runTelephoneSession() {
        throw new Error("the live Telephone Session never started");
      },
    });

    // Nothing ended this call, so the room is still this handler's to delete.
    expect(call.deleteRoom).toHaveBeenCalledTimes(1);
  });
});

/**
 * One outbound authentication call, driven to the point where it hands the
 * room to a live Telephone Session, with everything the handoff touches
 * counted.
 */
async function runAuthenticatedCall(
  suffix: string,
  overrides: Partial<CallbackHandshakeDependencies> = {},
  onDeleteRoom: () => Promise<void> = async () => undefined,
  overlapConfirmation = false,
): Promise<{
  readonly closes: number;
  readonly deleteRoom: ReturnType<typeof vi.fn>;
  readonly fixedSpeechAllowInterruptions: readonly boolean[];
}> {
  const directory = await mkdtemp(join(tmpdir(), `voice-agent-${suffix}-`));
  temporaryDirectories.push(directory);
  // Every store this call reads is built here and passed in, so the databases
  // stay one per test however the worker's own settings were resolved.
  const databasePath = join(directory, "voice-agent.sqlite");

  let identifier = 0;
  const nextId = (): string => `${suffix}-${(identifier += 1)}`;
  const now = (): string => "2026-08-26T21:35:00.000Z";
  const callbackStore = createSqliteCallbackHandshakeStore(databasePath);
  const runtime = createCallbackHandshakeRuntime({
    nextId,
    now,
    store: callbackStore,
  });
  const boundaries = createTelephoneBoundaryRuntime({
    evidence: { async append() {} },
    nextId,
    now,
    store: createSqliteTelephoneBoundaryStore(databasePath),
  });

  try {
    await runtime.registerTelephone({
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    });
    const inbound = await runtime.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: `${suffix}-inbound`,
      inboundTrunkId: "ST_inbound",
      providerCallId: `${suffix}-provider-call`,
    });
    const placement = inbound.actions.find(
      (action) => action.kind === "place-callback",
    );
    if (placement === undefined || inbound.handshakeId === undefined) {
      throw new Error("the inbound ring did not ask for a callback");
    }

    const room = new EventEmitter();
    const participant = {
      attributes: { "sip.callStatus": "active" },
      identity: placement.participantIdentity,
      sid: `${suffix}-participant-sid`,
    } as unknown as RemoteParticipant;
    const deleteRoom = vi.fn(onDeleteRoom);
    let closes = 0;
    const fixedSpeechAllowInterruptions: boolean[] = [];
    const session = fixedSpeechSessionDouble(
      () => {
        closes += 1;
      },
      overlapConfirmation,
      fixedSpeechAllowInterruptions,
    );
    const dependencies: CallbackHandshakeDependencies = {
      createMachineDetector: () => ({
        async close() {},
        detector: {} as voice.AMD,
        recognitionFailure: neverResolves(),
      }),
      createSpeechSession: () => session,
      detectMachine: async () => ({
        category: voice.AMDCategory.HUMAN,
        delayMs: 4,
        isMachine: false,
        rawResponse: "{}",
        reason: "a person answered",
        speechDurationMs: 240,
        transcript: "Hello?",
        type: "amd_prediction" as const,
      }),
      // Stands where the live Telephone Session stands, and ends the call the
      // one way that session ends it.
      runTelephoneSession: async (options) => {
        await options.endCall();
      },
      ...overrides,
    };

    // The DTMF listener is registered inside the call, so the digit is pressed
    // the moment authentication starts waiting for it.
    room.on("newListener", (event: string | symbol) => {
      if (event !== RoomEvent.DtmfReceived) return;
      setImmediate(() => {
        room.emit(RoomEvent.DtmfReceived, 1, "1", participant);
      });
    });

    await handleOutbound(
      {
        deleteRoom,
        room: room as unknown as Room,
        waitForParticipant: async () => participant,
      } as never,
      runtime,
      untouchedOnThisPath,
      untouchedOnThisPath,
      boundaries,
      undefined,
      {
        attempt: 1,
        effectId: `${suffix}-effect`,
        handshakeId: inbound.handshakeId,
        kind: "authentication",
        participantIdentity: placement.participantIdentity,
      },
      dependencies,
    );

    return { closes, deleteRoom, fixedSpeechAllowInterruptions };
  } finally {
    await boundaries.close();
    await runtime.close();
  }
}

/**
 * The Durable Task and continuity runtimes, which only a live Telephone Session
 * reaches. The session is a double here, so nothing in this call touches them.
 */
const untouchedOnThisPath = undefined as never;

/** A speech session that plays fixed text without a provider behind it. */
function fixedSpeechSessionDouble(
  onClose: () => void,
  overlapConfirmation = false,
  allowInterruptions: boolean[] = [],
): voice.AgentSession {
  const handlers = new Map<string, (event: never) => void>();
  const session = {
    async close() {
      onClose();
    },
    off(eventType: string, handler: (event: never) => void) {
      if (handlers.get(eventType) === handler) handlers.delete(eventType);
      return session;
    },
    on(eventType: string, handler: (event: never) => void) {
      handlers.set(eventType, handler);
      return session;
    },
    say: (
      _text: string,
      options?: { readonly allowInterruptions?: boolean },
    ) => ({
      async waitForPlayout() {
        allowInterruptions.push(options?.allowInterruptions ?? true);
        if (!overlapConfirmation) return;
        for (const createdAt of [1_777_238_119_000, 1_777_238_119_100]) {
          handlers.get(voice.AgentSessionEventTypes.UserStateChanged)?.({
            createdAt,
            newState: "speaking",
          } as never);
        }
      },
    }),
    async start() {},
  };
  return session as unknown as voice.AgentSession;
}

/** The conversational side of the handoff, with real worker event wiring. */
class LiveTelephoneSessionDouble {
  readonly allowInterruptions: boolean[] = [];
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
      output: {
        audio: {
          async captureFrame() {},
          flush() {},
          async waitForPlayout() {},
        },
      },
      say(
        text: string,
        options?: { readonly allowInterruptions?: boolean },
      ) {
        harness.spokenTexts.push(text);
        harness.allowInterruptions.push(options?.allowInterruptions ?? true);
        return {
          done: () => true,
          exception: () => undefined,
          interrupted: false,
          async waitForPlayout() {
            harness.#handlers.get(
              voice.AgentSessionEventTypes.AgentStateChanged,
            )?.({ newState: "speaking" } as never);
          },
        };
      },
      async start() {},
    } as unknown as voice.AgentSession;
  }
}

/** The detector's recognition fault, which this call never raises. */
function neverResolves(): Promise<never> {
  const pending = new Promise<never>(() => {});
  pending.catch(() => undefined);
  return pending;
}
