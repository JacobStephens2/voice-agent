import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface BoundedRunOptions {
  readonly environment: Readonly<Record<string, string>>;
  readonly maximumOutputBytes: number;
  readonly onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  readonly timeoutMilliseconds: number;
  readonly workingDirectory?: string;
}

export interface BoundedRunResult {
  readonly exceededOutputBound: boolean;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/**
 * Run one command inside its own process group under a time and output bound.
 *
 * Nothing here is specific to one provider.
 *
 * Both bounds report rather than throw. A provider run that floods or hangs is
 * an ending this contract has a name for, and the caller decides that name
 * from what the run had already said - so the partial output travels back with
 * the reason it was cut short instead of being discarded with it.
 */
export function runBoundedCommand(
  command: string,
  arguments_: readonly string[],
  options: BoundedRunOptions,
): Promise<BoundedRunResult> {
  const child = spawn(command, [...arguments_], {
    cwd: options.workingDirectory ?? "/",
    // The run owns a process group so that a bound stops the model's
    // descendants too, not just the runner that spawned them.
    detached: true,
    env: { ...options.environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  options.onSpawn?.(child);
  child.stdin.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let exceededOutputBound = false;
  let timedOut = false;
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    if (exceededOutputBound) return;
    const remaining = options.maximumOutputBytes - outputBytes;
    outputBytes += chunk.length;
    if (chunk.length >= remaining) {
      exceededOutputBound = true;
      target.push(chunk.subarray(0, Math.max(remaining, 0)));
      terminateProcessGroup(child);
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child);
  }, options.timeoutMilliseconds);
  return new Promise<BoundedRunResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exceededOutputBound,
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut,
      });
    });
  }).finally(() => clearTimeout(timeout));
}

/** Stop a run and everything it started, then make sure of it. */
export function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
): void {
  if (child.pid === undefined) return;
  const processGroupId = child.pid;
  let closed = child.exitCode !== null;
  child.once("close", () => {
    closed = true;
  });
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceKill = setTimeout(() => {
    if (closed) return;
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  forceKill.unref();
}
