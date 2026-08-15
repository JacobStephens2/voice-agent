import {
  createAuthenticationLifecycle,
  createNodeAuthenticationSecrets,
  createSimpleWebAuthnPasskeyAdapter,
} from "@voice-agent/auth";
import { createSqliteAuthenticationStore } from "@voice-agent/sqlite-store";

const databasePath = readOption("--database") ?? process.env.VOICE_AGENT_DATABASE_PATH;
if (databasePath === undefined || databasePath.length === 0) {
  throw new Error(
    "Set VOICE_AGENT_DATABASE_PATH or pass --database with the authentication SQLite path.",
  );
}

const store = createSqliteAuthenticationStore(databasePath);
try {
  const authentication = createAuthenticationLifecycle({
    now: () => new Date().toISOString(),
    ownerUserId: process.env.VOICE_AGENT_OWNER_ID ?? "personal-owner",
    passkeys: createSimpleWebAuthnPasskeyAdapter({
      origin: "https://voice.stephens.page",
      rpId: "voice.stephens.page",
      rpName: "Voice Agent",
    }),
    secrets: createNodeAuthenticationSecrets(),
    store,
  });
  const code = await authentication.generateBootstrapCode();
  process.stdout.write(`${code}\n`);
} finally {
  await store.close();
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
