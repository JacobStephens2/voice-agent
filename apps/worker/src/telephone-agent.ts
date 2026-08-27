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
  RecognizedSpeechModel,
  TelephoneEvidenceEvent,
} from "@voice-agent/contracts";
import {
  createUnixSocketBountywellController,
  createUnixSocketBountywellObserver,
} from "@voice-agent/operations-broker";

import { createBountywellCompletionReports } from "./bountywell-completion-report.ts";
import {
  createCallbackHandshakeRuntime,
  createDurableTaskRuntime,
  createKeeploreDelegationRuntime,
  createNodeRawAudioArtifactRemover,
  createTaskContinuityRuntime,
  createTelephoneBoundaryRuntime,
  createUnixSocketKeeploreSubagentRunner,
} from "@voice-agent/runtime";
import {
  createSqliteCallbackHandshakeStore,
  createSqliteDurableTaskStore,
  createSqliteKeeploreDelegationStore,
  createSqliteKeeploreOnboardingStore,
  createSqliteTaskContinuityStore,
  createSqliteTelephoneBoundaryStore,
} from "@voice-agent/sqlite-store";

import {
  createProductionLiveKitCallbackAdapter,
  type LiveKitCallbackAdapter,
} from "./livekit-callback-adapter.ts";
import {
  boundedProviderConnectOptions,
  playPrerecordedProviderFailure,
  runLiveKitTelephoneSession,
} from "./livekit-telephone-session.ts";
import { normalizeTelnyxSipTelephoneNumber } from "./livekit-sip-attributes.ts";
import {
  reportTelephoneSpendingWarning,
  reserveTelephoneUsageSlice,
  telephoneUsageRatesFromEnvironment,
} from "./telephone-usage-meter.ts";
import {
  createBoundedMachineDetector,
  executeMachineDetection,
  type BoundedMachineDetector,
} from "./telephone-machine-detection.ts";
import {
  recordTelephoneSetupProviderFailure,
  TelephoneSetupProviderError,
} from "./telephone-setup-provider-failure.ts";
import { resolveTelephoneWorkerSettings } from "./telephone-worker-settings.ts";

