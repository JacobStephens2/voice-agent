import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

import { createLiveKitAgentServer } from "../src/livekit-agent-server.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("the LiveKit worker initializes its logger before constructing the server", () => {
  vi.stubEnv("LIVEKIT_API_KEY", "test-key");
  vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
  vi.stubEnv("LIVEKIT_URL", "wss://livekit.example.test");

  expect(() =>
    createLiveKitAgentServer({
      agent: fileURLToPath(
        new URL("../src/telephone-agent.ts", import.meta.url),
      ),
      agentName: "voice-agent-telephone-test",
      port: 0,
    }),
  ).not.toThrow();
});
