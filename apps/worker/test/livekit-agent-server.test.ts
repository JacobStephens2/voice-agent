import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
  createLiveKitAgentServer,
  createLiveKitAgentServerOptions,
} from "../src/livekit-agent-server.ts";

test("the LiveKit worker initializes its logger before constructing the server", () => {
  expect(() =>
    createLiveKitAgentServer({
      agent: fileURLToPath(
        new URL("../src/telephone-agent.ts", import.meta.url),
      ),
      agentName: "voice-agent-telephone-test",
      apiKey: "test-key",
      apiSecret: "test-secret",
      port: 0,
      url: "wss://livekit.example.test",
    }),
  ).not.toThrow();
});

test("the LiveKit worker uses the configured cloud credentials", () => {
  const options = createLiveKitAgentServerOptions({
    agent: fileURLToPath(new URL("../src/telephone-agent.ts", import.meta.url)),
    agentName: "voice-agent-telephone-test",
    apiKey: "cloud-key",
    apiSecret: "cloud-secret",
    port: 0,
    url: "wss://livekit.example.test",
  });

  expect(options).toMatchObject({
    apiKey: "cloud-key",
    apiSecret: "cloud-secret",
    wsURL: "wss://livekit.example.test",
  });
});

test("the production TypeScript loader initializes the telephone child", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/telephone-agent.ts", import.meta.url)),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  expect(result.status, result.stderr).toBe(0);
});
