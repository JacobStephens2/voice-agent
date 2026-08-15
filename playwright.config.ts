import { defineConfig } from "@playwright/test";

const databasePath = "/tmp/voice-agent-pwa-e2e.sqlite";

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: "list",
  testDir: "./apps/pwa/e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:4183",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm --filter @voice-agent/pwa build && NODE_ENV=test VOICE_AGENT_DATABASE_PATH=${databasePath} VOICE_AGENT_ORIGIN=http://localhost:4183 VOICE_AGENT_PORT=4183 VOICE_AGENT_RESET_DATABASE=1 pnpm --filter @voice-agent/api serve`,
      reuseExistingServer: false,
      timeout: 30_000,
      url: "http://localhost:4183/api/auth/status",
    },
  ],
});
