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
import { createUnixSocketBountywellObserver } from "@voice-agent/operations-broker";
import {
  createCallbackHandshakeRuntime,
  createDurableTaskRuntime,
  createTaskContinuityRuntime,
} from "@voice-agent/runtime";
import {
  createSqliteCallbackHandshakeStore,
  createSqliteDurableTaskStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";

import {
  createProductionLiveKitCallbackAdapter,
  type LiveKitCallbackAdapter,
} from "./livekit-callback-adapter.ts";
import { runLiveKitTelephoneSession } from "./livekit-telephone-session.ts";
import { normalizeTelnyxSipTelephoneNumber } from "./livekit-sip-attributes.ts";

const agentName = "voice-agent-telephone";
const dtmfWindowMs = 15_000;
const completionResumptionParticipantWaitMs = 10_000;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const databasePath = requireEnvironment("VOICE_AGENT_DATABASE_PATH");
    const callbackStore = createSqliteCallbackHandshakeStore(databasePath);
    const runtime = createCallbackHandshakeRuntime({
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      store: callbackStore,
    });
    const taskStore = createSqliteDurableTaskStore(databasePath);
    const tasks = createDurableTaskRuntime({
      applicationRegistry: taskStore,
      deferTelephoneOperations: true,
      healthObserver: createUnixSocketBountywellObserver(
        requireEnvironment("VOICE_AGENT_BROKER_SOCKET_PATH"),
      ),
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      store: taskStore,
    });
    const continuity = createTaskContinuityRuntime({
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      store: createSqliteTaskContinuityStore(databasePath),
      tasks: taskStore,
    });
    const callbackAdapter = createProductionLiveKitCallbackAdapter({
      agentName,
      apiKey: requireEnvironment("LIVEKIT_API_KEY"),
      apiSecret: requireEnvironment("LIVEKIT_API_SECRET"),
      placementClaims: callbackStore,
      url: requireEnvironment("LIVEKIT_URL"),
    });
    try {
      const dispatch = parseOutboundDispatch(ctx.job.metadata);
      if (dispatch === undefined) {
        await handleInbound(ctx, runtime, callbackAdapter);
      } else if (dispatch.kind === "authentication") {
        await handleOutbound(ctx, runtime, tasks, continuity, dispatch);
      } else {
        if (dispatch.resumption) {
          await handleCompletionResumption(
            ctx,
            runtime,
            tasks,
            continuity,
            dispatch,
          );
        } else {
          await handleCompletionOutbound(
            ctx,
            runtime,
            tasks,
            continuity,
            dispatch,
          );
        }
      }
    } finally {
      await continuity.close();
      await tasks.close();
      await runtime.close();
    }
  },
});

type CallbackRuntime = ReturnType<typeof createCallbackHandshakeRuntime>;
type TaskRuntime = ReturnType<typeof createDurableTaskRuntime>;
type ContinuityRuntime = ReturnType<typeof createTaskContinuityRuntime>;

interface AuthenticationCallbackDispatch {
  readonly attempt: 1 | 2;
  readonly effectId: string;
  readonly handshakeId: string;
  readonly kind: "authentication";
  readonly participantIdentity: string;
}

interface CompletionCallbackDispatch {
  readonly effectId: string;
  readonly kind: "completion";
  readonly operationId: string;
  readonly participantIdentity: string;
  readonly resumption: boolean;
  readonly resumptionOperationId?: string;
  readonly taskId: string;
  readonly telephoneSessionId: string;
}

type OutboundDispatch =
  | AuthenticationCallbackDispatch
  | CompletionCallbackDispatch;

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
    calledNumber: normalizeTelnyxSipTelephoneNumber(
      attributes["sip.trunkPhoneNumber"],
    ),
    callerNumber: normalizeTelnyxSipTelephoneNumber(
      attributes["sip.phoneNumber"],
    ),
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
  tasks: TaskRuntime,
  continuity: ContinuityRuntime,
  dispatch: AuthenticationCallbackDispatch,
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
        const record = await runtime.readEvidenceRecord(dispatch.handshakeId);
        if (record?.session.outcome !== "authorized") {
          throw new Error("Telephone Session was not durably authorized");
        }
        await session.close();
        await detector.aclose();
        await runLiveKitTelephoneSession({
          disconnected: disconnected.promise,
          endCall: () => ctx.deleteRoom(),
          room: ctx.room,
          requestCompletionCallback: (input) =>
            requestCompletionCallback(runtime, continuity, input),
          sessionEvidence: {
            async append(event) {
              await runtime.appendTelephoneSessionEvidence(
                dispatch.handshakeId,
                event,
              );
            },
            async requestFailureNotification(input) {
              await runtime.requestTelephoneSessionFailureNotification(
                dispatch.handshakeId,
                input,
              );
            },
          },
          tasks,
          telephoneSessionId: record.session.id,
        });
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

