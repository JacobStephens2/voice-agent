import { randomUUID } from "node:crypto";

import {
  createUnixSocketBountywellObserver,
} from "@voice-agent/operations-broker";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

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

let stopping = false;
process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

while (!stopping) {
  try {
    if ((await runtime.getBountywellRegistration()) !== undefined) {
      const record = await runtime.processNextBountywellHealthInquiry();
      if (record !== undefined) continue;
    }
  } catch {
    process.stderr.write("Bountywell worker cycle failed; retrying after a bounded delay.\n");
  }
  await delay(1_000);
}
await runtime.close();

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
