import {
  defineAgent,
  inference,
  type JobContext,
  voice,
} from "@livekit/agents";
import {
  RoomEvent,
  type RemoteParticipant,
  type Room,
} from "@livekit/rtc-node";
import { createHash, randomUUID } from "node:crypto";

import type {
  CallbackAction,
  CallbackActionResult,
  CallbackProviderEvent,
} from "@voice-agent/contracts";
import { createCallbackHandshakeRuntime } from "@voice-agent/runtime";
import { createSqliteCallbackHandshakeStore } from "@voice-agent/sqlite-store";

import {
  createProductionLiveKitCallbackAdapter,
  type LiveKitCallbackAdapter,
} from "./livekit-callback-adapter.ts";

const agentName = "voice-agent-telephone";
const dtmfWindowMs = 15_000;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const databasePath = requireEnvironment("VOICE_AGENT_DATABASE_PATH");
    const runtime = createCallbackHandshakeRuntime({
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      store: createSqliteCallbackHandshakeStore(databasePath),
    });
    const callbackAdapter = createProductionLiveKitCallbackAdapter({
      agentName,
      apiKey: requireEnvironment("LIVEKIT_API_KEY"),
      apiSecret: requireEnvironment("LIVEKIT_API_SECRET"),
      url: requireEnvironment("LIVEKIT_URL"),
    });
    try {
      const dispatch = parseOutboundDispatch(ctx.job.metadata);
      if (dispatch === undefined) {
        await handleInbound(ctx, runtime, callbackAdapter);
      } else {
        await handleOutbound(ctx, runtime, dispatch);
      }
    } finally {
      await runtime.close();
    }
  },
});

type CallbackRuntime = ReturnType<typeof createCallbackHandshakeRuntime>;

interface OutboundDispatch {
  readonly attempt: 1 | 2;
  readonly effectId: string;
  readonly handshakeId: string;
  readonly participantIdentity: string;
}

async function handleInbound(
  ctx: JobContext,
  runtime: CallbackRuntime,
  callbackAdapter: LiveKitCallbackAdapter,
): Promise<void> {
  await ctx.connect();
  const participant = await ctx.waitForParticipant();
  const attributes = participant.attributes;
  const inboundCallId = providerCallId(participant);
  const inbound = await runtime.receiveInbound({
    calledNumber: attributes["sip.trunkPhoneNumber"] ?? "malformed",
    callerNumber: attributes["sip.phoneNumber"] ?? "malformed",
    deliveryId: `inbound:${providerDeliveryFingerprint(inboundCallId)}`,
    inboundTrunkId: attributes["sip.trunkID"] ?? "malformed",
    providerCallId: inboundCallId,
  });
  if (inbound.disposition === "reject") {
    await ctx.deleteRoom();
    return;
  }

  const session = createFixedSpeechSession();
  try {
    await session.start({
      agent: fixedSpeechAgent(),
      record: false,
      room: ctx.room,
    });
    const notice = inbound.actions.find(
      (action) => action.kind === "play-inbound-notice-and-end",
    );
    if (notice !== undefined) {
      await playFixedText(session, notice.text);
    }
  } catch {
    await runtime.receiveProviderEvent(inbound.handshakeId!, {
      attempt: 1,
      deliveryId: `provider-failure:${inbound.handshakeId}:inbound-notice`,
      kind: "ended",
      outcome: "failed",
      providerCallId: inboundCallId,
    });
    return;
  } finally {
    await session.close().catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
  }

  for (const action of inbound.actions) {
    if (action.kind !== "place-callback") continue;
    await placeCallbackOrRecordFailure(runtime, callbackAdapter, action);
  }
}