async function handleCompletionOutbound(
  ctx: JobContext,
  callback: CallbackRuntime,
  tasks: TaskRuntime,
  continuity: ContinuityRuntime,
  dispatch: CompletionCallbackDispatch,
): Promise<void> {
  const session = createFixedSpeechSession();
  let detector: voice.AMD | undefined;
  let disconnected:
    | ReturnType<typeof waitForParticipantDisconnect>
    | undefined;
  let outcomeRecorded = false;
  let authenticated = false;
  let handedOffToRecovery = false;
  try {
    await session.start({
      agent: fixedSpeechAgent(),
      record: false,
      room: ctx.room,
    });
    const participant = await ctx.waitForParticipant(
      dispatch.participantIdentity,
    );
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
      await continuity.receiveCompletionCallbackEvent({
        deliveryId: `completion-ended:${dispatch.effectId}`,
        operationId: dispatch.operationId,
        outcome: "unanswered",
      });
      outcomeRecorded = true;
      return;
    }

    if (detection.prediction.category !== voice.AMDCategory.HUMAN) {
      const result = await continuity.receiveCompletionCallbackEvent({
        deliveryId: `completion-machine:${dispatch.effectId}`,
        operationId: dispatch.operationId,
        outcome:
          detection.prediction.category === voice.AMDCategory.UNCERTAIN
            ? "failed"
            : "voicemail",
      });
      outcomeRecorded = true;
      await performCompletionMediaActions(session, result);
      return;
    }

    await playFixedText(
      session,
      "A Voice Agent task has finished. Press 1 to authenticate and resume it.",
    );
    const digit = await waitForDtmfOrDisconnect(
      ctx.room,
      participant.identity,
      dtmfWindowMs,
    );
    if (digit !== "1") {
      await continuity.receiveCompletionCallbackEvent({
        authentication: {
          answer: "human",
          ...(digit === undefined ? {} : { digit }),
        },
        deliveryId: `completion-not-authorized:${dispatch.effectId}`,
        operationId: dispatch.operationId,
        outcome: "failed",
      });
      outcomeRecorded = true;
      return;
    }

    const result = await continuity.receiveCompletionCallbackEvent({
      authentication: { answer: "human", digit: "1" },
      deliveryId: `completion-authorized:${dispatch.effectId}`,
      operationId: dispatch.operationId,
      outcome: "authorized",
    });
    outcomeRecorded = true;
    authenticated = true;
    const resume = result.actions.find(
      (action) => action.kind === "resume-existing-task",
    );
    if (resume === undefined) return;
    if (
      !(await continuity.claimImmediateCompletionResumption({
        operationId: resume.effectId,
        taskId: resume.taskId,
      }))
    ) {
      handedOffToRecovery = true;
      return;
    }
    const record = await tasks.getEvidenceRecord(resume.taskId);
    if (record === undefined) {
      throw new Error("Resumed Durable Task is unavailable");
    }
    await playFixedText(
      session,
      "Telephone confirmed. Resuming your Voice Agent task.",
    );
    await session.close();
    await detector.aclose();
    await runLiveKitTelephoneSession({
      activeTaskId: resume.taskId,
      disconnected: disconnected.promise,
      endCall: () => ctx.deleteRoom(),
      openingText: `Your task concluded: ${record.task.conclusion}`,
      onStarted: () =>
        continuity.recordCompletionResumption({
          operationId: resume.effectId,
        }),
      requestCompletionCallback: (input) =>
        requestCompletionCallback(callback, continuity, input),
      room: ctx.room,
      sessionEvidence: {
        ...completionSessionEvidence(
          tasks,
          continuity,
          dispatch.operationId,
          resume.taskId,
        ),
      },
      tasks,
      telephoneSessionId: resume.telephoneSessionId,
    });
  } catch {
    if (authenticated) {
      await continuity
        .requestSessionFailureNotification({
          callbackOperationId: dispatch.operationId,
          failureEventId: `completion-resume-failed:${dispatch.effectId}`,
          occurredAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    } else if (!outcomeRecorded) {
      await continuity
        .receiveCompletionCallbackEvent({
          deliveryId: `completion-failed:${dispatch.effectId}`,
          operationId: dispatch.operationId,
          outcome: "failed",
        })
        .catch(() => undefined);
    }
  } finally {
    disconnected?.cancel();
    await detector?.aclose().catch(() => undefined);
    await session.close().catch(() => undefined);
    if (!handedOffToRecovery) {
      await ctx.deleteRoom().catch(() => undefined);
    }
  }
}

async function handleCompletionResumption(
  ctx: JobContext,
  callback: CallbackRuntime,
  tasks: TaskRuntime,
  continuity: ContinuityRuntime,
  dispatch: CompletionCallbackDispatch,
): Promise<void> {
  let disconnected:
    | ReturnType<typeof waitForParticipantDisconnect>
    | undefined;
  try {
    await ctx.connect();
    const participant = await waitForParticipantOrTimeout(
      ctx,
      dispatch.participantIdentity,
    );
    disconnected = waitForParticipantDisconnect(ctx.room, participant.identity);
    const record = await tasks.getEvidenceRecord(dispatch.taskId);
    if (record === undefined) {
      throw new Error("Resumed Durable Task is unavailable");
    }
    await runLiveKitTelephoneSession({
      activeTaskId: dispatch.taskId,
      disconnected: disconnected.promise,
      endCall: () => ctx.deleteRoom(),
      openingText: `Your task concluded: ${record.task.conclusion}`,
      onStarted: () =>
        continuity.recordCompletionResumption({
          operationId: requireResumptionOperationId(dispatch),
        }),
      requestCompletionCallback: (input) =>
        requestCompletionCallback(callback, continuity, input),
      room: ctx.room,
      sessionEvidence: completionSessionEvidence(
        tasks,
        continuity,
        dispatch.operationId,
        dispatch.taskId,
      ),
      tasks,
      telephoneSessionId: dispatch.telephoneSessionId,
    });
  } catch {
    await continuity
      .requestSessionFailureNotification({
        callbackOperationId: dispatch.operationId,
        failureEventId: `${dispatch.operationId}:resumption-failed`,
        occurredAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  } finally {
    disconnected?.cancel();
    await ctx.deleteRoom().catch(() => undefined);
  }
}

function completionSessionEvidence(
  tasks: TaskRuntime,
  continuity: ContinuityRuntime,
  callbackOperationId: string,
  taskId: string,
) {
  return {
    async append(event: Parameters<TaskRuntime["appendTelephoneEvidence"]>[0]["event"]) {
      await tasks.appendTelephoneEvidence({ event, taskId });
    },
    async requestFailureNotification(input: {
      readonly failureEventId: string;
      readonly occurredAt: string;
    }) {
      await continuity.requestSessionFailureNotification({
        callbackOperationId,
        failureEventId: input.failureEventId,
        occurredAt: input.occurredAt,
      });
    },
  };
}

function requireResumptionOperationId(
  dispatch: CompletionCallbackDispatch,
): string {
  if (dispatch.resumptionOperationId === undefined) {
    throw new Error("Completion resumption Operation is unavailable");
  }
  return dispatch.resumptionOperationId;
}

async function requestCompletionCallback(
  callback: CallbackRuntime,
  continuity: ContinuityRuntime,
  input: {
    readonly requestId: string;
    readonly taskId: string;
    readonly telephoneSessionId: string;
  },
): Promise<{ readonly text: string }> {
  const telephone = await callback.findRegisteredTelephone();
  if (telephone === undefined) {
    throw new Error("Registered Telephone is unavailable");
  }
  return continuity.requestCompletionCallback({ ...input, telephone });
}

async function performCompletionMediaActions(
  session: voice.AgentSession,
  result: Awaited<
    ReturnType<ContinuityRuntime["receiveCompletionCallbackEvent"]>
  >,
): Promise<void> {
  for (const action of result.actions) {
    if (action.kind === "play-completion-voicemail-and-end") {
      await playFixedText(session, action.text);
    }
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

async function waitForParticipantOrTimeout(
  ctx: JobContext,
  participantIdentity: string,
): Promise<RemoteParticipant> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ctx.waitForParticipant(participantIdentity),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Completion Callback participant is unavailable")),
          completionResumptionParticipantWaitMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
    if (value.kind === "outbound-callback") {
      if (
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
        kind: "authentication",
        participantIdentity: value.participantIdentity,
      };
    }
    if (
      (value.kind === "completion-callback" ||
        value.kind === "completion-resumption") &&
      typeof value.effectId === "string" &&
      typeof value.operationId === "string" &&
      typeof value.participantIdentity === "string" &&
      typeof value.taskId === "string" &&
      typeof value.telephoneSessionId === "string"
    ) {
      return {
        effectId: value.effectId,
        kind: "completion",
        operationId: value.operationId,
        participantIdentity: value.participantIdentity,
        resumption: value.kind === "completion-resumption",
        ...(typeof value.resumptionOperationId === "string"
          ? { resumptionOperationId: value.resumptionOperationId }
          : {}),
        taskId: value.taskId,
        telephoneSessionId: value.telephoneSessionId,
      };
    }
    return undefined;
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
