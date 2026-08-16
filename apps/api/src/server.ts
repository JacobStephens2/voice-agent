import {
  createAuthenticationLifecycle,
  createNodeAuthenticationSecrets,
  createSimpleWebAuthnPasskeyAdapter,
} from "@voice-agent/auth";
import {
  createSqliteAuthenticationStore,
  createSqliteCallbackHandshakeStore,
  createSqliteDurableTaskStore,
} from "@voice-agent/sqlite-store";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createVoiceApi } from "./index.ts";
import {
  createCallbackHandshakeRuntime,
  createDurableTaskRuntime,
} from "@voice-agent/runtime";

const databasePath = process.env.VOICE_AGENT_DATABASE_PATH;
if (databasePath === undefined || databasePath.length === 0) {
  throw new Error("VOICE_AGENT_DATABASE_PATH is required");
}

const testMode = process.env.NODE_ENV === "test";
if (testMode && process.env.VOICE_AGENT_RESET_DATABASE === "1") {
  for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
    rmSync(path, { force: true });
  }
}
const origin = testMode
  ? (process.env.VOICE_AGENT_ORIGIN ?? "http://127.0.0.1:4173")
  : "https://voice.stephens.page";
const rpId = testMode ? new URL(origin).hostname : "voice.stephens.page";
const authenticationStore = createSqliteAuthenticationStore(databasePath);
const taskStore = createSqliteDurableTaskStore(databasePath);
const runtime = createDurableTaskRuntime({
  applicationRegistry: taskStore,
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: taskStore,
});
const callbackRuntime = createCallbackHandshakeRuntime({
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: createSqliteCallbackHandshakeStore(databasePath),
});
const authentication = createAuthenticationLifecycle({
  now: () => new Date().toISOString(),
  ownerUserId: process.env.VOICE_AGENT_OWNER_ID ?? "personal-owner",
  passkeys: createSimpleWebAuthnPasskeyAdapter({
    origin,
    rpId,
    rpName: "Voice Agent",
  }),
  secrets: createNodeAuthenticationSecrets(),
  store: authenticationStore,
});
const api = createVoiceApi({
  additionalMetrics: () => readAdditionalMetrics(
    process.env.VOICE_AGENT_PROMOTION_METRICS_PATH ??
      "/var/lib/voice-agent-promotions/promotions.prom",
  ),
  authentication,
  controls: runtime,
  origin,
  promotionControl: {
    requestResume: () => requestPromotionResume(
      process.env.VOICE_AGENT_PROMOTION_RESUME_PATH ??
        "/var/lib/voice-agent-promotion-resume/resume.request",
      process.env.VOICE_AGENT_PROMOTION_STATE_PATH ??
        "/var/lib/voice-agent-promotions/state.tsv",
    ),
  },
  records: {
    getEvidenceRecord: async (taskId) =>
      (await callbackRuntime.readEvidenceRecord(taskId)) ??
      (await runtime.getEvidenceRecord(taskId)),
    listEvidenceRecords: async () => {
      const records = [
        ...(await runtime.listEvidenceRecords()),
        ...(await callbackRuntime.listEvidenceRecords()),
      ];
      return records
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 100);
    },
    readOperationalMetrics: async () => ({
      ...(await runtime.readOperationalMetrics()),
      callbacks: await callbackRuntime.readOperationalMetrics(),
    }),
    recordPolicyDenial: () => runtime.recordPolicyDenial(),
  },
  telephoneControls: callbackRuntime,
});
await api.register(staticFiles, {
  root: fileURLToPath(new URL("../../pwa/dist", import.meta.url)),
});

const shutdown = async () => {
  await api.close();
  await authenticationStore.close();
  await callbackRuntime.close();
  await runtime.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await api.listen({
  host: "127.0.0.1",
  port: Number(process.env.VOICE_AGENT_PORT ?? "3472"),
});

async function requestPromotionResume(
  path: string,
  statePath: string,
): Promise<string> {
  let stateContents: string;
  try {
    stateContents = await readFile(statePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("No open Deployment Circuit Breaker");
    }
    throw error;
  }
  const state = stateContents.trim().split("\t");
  const circuitState = state[1];
  const commit = state[2];
  if (circuitState !== "open" || commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("No open Deployment Circuit Breaker");
  }
  try {
    const request = await open(path, "wx", 0o640);
    try {
      await request.writeFile(`${commit}\n`, "utf8");
    } finally {
      await request.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const queuedCommit = (await readFile(path, "utf8")).trim();
      if (/^[0-9a-f]{40}$/u.test(queuedCommit)) return queuedCommit;
    } else {
      throw error;
    }
    throw new Error("Promotion resume request is invalid");
  }
  return commit;
}

async function readAdditionalMetrics(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}