async function handleOutbound(
  ctx: JobContext,
  runtime: CallbackRuntime,
  dispatch: OutboundDispatch,
): Promise<void> {
  const session = createFixedSpeechSession();
  let callId = dispatch.effectId;
  let detector: voice.AMD | undefined;
  let disconnected:
    | ReturnType<typeof waitForParticipantDisconnect>
    | undefined;
  try {
    await session.start({
      agent: fixedSpeechAgent(),
      record: false,
      room: ctx.room,
    });
    const participant = await ctx.waitForParticipant(
      dispatch.participantIdentity,
    );
    callId = providerCallId(participant);
    detector = new voice.AMD(session, {
      interruptOnMachine: true,
      llm: "openai/gpt-5.4",
      participantIdentity: dispatch.participantIdentity,
      stt: "assemblyai/universal-streaming-multilingual",
      waitUntilFinished: true,
    });
    disconnected = waitForParticipantDisconnect(
      ctx.room,
      participant.identity,
    );
    const detection = await Promise.race([
      detector.execute().then((prediction) => ({
        kind: "prediction" as const,
        prediction,
      })),
      disconnected.promise.then(() => ({ kind: "disconnected" as const })),
    ]);
    if (detection.kind === "disconnected") {
      const actionResult = await runtime.receiveProviderEvent(
        dispatch.handshakeId,
        {
          attempt: dispatch.attempt,
          deliveryId: `ended:${dispatch.effectId}`,
          kind: "ended",
          outcome:
            participant.attributes["sip.callStatus"] === "active"
              ? "hangup"
              : "unanswered",
          providerCallId: callId,
        },
      );
      await performMediaActions(session, actionResult);
      return;
    }

    const machineResult = await runtime.receiveProviderEvent(
      dispatch.handshakeId,
      {
        attempt: dispatch.attempt,
        classification: mapMachineClassification(detection.prediction.category),
        deliveryId: `machine:${dispatch.effectId}`,
        kind: "machine-detection",
        providerCallId: callId,
      },
    );
    await performMediaActions(session, machineResult);
    if (
      !machineResult.actions.some((action) => action.kind === "prompt-for-dtmf")
    ) {
      return;
    }

    const deadline = Date.now() + dtmfWindowMs;
    let dtmfSequence = 0;
    while (Date.now() < deadline) {
      const received = await waitForDtmfOrDisconnect(
        ctx.room,
        participant.identity,
        deadline - Date.now(),
      );
      if (received === undefined) break;
      dtmfSequence += 1;
      const dtmfResult = await runtime.receiveProviderEvent(
        dispatch.handshakeId,
        {
          attempt: dispatch.attempt,
          deliveryId: `dtmf:${dispatch.effectId}:${dtmfSequence}`,
          digit: received,
          kind: "dtmf",
          providerCallId: callId,
        },
      );
      await performMediaActions(session, dtmfResult);
      if (
        dtmfResult.actions.some(
          (action) => action.kind === "play-confirmation",
        )
      ) {
        return;
      }
    }

    const ended = await runtime.receiveProviderEvent(dispatch.handshakeId, {
      attempt: dispatch.attempt,
      deliveryId: `confirmation-timeout:${dispatch.effectId}`,
      kind: "ended",
      outcome: "hangup",
      providerCallId: callId,
    });
    await performMediaActions(session, ended);
  } catch {
    await runtime.receiveProviderEvent(dispatch.handshakeId, {
      attempt: dispatch.attempt,
      deliveryId: `provider-failure:${dispatch.effectId}`,
      kind: "ended",
      outcome: "failed",
      providerCallId: callId,
    });
  } finally {
    disconnected?.cancel();
    await detector?.aclose().catch(() => undefined);
    await session.close().catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
  }
}

function createFixedSpeechSession(): voice.AgentSession {
  return new voice.AgentSession({
    tts: new inference.TTS({
      language: "en",
      model: "inworld/inworld-tts-2",
      voice: process.env.VOICE_AGENT_TTS_VOICE ?? "Sarah",
    }),
  });
}

function fixedSpeechAgent(): voice.Agent {
  return new voice.Agent({
    instructions:
      "This authentication worker only plays fixed application text. It does not accept spoken commands or generate replies.",
  });
}

