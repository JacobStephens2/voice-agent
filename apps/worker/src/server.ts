import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { CallbackAction } from "@voice-agent/contracts";
import {
  createUnixSocketBountywellObserver,
} from "@voice-agent/operations-broker";
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
import { createProductionLiveKitCompletionCallbackAdapter } from "./livekit-completion-callback-adapter.ts";
import { createLiveKitAgentServer } from "./livekit-agent-server.ts";
import { createProductionResendSilentNotificationAdapter } from "./resend-silent-notification.ts";

const databasePath = requireEnvironment("VOICE_AGENT_DATABASE_PATH");
const socketPath = requireEnvironment("VOICE_AGENT_BROKER_SOCKET_PATH");
const store = createSqliteDurableTaskStore(databasePath);
const runtime = createDurableTaskRuntime({
  applicationRegistry: store,
  healthObserver: createUnixSocketBountywellObserver(socketPath),
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store,
});
const callbackStore = createSqliteCallbackHandshakeStore(databasePath);
const callbackRuntime = createCallbackHandshakeRuntime({
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: callbackStore,
});
const continuityStore = createSqliteTaskContinuityStore(databasePath);
const continuityRuntime = createTaskContinuityRuntime({
  callbackEvidenceRetention: callbackStore,
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: continuityStore,
  tasks: store,
});
const agentName = "voice-agent-telephone";
const liveKitConnection = {
  apiKey: requireEnvironment("LIVEKIT_API_KEY"),
  apiSecret: requireEnvironment("LIVEKIT_API_SECRET"),
  url: requireEnvironment("LIVEKIT_URL"),
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
const telephoneServer = createLiveKitAgentServer({
  agent: fileURLToPath(new URL("./telephone-agent.ts", import.meta.url)),
  agentName,
  ...liveKitConnection,
  port: Number(requireEnvironment("VOICE_AGENT_WORKER_PORT")),
});

let stopping = false;
let serverFailure: unknown;
let nextEvidenceRetentionAt = 0;
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

while (!stopping) {
  try {
    if (Date.now() >= nextEvidenceRetentionAt) {
      await continuityRuntime.runEvidenceLifecyclePolicy();
      nextEvidenceRetentionAt = Date.now() + 60 * 60 * 1_000;
    }
    if ((await runtime.getBountywellRegistration()) !== undefined) {
      const record = await runtime.processNextBountywellHealthInquiry();
      if (record !== undefined) continue;
    }
    const report = await continuityRuntime.processNextReport();
    if (report?.kind === "place-completion-callback") {
      try {
        await completionCallbackAdapter.placeCallback(report);
      } catch {
        await continuityRuntime.receiveCompletionCallbackEvent({
          deliveryId: `placement-failed:${report.operationId}`,
          operationId: report.operationId,
          outcome: "failed",
        });
      }
      continue;
    }
    if (report?.kind === "resume-completion-callback") {
      try {
        await completionCallbackAdapter.resumeCallback(report);
      } catch {
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
await telephoneServer.drain(10_000);
await telephoneServer.close();
await serverRun;
await callbackRuntime.close();
await continuityRuntime.close();
await runtime.close();
if (serverFailure !== undefined) throw serverFailure;

async function placeCallbackOrRecordFailure(
  callback: ReturnType<typeof createCallbackHandshakeRuntime>,
  adapter: LiveKitCallbackAdapter,
  action: Extract<CallbackAction, { kind: "place-callback" }>,
): Promise<void> {
  try {
    await adapter.placeCallback(action);
  } catch {
    await callback.receiveProviderEvent(
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

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
