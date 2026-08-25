import { defaultRecognizedSpeechModel } from "@voice-agent/contracts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDurableTaskRuntime,
  createTelephoneSessionCoordinator,
  type DurableTaskRuntime,
  type TelephoneSessionCoordinator,
} from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];
const smokePath = fileURLToPath(
  new URL("../src/telephone-smoke.ts", import.meta.url),
);

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("telephone acceptance smoke", () => {
  test("waits for TTS timing appended after task completion", async () => {
    const { coordinator, output, tasks } = await startTelephoneSmoke();

    try {
      await output.waitFor("Waiting for a new telephone Bountywell inquiry");
      const result = await coordinator.receiveProviderEvent({
        deliveryId: "telephone-smoke-turn-delivery-001",
        kind: "turn-finalized",
        occurredAt: new Date().toISOString(),
        stt: { durationMs: 320, provider: "assemblyai" },
        telephoneSessionId: "telephone-smoke-session-001",
        transcript: "Is Bountywell healthy?",
        turnId: "telephone-smoke-turn-001",
      });
      const action = result.actions.find(
        (candidate) => candidate.kind === "speak-semantic-response",
      );
      if (action?.kind !== "speak-semantic-response") {
        throw new Error("Expected a semantic telephone response");
      }

      await delay(750);
      await coordinator.receiveProviderEvent({
        deliveryId: "telephone-smoke-tts-delivery-001",
        durationMs: 20_185,
        kind: "provider-timing",
        occurredAt: new Date().toISOString(),
        provider: "inworld",
        stage: "tts",
        taskId: action.taskId,
      });

      const completed = await output.completed;
      expect(completed.stderr).toBe("");
      expect(completed).toMatchObject({ exitCode: 0, signal: null });
      expect(completed.stdout).toContain(
        '"timingStages":["stt","coordinator","tts"]',
      );
    } finally {
      await tasks.close();
    }
  }, 10_000);

  test("fails immediately when the semantic conclusion is wrong", async () => {
    const { coordinator, output, tasks } = await startTelephoneSmoke("fail");

    try {
      await output.waitFor("Waiting for a new telephone Bountywell inquiry");
      await coordinator.receiveProviderEvent({
        deliveryId: "telephone-smoke-wrong-turn-delivery-001",
        kind: "turn-finalized",
        occurredAt: new Date().toISOString(),
        stt: { durationMs: 320, provider: "assemblyai" },
        telephoneSessionId: "telephone-smoke-wrong-session-001",
        transcript: "Is Bountywell healthy?",
        turnId: "telephone-smoke-wrong-turn-001",
      });

      const completed = await output.completed;
      expect(completed).toMatchObject({ exitCode: 1, signal: null });
      expect(completed.stderr).toContain(
        "Bountywell API health could not be confirmed.",
      );
    } finally {
      await tasks.close();
    }
  }, 10_000);
});

async function startTelephoneSmoke(
  primaryOutcome: "fail" | "pass" = "pass",
): Promise<{
  readonly coordinator: TelephoneSessionCoordinator;
  readonly output: ReturnType<typeof captureProcess>;
  readonly tasks: DurableTaskRuntime;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "voice-agent-telephone-smoke-"),
  );
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const fixture = await createInquiryFixture(databasePath, primaryOutcome);
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", smokePath],
    {
      cwd: dirname(smokePath),
      env: { ...process.env, VOICE_AGENT_DATABASE_PATH: databasePath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  childProcesses.push(child);
  return { ...fixture, output: captureProcess(child) };
}

async function createInquiryFixture(
  databasePath: string,
  primaryOutcome: "fail" | "pass" = "pass",
): Promise<{
  readonly coordinator: TelephoneSessionCoordinator;
  readonly tasks: DurableTaskRuntime;
}> {
  const store = createSqliteDurableTaskStore(databasePath);
  await store.registerBountywell(new Date().toISOString());
  const ids = Array.from(
    { length: 12 },
    (_, index) => `telephone-smoke-id-${index + 1}`,
  );
  const tasks = createDurableTaskRuntime({
    applicationRegistry: store,
    healthObserver: {
      async observe() {
        return {
          checks: [
            {
              facts: { statusCode: primaryOutcome === "pass" ? 200 : 503 },
              outcome: primaryOutcome,
              source: "public-health" as const,
              summary:
                primaryOutcome === "pass"
                  ? "The public health endpoint responded successfully."
                  : "The public health endpoint did not respond successfully.",
            },
            {
              facts: { statusCode: 401 },
              outcome: "pass" as const,
              source: "authentication-boundary" as const,
              summary: "The protected data endpoint required authentication.",
            },
          ],
          observedAt: new Date().toISOString(),
          rejectedEvidenceCount: 0,
        };
      },
    },
    nextId() {
      const id = ids.shift();
      if (id === undefined) throw new Error("Smoke fixture exhausted its IDs");
      return id;
    },
    now: () => new Date().toISOString(),
    store,
  });
  return {
    coordinator: createTelephoneSessionCoordinator({
      recognitionModel: defaultRecognizedSpeechModel,
      interpreter: {
        async interpret() {
          return {
            durationMs: 25,
            intent: "bountywell-health" as const,
            provider: "deterministic-regression",
          };
        },
      },
      tasks,
    }),
    tasks,
  };
}

function captureProcess(child: ChildProcess): {
  readonly completed: Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
    readonly stdout: string;
  }>;
  readonly waitFor: (text: string) => Promise<void>;
} {
  let stdout = "";
  let stderr = "";
  const waiters = new Map<string, () => void>();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    for (const [text, resolve] of waiters) {
      if (stdout.includes(text)) {
        waiters.delete(text);
        resolve();
      }
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    completed: new Promise((resolve) => {
      child.on("close", (exitCode, signal) => {
        resolve({ exitCode, signal, stderr, stdout });
      });
    }),
    waitFor(text) {
      if (stdout.includes(text)) return Promise.resolve();
      return new Promise((resolve) => waiters.set(text, resolve));
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