async function performMediaActions(
  session: voice.AgentSession,
  result: CallbackActionResult,
): Promise<void> {
  for (const action of result.actions) {
    if (
      action.kind !== "prompt-for-dtmf" &&
      action.kind !== "play-confirmation"
    ) {
      continue;
    }
    await playFixedText(session, action.text);
  }
}

async function playFixedText(
  session: voice.AgentSession,
  text: string,
): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await session
        .say(text, { addToChatCtx: false, allowInterruptions: false })
        .waitForPlayout();
      return;
    } catch (error) {
      lastFailure = error;
    }
  }
  throw lastFailure;
}

async function placeCallbackOrRecordFailure(
  runtime: CallbackRuntime,
  adapter: LiveKitCallbackAdapter,
  action: Extract<CallbackAction, { kind: "place-callback" }>,
): Promise<void> {
  try {
    await adapter.placeCallback(action);
  } catch {
    await runtime.receiveProviderEvent(
      requireHandshakeId(action.roomName),
      {
        attempt: action.attempt,
        deliveryId: `placement-failed:${action.effectId}`,
        kind: "ended",
        outcome: "unanswered",
        providerCallId: action.effectId,
      },
    );
  }
}

function waitForDtmfOrDisconnect(
  room: Room,
  participantIdentity: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
    const onDtmf = (
      _code: number,
      digit: string,
      participant: RemoteParticipant,
    ) => {
      if (participant.identity === participantIdentity) finish(digit);
    };
    const onDisconnect = (participant: RemoteParticipant) => {
      if (participant.identity === participantIdentity) finish(undefined);
    };
    function finish(value: string | undefined) {
      clearTimeout(timeout);
      room.off(RoomEvent.DtmfReceived, onDtmf);
      room.off(RoomEvent.ParticipantDisconnected, onDisconnect);
      resolve(value);
    }
    room.on(RoomEvent.DtmfReceived, onDtmf);
    room.on(RoomEvent.ParticipantDisconnected, onDisconnect);
  });
}

function waitForParticipantDisconnect(
  room: Room,
  participantIdentity: string,
): { readonly cancel: () => void; readonly promise: Promise<void> } {
  let cancel: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    const handler = (participant: RemoteParticipant) => {
      if (participant.identity !== participantIdentity) return;
      room.off(RoomEvent.ParticipantDisconnected, handler);
      resolve();
    };
    cancel = () => {
      room.off(RoomEvent.ParticipantDisconnected, handler);
    };
    room.on(RoomEvent.ParticipantDisconnected, handler);
  });
  return { cancel, promise };
}

function providerCallId(participant: RemoteParticipant): string {
  return (
    participant.attributes["sip.callIDFull"] ??
    participant.attributes["sip.callID"] ??
    participant.sid ??
    participant.identity
  );
}

function providerDeliveryFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapMachineClassification(
  category: voice.AMDCategory,
): Extract<CallbackProviderEvent, { kind: "machine-detection" }>["classification"] {
  if (category === voice.AMDCategory.HUMAN) return "human";
  if (category === voice.AMDCategory.UNCERTAIN) return "unknown";
  return "machine";
}

function parseOutboundDispatch(metadata: string): OutboundDispatch | undefined {
  if (metadata.length === 0) return undefined;
  try {
    const value = JSON.parse(metadata) as Record<string, unknown>;
    if (
      value.kind !== "outbound-callback" ||
      (value.attempt !== 1 && value.attempt !== 2) ||
      typeof value.effectId !== "string" ||
      typeof value.handshakeId !== "string" ||
      typeof value.participantIdentity !== "string"
    ) {
      return undefined;
    }
    return {
      attempt: value.attempt,
      effectId: value.effectId,
      handshakeId: value.handshakeId,
      participantIdentity: value.participantIdentity,
    };
  } catch {
    return undefined;
  }
}

function requireHandshakeId(roomName: string): string {
  const prefix = "callback-handshake-";
  if (!roomName.startsWith(prefix) || roomName.length === prefix.length) {
    throw new Error("Callback room is missing its durable handshake identity");
  }
  return roomName.slice(prefix.length);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
