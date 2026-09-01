import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { CallbackAction } from "@voice-agent/contracts";
import {
  createUnixSocketBountywellController,
  createUnixSocketBountywellObserver,
} from "@voice-agent/operations-broker";
import {
  administrativeRestartWitnessWorkerIdentitySocketPath,
  createCallbackHandshakeRuntime,
  createDurableTaskRuntime,
  createKeeploreDelegationRuntime,
  createNodeRawAudioArtifactRemover,
  createNodeAdministrativeRestartWitnessWorkerIdentityServer,
  createNodeAdministrativeRestartWitnessWorkerReadiness,
  createTelephoneBoundaryRuntime,
  createTaskContinuityRuntime,
  createUnixSocketKeeploreSubagentRunner,
  registerNodeAdministrativeRestartWitnessServiceInstance,
} from "@voice-agent/runtime";
import {
  createSqliteAdministrativeAutonomyStore,
  createSqliteAdministrativeRestartWitnessStore,
  createSqliteCallbackHandshakeStore,
  createSqliteDurableTaskStore,
  createSqliteKeeploreDelegationStore,
  createSqliteKeeploreOnboardingStore,
  createSqliteTelephoneBoundaryStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";

import {
  deliverPendingAuthenticationFailureNotifications,
} from "./authentication-failure-notifications.ts";
import { createBountywellCompletionReports } from "./bountywell-completion-report.ts";
import {
  createProductionLiveKitCallbackAdapter,
  type LiveKitCallbackAdapter,
} from "./livekit-callback-adapter.ts";
import { createProductionLiveKitCompletionCallbackAdapter } from "./livekit-completion-callback-adapter.ts";
import { createLiveKitAgentServer } from "./livekit-agent-server.ts";
import { createProductionResendSilentNotificationAdapter } from "./resend-silent-notification.ts";
import {
  reportTelephoneSpendingWarning,
  reserveTelephoneUsageSlice,
  telephoneUsageRatesFromEnvironment,
} from "./telephone-usage-meter.ts";
import { resolveTelephoneWorkerSettings } from "./telephone-worker-settings.ts";

// This is the process the registered unit runs, so refusing a setting here is
// what a Promotion Attempt's health verification sees and rolls back.
const settings = resolveTelephoneWorkerSettings();
const databasePath = settings.databasePath;
const socketPath = settings.brokerSocketPath;
const store = createSqliteDurableTaskStore(databasePath);
const callbackStore = createSqliteCallbackHandshakeStore(databasePath);
const callbackRuntime = createCallbackHandshakeRuntime({
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: callbackStore,
});
const telephoneBoundaryStore = createSqliteTelephoneBoundaryStore(databasePath);
const telephoneBoundaries = createTelephoneBoundaryRuntime({
  evidence: {
    async append(telephoneSessionId, event) {
      await callbackRuntime.appendTelephoneSessionEvidenceBySessionId(
        telephoneSessionId,
        event,
      );
    },
  },
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  // The deadline sweep below ends prolonged silence, so it enforces the same
  // configured bound the Telephone Session itself does.
  prolongedSilenceMs: settings.prolongedSilenceMs,
  rawAudioArtifacts: createNodeRawAudioArtifactRemover(),
  rawAudioDebugDirectory: settings.rawAudioDebugDirectory,
  store: telephoneBoundaryStore,
});
const telephoneUsageRates = telephoneUsageRatesFromEnvironment();
const continuityStore = createSqliteTaskContinuityStore(databasePath);
const administrativeEvidenceStore =
  createSqliteAdministrativeAutonomyStore(databasePath);
const continuityRuntime = createTaskContinuityRuntime({
  administrativeEvidenceRetention: administrativeEvidenceStore,
  callbackEvidenceRetention: callbackStore,
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: continuityStore,
  tasks: store,
});
const runtime = createDurableTaskRuntime({
  applicationRegistry: store,
  completionReports: createBountywellCompletionReports({
    callbacks: callbackRuntime,
    continuity: continuityRuntime,
  }),
  healthObserver: createUnixSocketBountywellObserver(socketPath),
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  // This Personal Prototype serves one owner, so a live Telephone Session is
  // the owner's; the drill runs only while one is carrying them.
  ownerAvailability: {
    async countLiveTelephoneSessions() {
      return (await telephoneBoundaryStore.findActiveSessionIds()).length;
    },
  },
  serviceController: createUnixSocketBountywellController(socketPath),
  store,
});
const keeploreOnboardingStore = createSqliteKeeploreOnboardingStore(databasePath);
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
const agentName = "voice-agent-telephone";
const liveKitConnection = {
  apiKey: settings.liveKitApiKey,
  apiSecret: settings.liveKitApiSecret,
  url: settings.liveKitUrl,
};
const callbackAdapter = createProductionLiveKitCallbackAdapter({
  agentName,
  ...liveKitConnection,
  placementClaims: callbackStore,
});
const completionCallbackAdapter =
  createProductionLiveKitCompletionCallbackAdapter({
    agentName,
    ...liveKitConnection,
    placementClaims: continuityStore,
  });
const notificationAdapter = createProductionResendSilentNotificationAdapter(
  {
    apiKey: requireEnvironment("RESEND_API_KEY"),
    domainId: requireEnvironment("RESEND_DOMAIN_ID"),
    notificationSubdomain: requireEnvironment(
      "VOICE_AGENT_NOTIFICATION_SUBDOMAIN",
    ),
  },
);
const workerPort = Number(requireEnvironment("VOICE_AGENT_WORKER_PORT"));
const telephoneServer = createLiveKitAgentServer({
  agent: fileURLToPath(new URL("./telephone-agent.ts", import.meta.url)),
  agentName,
  ...liveKitConnection,
  port: workerPort,
});

let stopping = false;
let serverFailure: unknown;
let nextEvidenceRetentionAt = 0;
let nextRawAudioCleanupAt = 0;
let nextBoundaryDeadlineAt = 0;
let nextAuthenticationNotificationAt = 0;
let restartWitnessIdentityServer:
  | ReturnType<
      typeof createNodeAdministrativeRestartWitnessWorkerIdentityServer
    >
  | undefined;
process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});
const serverRun = telephoneServer.run().catch((error: unknown) => {
  serverFailure = error;
  stopping = true;
});
if (process.env.NODE_ENV !== "test") {
  await requireWorkerReady(
    createNodeAdministrativeRestartWitnessWorkerReadiness({ port: workerPort }),
    () => serverFailure,
  );
  const restartWitnessStore = createSqliteAdministrativeRestartWitnessStore(
    databasePath,
  );
  try {
    const registration =
      await registerNodeAdministrativeRestartWitnessServiceInstance({
        nextServiceInstanceId: () =>
          `administrative-worker-service-instance-${randomUUID()}`,
        now: () => new Date().toISOString(),
        service: "worker",
        store: restartWitnessStore,
      });
    restartWitnessIdentityServer =
      createNodeAdministrativeRestartWitnessWorkerIdentityServer({
        identity: {
          releaseCommit: registration.releaseCommit,
          workerServiceInstanceFingerprint:
            registration.serviceInstanceFingerprint,
        },
        socketPath: administrativeRestartWitnessWorkerIdentitySocketPath,
      });
    await restartWitnessIdentityServer.start();
  } finally {
    await restartWitnessStore.close();
  }
}

