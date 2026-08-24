import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  keeploreDelegationBriefSchema,
  keeploreDelegationResultSchema,
  keeploreWorktreeSchema,
  type KeeploreDelegationBrief,
  type KeeploreDelegationResult,
  type KeeploreWorktree,
} from "@voice-agent/contracts";
import { z } from "zod";

const maximumRequestBytes = 1_000_000;
const maximumResultBytes = 1_000_000;
const resultDirectory = "/var/lib/voice-codex/results";

const executeRequestSchema = z
  .object({
    brief: keeploreDelegationBriefSchema,
    worktree: keeploreWorktreeSchema,
  })
  .strict();
const stopRequestSchema = z
  .object({ delegationId: z.string().min(1).max(120) })
  .strict();

export interface KeeploreSubagentExecutor {
  execute(input: {
    readonly brief: KeeploreDelegationBrief;
    readonly worktree: KeeploreWorktree;
  }): Promise<KeeploreDelegationResult>;
  requestStop(delegationId: string): Promise<boolean>;
}

export interface KeeploreSubagentRunnerServer {
  close(): Promise<void>;
  start(): Promise<void>;
}

export function createKeeploreSubagentRunnerServer(options: {
  readonly executor: KeeploreSubagentExecutor;
  readonly socketPath: string;
}): KeeploreSubagentRunnerServer {
  const server = createServer((request, response) => {
    void handleRequest(options.executor, request, response);
  });
  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await unlink(options.socketPath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    },
    async start() {
      await unlink(options.socketPath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(options.socketPath, 0o660);
    },
  };
}

export function createProcessKeeploreSubagentExecutor(options: {
  readonly command: string;
}): KeeploreSubagentExecutor {
  let active:
    | {
        readonly delegationId: string;
        readonly process: ChildProcessWithoutNullStreams;
        readonly result: Promise<KeeploreDelegationResult>;
      }
    | undefined;
  return {
    async execute(input) {
      const cached = await readCachedResult(input.brief.delegationId);
      if (cached !== undefined) return cached;
      if (active !== undefined) {
        if (active.delegationId === input.brief.delegationId) {
          return await active.result;
        }
        throw new Error("Only one Subagent may run at a time");
      }
      const child = spawn(options.command, [], {
        env: {
          CODEX_HOME: "/var/lib/voice-codex/.codex",
          HOME: "/var/lib/voice-codex",
          LANG: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TMPDIR: "/var/lib/voice-codex/tmp",
          VOICE_AGENT_KEEPLORE_PUBLISHER_SOCKET_PATH:
            process.env.VOICE_AGENT_KEEPLORE_PUBLISHER_SOCKET_PATH ??
            "/run/voice-agent-keeplore-publisher/publisher.sock",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(JSON.stringify(input));
      const result = collectStructuredResult(child).then(async (structured) => {
        await persistCachedResult(structured);
        return structured;
      });
      active = {
        delegationId: input.brief.delegationId,
        process: child,
        result,
      };
      try {
        return await result;
      } finally {
        if (active?.process === child) active = undefined;
      }
    },
    async requestStop(delegationId) {
      if (active?.delegationId !== delegationId) return false;
      // SIGUSR1 asks the executor to stop future steps. It terminates the whole
      // model process group immediately, but lets trusted Git/verification
      // commands reach a safe boundary before returning structured evidence.
      active.process.kill("SIGUSR1");
      return true;
    },
  };
}

async function collectStructuredResult(
  child: ChildProcessWithoutNullStreams,
): Promise<KeeploreDelegationResult> {
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maximumResultBytes) {
      child.kill("SIGTERM");
      return;
    }
    stdout.push(chunk);
  });
  // The raw Codex event stream never reaches here: the executor captures the
  // restricted runner's own output and retains what it keeps as Delegation
  // evidence. What remains on this stream is the executor's account of its own
  // run, so it is forwarded, bounded, to the Agent Host journal.
  child.stderr.on("data", (chunk: Buffer) => {
    const forwardable = stderrBytes + chunk.length <= maximumResultBytes;
    stderrBytes = Math.min(maximumResultBytes + 1, stderrBytes + chunk.length);
    if (forwardable) process.stderr.write(chunk);
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (stdoutBytes > maximumResultBytes || stderrBytes > maximumResultBytes) {
    throw new Error("Restricted Codex output exceeded its bound");
  }
  if (exitCode !== 0) {
    throw new Error("Restricted Codex ended without a structured result");
  }
  return keeploreDelegationResultSchema.parse(
    JSON.parse(Buffer.concat(stdout).toString("utf8")),
  );
}

async function readCachedResult(
  delegationId: string,
): Promise<KeeploreDelegationResult | undefined> {
  try {
    return keeploreDelegationResultSchema.parse(
      JSON.parse(await readFile(resultPath(delegationId), "utf8")),
    );
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function persistCachedResult(
  result: KeeploreDelegationResult,
): Promise<void> {
  await mkdir(resultDirectory, { mode: 0o700, recursive: true });
  const destination = resultPath(result.delegationId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  await rename(temporary, destination);
}

function resultPath(delegationId: string): string {
  const key = createHash("sha256").update(delegationId).digest("hex");
  return `${resultDirectory}/${key}.json`;
}

async function handleRequest(
  executor: KeeploreSubagentExecutor,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method-not-allowed" });
      return;
    }
    const body = await readJson(request);
    if (request.url === "/execute") {
      const input = executeRequestSchema.parse(body);
      sendJson(response, 200, await executor.execute(input));
      return;
    }
    if (request.url === "/stop") {
      const input = stopRequestSchema.parse(body);
      sendJson(response, 200, {
        accepted: await executor.requestStop(input.delegationId),
      });
      return;
    }
    sendJson(response, 404, { error: "not-found" });
  } catch {
    sendJson(response, 422, { error: "subagent-request-refused" });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const untrustedChunk of request) {
    const chunk = Buffer.from(untrustedChunk);
    bytes += chunk.length;
    if (bytes > maximumRequestBytes) {
      throw new Error("Subagent request exceeded its bound");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(serialized),
    "content-type": "application/json",
  });
  response.end(serialized);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
