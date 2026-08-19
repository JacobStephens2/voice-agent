import {
  createBountywellHostProbes,
  createBountywellOperationsBroker,
  createOperationsBrokerServer,
  createSqliteBrokerOperationStore,
  createSystemdBountywellServiceController,
} from "@voice-agent/operations-broker";

const databasePath = requireEnvironment("VOICE_AGENT_BROKER_DATABASE_PATH");
const socketPath = requireEnvironment("VOICE_AGENT_BROKER_SOCKET_PATH");
const store = createSqliteBrokerOperationStore(databasePath);
const observer = createBountywellOperationsBroker({
  now: () => new Date().toISOString(),
  probes: createBountywellHostProbes(),
  store,
});
const server = createOperationsBrokerServer({
  controller: createSystemdBountywellServiceController(),
  observer,
});
await server.listen(socketPath);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  await store.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