// Resolved as this process starts, so a setting this worker cannot accept ends
// it before any job is accepted rather than failing one caller at a time.
const settings = resolveTelephoneWorkerSettings();
const agentName = "voice-agent-telephone";
const dtmfWindowMs = 15_000;
const completionResumptionParticipantWaitMs = 10_000;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const databasePath = settings.databasePath;
    const callbackStore = createSqliteCallbackHandshakeStore(databasePath);
    const runtime = createCallbackHandshakeRuntime({
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      store: callbackStore,
    });
    const boundaries = createTelephoneBoundaryRuntime({
      evidence: {
        async append(telephoneSessionId, event) {
          await runtime.appendTelephoneSessionEvidenceBySessionId(
            telephoneSessionId,
            event,
          );
        },
      },
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      prolongedSilenceMs: settings.prolongedSilenceMs,
      rawAudioArtifacts: createNodeRawAudioArtifactRemover(),
      rawAudioDebugDirectory: settings.rawAudioDebugDirectory,
      store: createSqliteTelephoneBoundaryStore(databasePath),
    });
    const taskStore = createSqliteDurableTaskStore(databasePath);
    const continuity = createTaskContinuityRuntime({
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      store: createSqliteTaskContinuityStore(databasePath),
      tasks: taskStore,
    });
    const tasks = createDurableTaskRuntime({
      applicationRegistry: taskStore,
      completionReports: createBountywellCompletionReports({
        callbacks: runtime,
        continuity,
      }),
      deferTelephoneOperations: true,
      healthObserver: createUnixSocketBountywellObserver(
        settings.brokerSocketPath,
      ),
      nextId: randomUUID,
      now: () => new Date().toISOString(),
      // A confirmed drill recovery restarts the registered unit from inside the
      // Telephone Session, so this process needs the same service control.
      serviceController: createUnixSocketBountywellController(
        settings.brokerSocketPath,
      ),
      store: taskStore,
    });
    const keeploreOnboardingStore = createSqliteKeeploreOnboardingStore(
      databasePath,
    );
    const keeploreRegistration = await keeploreOnboardingStore.findRegistration();
    const keeplore = settings.keeplore;
    const keeploreDelegationStore =
      keeploreRegistration === undefined || keeplore === undefined
        ? undefined
        : createSqliteKeeploreDelegationStore(databasePath);
    const keeploreDelegations =
      keeploreRegistration === undefined ||
      keeploreDelegationStore === undefined ||
      keeplore === undefined
        ? undefined
        : createKeeploreDelegationRuntime({
            nextId: randomUUID,
            now: () => new Date().toISOString(),
            registration: keeploreRegistration,
            runner: createUnixSocketKeeploreSubagentRunner(
              keeplore.subagentSocketPath,
            ),
            sourceCommit: keeplore.sourceCommit,
            store: keeploreDelegationStore,
          });
    const callbackAdapter = createProductionLiveKitCallbackAdapter({
      agentName,
      apiKey: settings.liveKitApiKey,
      apiSecret: settings.liveKitApiSecret,
      placementClaims: callbackStore,
      url: settings.liveKitUrl,
    });
    try {
      const dispatch = parseOutboundDispatch(ctx.job.metadata);
      if (dispatch === undefined) {
        await handleInbound(
          ctx,
          runtime,
          boundaries,
          callbackAdapter,
        );
      } else if (dispatch.kind === "authentication") {
        await handleOutbound(
          ctx,
          runtime,
          tasks,
          continuity,
          boundaries,
          keeploreDelegations,
          dispatch,
        );
      } else {
        if (dispatch.resumption) {
          await handleCompletionResumption(
            ctx,
            runtime,
            tasks,
            continuity,
            boundaries,
            keeploreDelegations,
            dispatch,
          );
        } else {
          await handleCompletionOutbound(
            ctx,
            runtime,
            tasks,
            continuity,
            boundaries,
            keeploreDelegations,
            dispatch,
          );
        }
      }
    } finally {
      await boundaries.cleanupExpiredRawAudio();
      await boundaries.close();
      await continuity.close();
      await tasks.close();
      keeploreDelegationStore?.close();
      keeploreOnboardingStore.close();
      await runtime.close();
    }
  },
});

type CallbackRuntime = ReturnType<typeof createCallbackHandshakeRuntime>;
type TaskRuntime = ReturnType<typeof createDurableTaskRuntime>;
type ContinuityRuntime = ReturnType<typeof createTaskContinuityRuntime>;
type BoundaryRuntime = ReturnType<typeof createTelephoneBoundaryRuntime>;
type KeeploreRuntime = ReturnType<typeof createKeeploreDelegationRuntime>;

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

interface WarmSessionLease {
  release(): Promise<void>;
}

async function acquireWarmSessionLease(options: {
  readonly boundaries: BoundaryRuntime;
  readonly onRejected: (
    decision: Awaited<ReturnType<BoundaryRuntime["reserveWarmSession"]>>,
  ) => Promise<void>;
  readonly telephoneSessionId: string;
}): Promise<WarmSessionLease | undefined> {
  const decision = await options.boundaries.reserveWarmSession(
    options.telephoneSessionId,
  );
  if (decision.decision !== "accepted") {
    await options.onRejected(decision);
    return undefined;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await options.boundaries.releaseWarmSession(options.telephoneSessionId);
    },
  };
}

