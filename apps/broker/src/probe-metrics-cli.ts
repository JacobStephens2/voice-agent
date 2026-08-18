import { request as requestHttp } from "node:http";
import { rename, unlink, writeFile } from "node:fs/promises";

import {
  createBountywellHostProbes,
  renderApplicationProbeMetrics,
} from "@voice-agent/operations-broker";

const outputPath = requireEnvironment("VOICE_AGENT_PROBE_METRICS_PATH");
const brokerSocketPath = requireEnvironment("VOICE_AGENT_BROKER_SOCKET_PATH");
// The registered Bountywell probes are fixed to /api/health and /api/data by policy.
const metrics = await renderApplicationProbeMetrics({
  bountywell: createBountywellHostProbes(),
  voiceAgent: {
    readApiHealthStatus: () => requestHttpStatus("127.0.0.1", 3472, "/healthz"),
    readBrokerHealthStatus: () => requestUnixStatus(brokerSocketPath, "/healthz"),
    readWorkerHealthStatus: () => requestHttpStatus("127.0.0.1", 3474, "/"),
  },
});
const candidatePath = `${outputPath}.${process.pid}.tmp`;
try {
  await writeFile(candidatePath, metrics, { encoding: "utf8", mode: 0o644 });
  await rename(candidatePath, outputPath);
} catch (error) {
  await unlink(candidatePath).catch(() => undefined);
  throw error;
}

function requestHttpStatus(
  hostname: "127.0.0.1",
  port: 3472 | 3474,
  path: "/" | "/healthz",
): Promise<number> {
  return requestStatus({ hostname, path, port });
}

function requestUnixStatus(socketPath: string, path: "/healthz"): Promise<number> {
  return requestStatus({ path, socketPath });
}

function requestStatus(options: {
  readonly hostname?: string;
  readonly path: string;
  readonly port?: number;
  readonly socketPath?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = requestHttp({ ...options, method: "GET", timeout: 5_000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("Probe timed out")));
    request.end();
  });
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
