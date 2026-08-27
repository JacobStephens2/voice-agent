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

import type {
  handleOutbound as handleOutboundSignature,
  OutboundCallDependencies,
} from "../src/telephone-agent.ts";
import { wellFormedTelephoneWorkerEnvironment } from "./telephone-worker-environment.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("what an authenticated call leaves behind", () => {
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
  overrides: Partial<OutboundCallDependencies> = {},
): Promise<{
  readonly closes: number;
  readonly deleteRoom: ReturnType<typeof vi.fn>;
}> {
  const directory = await mkdtemp(join(tmpdir(), `voice-agent-${suffix}-`));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  for (const [name, value] of Object.entries(
    wellFormedTelephoneWorkerEnvironment,
  )) {
    process.env[name] = value;
  }
  process.env.VOICE_AGENT_DATABASE_PATH = databasePath;
  process.env.VOICE_AGENT_RAW_AUDIO_DEBUG_DIRECTORY = join(directory, "audio");
  // Resolved as the module loads, so the settings above must be in place first.
  const { handleOutbound } = (await import("../src/telephone-agent.ts")) as {
    handleOutbound: typeof handleOutboundSignature;
  };

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
    const deleteRoom = vi.fn(async () => undefined);
    let closes = 0;
    const session = fixedSpeechSessionDouble(() => {
      closes += 1;
    });
    const dependencies: OutboundCallDependencies = {
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
      undefined as never,
      undefined as never,
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

    return { closes, deleteRoom };
  } finally {
    await boundaries.close();
    await runtime.close();
  }
}

/** A speech session that plays fixed text without a provider behind it. */
function fixedSpeechSessionDouble(onClose: () => void): voice.AgentSession {
  return {
    async close() {
      onClose();
    },
    say: () => ({ async waitForPlayout() {} }),
    async start() {},
  } as unknown as voice.AgentSession;
}

/** The detector's recognition fault, which this call never raises. */
function neverResolves(): Promise<never> {
  const pending = new Promise<never>(() => {});
  pending.catch(() => undefined);
  return pending;
}