async function handleInbound(
  ctx: JobContext,
  runtime: CallbackRuntime,
  boundaries: BoundaryRuntime,
  callbackAdapter: LiveKitCallbackAdapter,
): Promise<void> {
  await ctx.connect();
  const participant = await ctx.waitForParticipant();
  const attributes = participant.attributes;
  const inboundCallId = providerCallId(participant);
  if (
    (await reserveTelephoneUsageSlice({
      onSpendingWarning: reportTelephoneSpendingWarning,
      ratesMicrousdPerMinute: telephoneUsageRatesFromEnvironment(),
      reserveUsageSlice: boundaries.reserveUsageSlice,
      usageScopeId: `prelive:inbound:${providerDeliveryFingerprint(inboundCallId)}`,
    })).disposition === "safe-terminal-only"
  ) {
    await ctx.deleteRoom().catch(() => undefined);
    return;
  }
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
  const record = await runtime.readEvidenceRecord(inbound.handshakeId!);
  if (record === undefined) {
    throw new Error("Inbound Callback Handshake Evidence Record is unavailable");
  }
  const session = createFixedSpeechSession();
  try {
    await startFixedSpeechSession(session, ctx.room);
    const notice = inbound.actions.find(
      (action) => action.kind === "play-inbound-notice-and-end",
    );
    if (notice !== undefined) {
      await playFixedText(session, notice.text);
    }
  } catch (error) {
    await playPrerecordedProviderFailure(session).catch(() => undefined);
    const failed = await runtime.receiveProviderEvent(inbound.handshakeId!, {
      attempt: 1,
      deliveryId: `provider-failure:${inbound.handshakeId}:inbound-notice`,
      kind: "ended",
      outcome: "failed",
      providerCallId: inboundCallId,
    });
    await recordAuthenticationSetupProviderFailure({
      boundaries,
      failureEventId: `provider-failure:${inbound.handshakeId}:inbound-notice`,
      handshakeId: inbound.handshakeId!,
      occurredAt: new Date().toISOString(),
      error,
      result: failed,
      runtime,
      telephoneSessionId: record.session.id,
    });
    return;
  } finally {
    await session.close().catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
  }

  for (const action of inbound.actions) {
    if (action.kind !== "place-callback") continue;
    await placeCallbackOrRecordFailure(
      runtime,
      boundaries,
      callbackAdapter,
      action,
    );
  }
}

/**
 * The collaborators an outbound authentication call is driven through.
 *
 * Authentication reaches its live conversation by handing the room to
 * `runTelephoneSession`, and what that handoff leaves behind is only visible
 * from above it. Naming these gives a test that seam without a speech
 * provider, a transcriber, or a real room.
 */
export interface OutboundCallDependencies {
  createMachineDetector(
    session: voice.AgentSession,
    participantIdentity: string,
    recognitionModel: RecognizedSpeechModel,
  ): BoundedMachineDetector;
  createSpeechSession(): voice.AgentSession;
  detectMachine(
    detector: BoundedMachineDetector,
  ): ReturnType<voice.AMD["execute"]>;
  runTelephoneSession: typeof runLiveKitTelephoneSession;
}

const productionOutboundCall: OutboundCallDependencies = {
  createMachineDetector: createBoundedMachineDetector,
  createSpeechSession: createFixedSpeechSession,
  detectMachine: executeMachineDetection,
  runTelephoneSession: runLiveKitTelephoneSession,
};

