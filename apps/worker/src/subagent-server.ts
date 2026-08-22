import { fileURLToPath } from "node:url";

import {
  createKeeploreSubagentRunnerServer,
  createProcessKeeploreSubagentExecutor,
} from "./keeplore-subagent-runner-server.ts";

const socketPath =
  process.env.VOICE_AGENT_SUBAGENT_SOCKET_PATH ??
  "/run/voice-agent-subagent/runner.sock";
const command =
  process.env.VOICE_AGENT_CODEX_EXECUTOR ??
  "/usr/local/libexec/voice-agent/run-keeplore-codex-delegation";
const server = createKeeploreSubagentRunnerServer({
  executor: createProcessKeeploreSubagentExecutor({ command }),
  socketPath,
});

await server.start();
let stopping = false;
process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});
while (!stopping) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
await server.close();

export const subagentServerPath = fileURLToPath(import.meta.url);