while (!stopping) {
  try {
    const delegation = await keeploreDelegations?.processNext();
    if (delegation !== undefined) continue;
    if (Date.now() >= nextEvidenceRetentionAt) {
      await continuityRuntime.runEvidenceLifecyclePolicy();
      nextEvidenceRetentionAt = Date.now() + 60 * 60 * 1_000;
    }
    if (Date.now() >= nextRawAudioCleanupAt) {
      await telephoneBoundaries.cleanupExpiredRawAudio();
      nextRawAudioCleanupAt = Date.now() + 60 * 60 * 1_000;
    }
    if (Date.now() >= nextBoundaryDeadlineAt) {
      await telephoneBoundaries.enforceDeadlines();
      nextBoundaryDeadlineAt = Date.now() + 5_000;
    }
    if (Date.now() >= nextAuthenticationNotificationAt) {
      await deliverPendingAuthenticationFailureNotifications(
        callbackRuntime,
        continuityRuntime,
        notificationAdapter,
      );
      nextAuthenticationNotificationAt = Date.now() + 5_000;
    }
    if ((await runtime.getBountywellRegistration()) !== undefined) {
      const outage = await runtime.processNextBountywellOutageRecovery();
      if (outage !== undefined) continue;
      const record = await runtime.processNextBountywellHealthInquiry();
      if (record !== undefined) continue;
    }
    const report = await continuityRuntime.processNextReport();
    if (report?.kind === "place-completion-callback") {
      const admission = await telephoneBoundaries.reserveWarmSession(
        report.telephoneSessionId,
      );
      if (admission.decision !== "accepted") {
        await continuityRuntime.requestSessionFailureNotification({
          callbackOperationId: report.operationId,
          failureEventId: `${report.operationId}:admission-rejected`,
          occurredAt: new Date().toISOString(),
        });
        continue;
      }
      if (
        (await reserveTelephoneUsageSlice({
          onSpendingWarning: reportTelephoneSpendingWarning,
          ratesMicrousdPerMinute: telephoneUsageRates,
          reserveUsageSlice: telephoneBoundaries.reserveUsageSlice,
          sessionId: report.telephoneSessionId,
          usageScopeId: `prelive:${report.operationId}`,
        })).disposition === "safe-terminal-only"
      ) {
        await telephoneBoundaries.releaseWarmSession(report.telephoneSessionId);
        await continuityRuntime.requestSessionFailureNotification({
          callbackOperationId: report.operationId,
          failureEventId: `${report.operationId}:spending-ceiling`,
          occurredAt: new Date().toISOString(),
        });
        continue;
      }
      try {
        await completionCallbackAdapter.placeCallback(report);
      } catch {
        await telephoneBoundaries.releaseWarmSession(report.telephoneSessionId);
        await continuityRuntime.receiveCompletionCallbackEvent({
          deliveryId: `placement-failed:${report.operationId}`,
          operationId: report.operationId,
          outcome: "failed",
        });
      }
      continue;
    }
    if (report?.kind === "resume-completion-callback") {
      const admission = await telephoneBoundaries.reserveWarmSession(
        report.telephoneSessionId,
      );
      if (admission.decision !== "accepted") {
        await continuityRuntime.requestSessionFailureNotification({
          callbackOperationId: report.callbackOperationId,
          failureEventId: `${report.operationId}:admission-rejected`,
          occurredAt: new Date().toISOString(),
        });
        continue;
      }
      try {
        await completionCallbackAdapter.resumeCallback(report);
      } catch {
        await telephoneBoundaries.releaseWarmSession(report.telephoneSessionId);
        await continuityRuntime.requestSessionFailureNotification({
          callbackOperationId: report.callbackOperationId,
          failureEventId: `${report.operationId}:resumption-dispatch-failed`,
          occurredAt: new Date().toISOString(),
        });
      }
      continue;
    }
    if (report?.kind === "send-silent-notification") {
      const sent = await notificationAdapter.send(report);
      await continuityRuntime.recordNotificationDelivery({
        deliveryId: `resend:${report.operationId}`,
        operationId: report.operationId,
        providerMessageId: sent.providerMessageId,
      });
      continue;
    }
    const retries = await callbackRuntime.processDueRetries();
    for (const retry of retries) {
      for (const action of retry.result.actions) {
        if (action.kind !== "place-callback") continue;
        await placeCallbackOrRecordFailure(
          callbackRuntime,
          telephoneBoundaries,
          callbackAdapter,
          action,
        );
      }
    }
  } catch {
    process.stderr.write("Voice worker cycle failed; retrying after a bounded delay.\n");
  }
  await delay(1_000);
}
await restartWitnessIdentityServer?.close();
await telephoneServer.drain(10_000);
await telephoneServer.close();
await serverRun;
await callbackRuntime.close();
await telephoneBoundaries.close();
await continuityRuntime.close();
await administrativeEvidenceStore.close();
await runtime.close();
keeploreDelegationStore?.close();
keeploreOnboardingStore.close();
if (serverFailure !== undefined) throw serverFailure;