export async function handleOutbound(
  ctx: JobContext,
  runtime: CallbackRuntime,
  tasks: TaskRuntime,
  continuity: ContinuityRuntime,
  boundaries: BoundaryRuntime,
  keeploreDelegations: KeeploreRuntime | undefined,
  dispatch: AuthenticationCallbackDispatch,
  dependencies: OutboundCallDependencies = productionOutboundCall,
): Promise<void> {
  const pendingRecord = await runtime.readEvidenceRecord(dispatch.handshakeId);
  if (pendingRecord === undefined) {
    throw new Error("Callback Handshake Evidence Record is unavailable");
  }
  const telephoneSessionId = pendingRecord.session.id;
  const warmSession = await acquireWarmSessionLease({
    boundaries,
    onRejected: async (decision) => {
      await runtime.requestTelephoneSessionFailureNotification(
        dispatch.handshakeId,
        {
          failureEventId: `limit:${dispatch.effectId}:${boundaryDenialReason(decision)}`,
          occurredAt: new Date().toISOString(),
        },
      );
      await ctx.deleteRoom().catch(() => undefined);
    },
    telephoneSessionId,
  });
  if (warmSession === undefined) return;
  const session = dependencies.createSpeechSession();
  let callId = dispatch.effectId;
  let detector: BoundedMachineDetector | undefined;
  let disconnected:
    | ReturnType<typeof waitForParticipantDisconnect>
    | undefined;
  let handedOffToLiveSession = false;
  let liveSessionEndedCall = false;
  try {
    await startFixedSpeechSession(session, ctx.room);
    const participant = await ctx.waitForParticipant(
      dispatch.participantIdentity,
    );
    callId = providerCallId(participant);
    detector = dependencies.createMachineDetector(
      session,
      dispatch.participantIdentity,
      settings.recognitionModel,
    );
    disconnected = waitForParticipantDisconnect(
      ctx.room,
      participant.identity,
    );
    const detection = await Promise.race([
      dependencies.detectMachine(detector).then((prediction) => ({
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
        const admission = await boundaries.activateSession(telephoneSessionId);
        if (admission.decision !== "accepted") {
          await runtime.requestTelephoneSessionFailureNotification(
            dispatch.handshakeId,
            {
              failureEventId: `limit:${dispatch.effectId}:${boundaryDenialReason(admission)}`,
              occurredAt: new Date().toISOString(),
            },
          );
          await playPrerecordedProviderFailure(session);
          return;
        }
        await session.close();
        await detector.close();
        handedOffToLiveSession = true;
        await dependencies.runTelephoneSession({
          boundaries,
          disconnected: disconnected.promise,
          endCall: async () => {
            liveSessionEndedCall = true;
            await ctx.deleteRoom();
          },
          initialUsageScopeId: `prelive:${dispatch.effectId}`,
          recognitionModel: settings.recognitionModel,
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
          ...(keeploreDelegations === undefined
            ? {}
            : { keeploreDelegations }),
          tasks,
          telephoneSessionId: record.session.id,
          prolongedSilenceMs: settings.prolongedSilenceMs,
          usageRatesMicrousdPerMinute: telephoneUsageRatesFromEnvironment(),
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
  } catch (error) {
    await playPrerecordedProviderFailure(session).catch(() => undefined);
    const failed = await runtime.receiveProviderEvent(dispatch.handshakeId, {
      attempt: dispatch.attempt,
      deliveryId: `provider-failure:${dispatch.effectId}`,
      kind: "ended",
      outcome: "failed",
      providerCallId: callId,
    });
    await recordAuthenticationSetupProviderFailure({
      boundaries,
      failureEventId: `provider-failure:${dispatch.effectId}`,
      handshakeId: dispatch.handshakeId,
      occurredAt: new Date().toISOString(),
      error,
      result: failed,
      runtime,
      telephoneSessionId,
    });
  } finally {
    await warmSession.release();
    disconnected?.cancel();
    // Authentication closes its own session and detector as it hands the room
    // over, so closing them here again would be the second close of one
    // session. The room is a separate fact: it is deleted here unless the live
    // Telephone Session already deleted it, because deleting a room that is
    // already gone reaches a caller whose call is ending as a second terminal
    // response over the first.
    if (!handedOffToLiveSession) {
      await detector?.close();
      await session.close().catch(() => undefined);
    }
    if (!liveSessionEndedCall) {
      await ctx.deleteRoom().catch(() => undefined);
    }
  }
}

async function handleCompletionOutbound(
  ctx: JobContext,
  callback: CallbackRuntime,
  tasks: TaskRuntime,
  continuity: ContinuityRuntime,
  boundaries: BoundaryRuntime,
  keeploreDelegations: KeeploreRuntime | undefined,
  dispatch: CompletionCallbackDispatch,
): Promise<void> {
  const warmSession = await acquireWarmSessionLease({
    boundaries,
    onRejected: async (decision) => {
      await continuity
        .requestSessionFailureNotification({
          callbackOperationId: dispatch.operationId,
          failureEventId: `limit:${dispatch.effectId}:${boundaryDenialReason(decision)}`,
          occurredAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      await ctx.deleteRoom().catch(() => undefined);
    },
    telephoneSessionId: dispatch.telephoneSessionId,
  });
  if (warmSession === undefined) return;
  const session = createFixedSpeechSession();
  let detector: BoundedMachineDetector | undefined;
  let disconnected:
    | ReturnType<typeof waitForParticipantDisconnect>
    | undefined;
  let outcomeRecorded = false;
  let authenticated = false;
  let handedOffToLiveSession = false;
  let liveSessionEndedCall = false;
  let handedOffToRecovery = false;
  try {
    await startFixedSpeechSession(session, ctx.room);
    const participant = await ctx.waitForParticipant(
      dispatch.participantIdentity,
    );
    detector = createBoundedMachineDetector(
      session,
      dispatch.participantIdentity,
      settings.recognitionModel,
    );
    disconnected = waitForParticipantDisconnect(
      ctx.room,
      participant.identity,
    );
    const detection = await Promise.race([
      executeMachineDetection(detector).then((prediction) => ({
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
    const admission = await boundaries.activateSession(
      resume.telephoneSessionId,
    );
    if (admission.decision !== "accepted") {
      await continuity.requestSessionFailureNotification({
        callbackOperationId: dispatch.operationId,
        failureEventId: `limit:${dispatch.effectId}:${boundaryDenialReason(admission)}`,
        occurredAt: new Date().toISOString(),
      });
      await playPrerecordedProviderFailure(session);
      return;
    }
    await session.close();
    await detector.close();
    handedOffToLiveSession = true;
    await runLiveKitTelephoneSession({
      activeTaskId: resume.taskId,
      boundaries,
      disconnected: disconnected.promise,
      endCall: async () => {
        liveSessionEndedCall = true;
        await ctx.deleteRoom();
      },
      initialUsageScopeId: `prelive:${dispatch.operationId}`,
      openingText: `Your task concluded: ${record.task.conclusion}`,
      onStarted: () =>
        continuity.recordCompletionResumption({
          operationId: resume.effectId,
        }),
      recognitionModel: settings.recognitionModel,
      requestCompletionCallback: (input) =>
        requestCompletionCallback(callback, continuity, input),
      room: ctx.room,
      ...(keeploreDelegations === undefined
        ? {}
        : { keeploreDelegations }),
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
      prolongedSilenceMs: settings.prolongedSilenceMs,
      usageRatesMicrousdPerMinute: telephoneUsageRatesFromEnvironment(),
    });
  } catch (error) {
    await playPrerecordedProviderFailure(session).catch(() => undefined);
    const occurredAt = new Date().toISOString();
    await recordCompletionSetupProviderFailure({
      boundaries,
      callback,
      error,
      failureEventId: dispatch.effectId,
      occurredAt,
      telephoneSessionId: dispatch.telephoneSessionId,
    }).catch(() => undefined);
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
    await warmSession.release();
    disconnected?.cancel();
    // Closed here unless the resumed Telephone Session already took them over.
    if (!handedOffToLiveSession) {
      await detector?.close();
      await session.close().catch(() => undefined);
    }
    // The room belongs to whoever took it: the live session that already ended
    // the call, or the separate recovery job this handler stood down for.
    if (!liveSessionEndedCall && !handedOffToRecovery) {
      await ctx.deleteRoom().catch(() => undefined);
    }
  }
}

async function handleCompletionResumption(
  ctx: JobContext,
  callback: CallbackRuntime,
  tasks: TaskRuntime,
  continuity: ContinuityRuntime,
  boundaries: BoundaryRuntime,
  keeploreDelegations: KeeploreRuntime | undefined,
  dispatch: CompletionCallbackDispatch,
): Promise<void> {
  const warmSession = await acquireWarmSessionLease({
    boundaries,
    onRejected: async (decision) => {
      await continuity
        .requestSessionFailureNotification({
          callbackOperationId: dispatch.operationId,
          failureEventId: `limit:${dispatch.effectId}:${boundaryDenialReason(decision)}`,
          occurredAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      await ctx.deleteRoom().catch(() => undefined);
    },
    telephoneSessionId: dispatch.telephoneSessionId,
  });
  if (warmSession === undefined) return;
  let disconnected:
    | ReturnType<typeof waitForParticipantDisconnect>
    | undefined;
  let liveSessionEndedCall = false;
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
    const admission = await boundaries.activateSession(
      dispatch.telephoneSessionId,
    );
    if (admission.decision !== "accepted") {
      await continuity.requestSessionFailureNotification({
        callbackOperationId: dispatch.operationId,
        failureEventId: `limit:${dispatch.effectId}:${boundaryDenialReason(admission)}`,
        occurredAt: new Date().toISOString(),
      });
      return;
    }
    await runLiveKitTelephoneSession({
      activeTaskId: dispatch.taskId,
      boundaries,
      disconnected: disconnected.promise,
      endCall: async () => {
        liveSessionEndedCall = true;
        await ctx.deleteRoom();
      },
      openingText: `Your task concluded: ${record.task.conclusion}`,
      onStarted: () =>
        continuity.recordCompletionResumption({
          operationId: requireResumptionOperationId(dispatch),
        }),
      recognitionModel: settings.recognitionModel,
      requestCompletionCallback: (input) =>
        requestCompletionCallback(callback, continuity, input),
      room: ctx.room,
      ...(keeploreDelegations === undefined
        ? {}
        : { keeploreDelegations }),
      sessionEvidence: completionSessionEvidence(
        tasks,
        continuity,
        dispatch.operationId,
        dispatch.taskId,
      ),
      tasks,
      telephoneSessionId: dispatch.telephoneSessionId,
      prolongedSilenceMs: settings.prolongedSilenceMs,
      usageRatesMicrousdPerMinute: telephoneUsageRatesFromEnvironment(),
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
    await warmSession.release();
    disconnected?.cancel();
    if (!liveSessionEndedCall) {
      await ctx.deleteRoom().catch(() => undefined);
    }
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

async function recordAuthenticationSetupProviderFailure(input: {
  readonly boundaries: BoundaryRuntime;
  readonly error: unknown;
  readonly failureEventId: string;
  readonly handshakeId: string;
  readonly occurredAt: string;
  readonly result: CallbackActionResult;
  readonly runtime: CallbackRuntime;
  readonly telephoneSessionId: string;
}): Promise<void> {
  await recordSetupProviderFailure({
    append: (event) =>
      input.runtime.appendTelephoneSessionEvidence(input.handshakeId, event),
    boundaries: input.boundaries,
    error: input.error,
    failureEventId: input.failureEventId,
    occurredAt: input.occurredAt,
    telephoneSessionId: input.telephoneSessionId,
  });
  const notification = input.result.actions.find(
    (action) => action.kind === "request-silent-notification",
  );
  if (notification === undefined) {
    await input.runtime.requestTelephoneSessionFailureNotification(
      input.handshakeId,
      {
        failureEventId: input.failureEventId,
        occurredAt: input.occurredAt,
      },
    );
  }
}

async function recordCompletionSetupProviderFailure(input: {
  readonly boundaries: BoundaryRuntime;
  readonly callback: CallbackRuntime;
  readonly error: unknown;
  readonly failureEventId: string;
  readonly occurredAt: string;
  readonly telephoneSessionId: string;
}): Promise<void> {
  await recordSetupProviderFailure({
    append: (event) =>
      input.callback.appendTelephoneSessionEvidenceBySessionId(
        input.telephoneSessionId,
        event,
      ),
    boundaries: input.boundaries,
    error: input.error,
    failureEventId: input.failureEventId,
    occurredAt: input.occurredAt,
    telephoneSessionId: input.telephoneSessionId,
  });
}

async function recordSetupProviderFailure(input: {
  readonly append: (
    event: Omit<TelephoneEvidenceEvent, "sequence">,
  ) => Promise<unknown>;
  readonly boundaries: BoundaryRuntime;
  readonly error: unknown;
  readonly failureEventId: string;
  readonly occurredAt: string;
  readonly telephoneSessionId: string;
}): Promise<void> {
  await recordTelephoneSetupProviderFailure({
    recognition: settings.recognitionModel,
    append: input.append,
    error: input.error,
    failureEventId: input.failureEventId,
    occurredAt: input.occurredAt,
    recordProviderFailure: (failure) =>
      input.boundaries.recordProviderFailure(failure),
    telephoneSessionId: input.telephoneSessionId,
  });
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
    connOptions: {
      maxUnrecoverableErrors: 0,
      ttsConnOptions: boundedProviderConnectOptions("tts"),
    },
    tts: new inference.TTS({
      connOptions: boundedProviderConnectOptions("tts"),
      language: "en",
      model: "inworld/inworld-tts-2",
      voice: process.env.VOICE_AGENT_TTS_VOICE ?? "Sarah",
    }),
    ttsReadIdleTimeout: 10_000,
  });
}

async function startFixedSpeechSession(
  session: voice.AgentSession,
  room: Room,
): Promise<void> {
  try {
    await session.start({
      agent: fixedSpeechAgent(),
      record: false,
      room,
    });
  } catch (error) {
    throw new TelephoneSetupProviderError("setup", error);
  }
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
  throw new TelephoneSetupProviderError("tts", lastFailure);
}

async function placeCallbackOrRecordFailure(
  runtime: CallbackRuntime,
  boundaries: BoundaryRuntime,
  adapter: LiveKitCallbackAdapter,
  action: Extract<CallbackAction, { kind: "place-callback" }>,
): Promise<void> {
  const handshakeId = requireHandshakeId(action.roomName);
  const record = await runtime.readEvidenceRecord(handshakeId);
  if (record === undefined) {
    throw new Error("Callback Handshake Evidence Record is unavailable");
  }
  const decision = await boundaries.reserveWarmSession(record.session.id);
  if (decision.decision !== "accepted") {
    await runtime.receiveProviderEvent(handshakeId, {
      attempt: action.attempt,
      deliveryId: `admission-rejected:${action.effectId}`,
      kind: "ended",
      outcome: "failed",
      providerCallId: action.effectId,
    });
    return;
  }
  if (
    (await reserveTelephoneUsageSlice({
      onSpendingWarning: reportTelephoneSpendingWarning,
      ratesMicrousdPerMinute: telephoneUsageRatesFromEnvironment(),
      reserveUsageSlice: boundaries.reserveUsageSlice,
      sessionId: record.session.id,
      usageScopeId: `prelive:${action.effectId}`,
    })).disposition === "safe-terminal-only"
  ) {
    await boundaries.releaseWarmSession(record.session.id);
    await runtime.receiveProviderEvent(handshakeId, {
      attempt: action.attempt,
      deliveryId: `spending-ceiling:${action.effectId}`,
      kind: "ended",
      outcome: "failed",
      providerCallId: action.effectId,
    });
    return;
  }
  try {
    await adapter.placeCallback(action);
  } catch {
    await boundaries.releaseWarmSession(record.session.id);
    await runtime.receiveProviderEvent(
      handshakeId,
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

function boundaryDenialReason(
  decision: Awaited<ReturnType<BoundaryRuntime["activateSession"]>>,
): string {
  if (decision.decision === "accepted") {
    throw new Error("Accepted boundary decision has no denial reason");
  }
  return decision.decision === "rejected"
    ? decision.reason
    : `${decision.resource}-queued`;
}
