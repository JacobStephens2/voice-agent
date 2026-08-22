import { createSqliteKeeploreDelegationStore } from "@voice-agent/sqlite-store";

const databasePath =
  process.env.VOICE_AGENT_DATABASE_PATH ??
  "/var/lib/voice-agent/voice-agent.sqlite";
const store = createSqliteKeeploreDelegationStore(databasePath);
try {
  const records = await store.list();
  const latest = records.at(-1);
  if (latest === undefined) {
    process.stderr.write("No Keeplore Button Trial Delegation exists.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(latest, null, 2)}\n`);
  }
} finally {
  store.close();
}
