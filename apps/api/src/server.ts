import {
  createAuthenticationLifecycle,
  createNodeAuthenticationSecrets,
  createSimpleWebAuthnPasskeyAdapter,
} from "@voice-agent/auth";
import {
  createSqliteAuthenticationStore,
  createSqliteDurableTaskStore,
} from "@voice-agent/sqlite-store";
import staticFiles from "@fastify/static";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createVoiceApi } from "./index.ts";

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
  authentication,
  origin,
  records: {
    getEvidenceRecord: (taskId) => taskStore.findByTaskId(taskId),
    listEvidenceRecords: () => taskStore.listTasks(),
  },
});
await api.register(staticFiles, {
  root: fileURLToPath(new URL("../../pwa/dist", import.meta.url)),
});

const shutdown = async () => {
  await api.close();
  await authenticationStore.close();
  await taskStore.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await api.listen({
  host: "127.0.0.1",
  port: Number(process.env.VOICE_AGENT_PORT ?? "3470"),
});