async function placeCallbackOrRecordFailure(
  callback: ReturnType<typeof createCallbackHandshakeRuntime>,
  boundaries: ReturnType<typeof createTelephoneBoundaryRuntime>,
  adapter: LiveKitCallbackAdapter,
  action: Extract<CallbackAction, { kind: "place-callback" }>,
): Promise<void> {
  const handshakeId = requireHandshakeId(action.roomName);
  const record = await callback.readEvidenceRecord(handshakeId);
  if (record === undefined) {
    throw new Error("Callback Handshake Evidence Record is unavailable");
  }
  const admission = await boundaries.reserveWarmSession(record.session.id);
  if (admission.decision !== "accepted") {
    await callback.receiveProviderEvent(handshakeId, {
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
      ratesMicrousdPerMinute: telephoneUsageRates,
      reserveUsageSlice: boundaries.reserveUsageSlice,
      sessionId: record.session.id,
      usageScopeId: `prelive:${action.effectId}`,
    })).disposition === "safe-terminal-only"
  ) {
    await boundaries.releaseWarmSession(record.session.id);
    await callback.receiveProviderEvent(handshakeId, {
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
    await callback.receiveProviderEvent(
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

function requireHandshakeId(roomName: string): string {
  const prefix = "callback-handshake-";
  if (!roomName.startsWith(prefix) || roomName.length === prefix.length) {
    throw new Error("Callback room is missing its durable handshake identity");
  }
  return roomName.slice(prefix.length);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requireWorkerReady(
  health: { readonly requireAvailable: () => Promise<void> },
  readFailure: () => unknown,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const failure = readFailure();
    if (failure !== undefined) throw failure;
    try {
      await health.requireAvailable();
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("The worker health endpoint did not become ready");
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
