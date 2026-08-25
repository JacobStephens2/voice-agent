import { mkdtemp, rm } from "node:fs/promises";
import { defaultRecognizedSpeechModel } from "@voice-agent/contracts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import type { KeeploreRegistration } from "@voice-agent/contracts";
import {
  createKeeploreDelegationRuntime,
  createTelephoneSessionCoordinator,
} from "@voice-agent/runtime";
import {
  createSqliteDurableTaskStore,
  createSqliteKeeploreDelegationStore,
} from "@voice-agent/sqlite-store";

const now = "2026-08-24T14:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("the Keeplore readback records telephone evidence under the Delegation's Durable Task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-identity-"));
  directories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const taskStore = createSqliteDurableTaskStore(databasePath);
  const delegationStore = createSqliteKeeploreDelegationStore(databasePath);
  const ids = ["task-button-trial", "delegation-button-trial"];
  const keeploreDelegations = createKeeploreDelegationRuntime({
    nextId: () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("identifiers exhausted");
      return id;
    },
    now: () => now,
    registration: keeploreRegistration(),
    runner: {
      async execute() {
        throw new Error("the runner is outside this repro");
      },
    },
    sourceCommit: "1111111111111111111111111111111111111111",
    store: delegationStore,
  });
  const coordinator = createTelephoneSessionCoordinator({
    recognitionModel: defaultRecognizedSpeechModel,
    interpreter: {
      async interpret(input) {
        return {
          durationMs: 1,
          intent: /^stop[.!]?$/iu.test(input.text.trim())
            ? ("stop" as const)
            : ("state-changing" as const),
          provider: "deterministic-keeplore-identity-repro",
        };
      },
    },
    keeploreDelegations,
    stateChangingTasks: {
      async claim() {
        return {
          decision: "accepted" as const,
          resource: "state-changing-task" as const,
        };
      },
      async release() {
        return {};
      },
    },
    tasks: {
      appendTelephoneEvidence: (input) =>
        taskStore.appendEvidence({ ...input, updatedAt: input.event.occurredAt }),
      async submitTelephoneBountywellHealthInquiry() {
        throw new Error("Bountywell inquiry is outside this repro");
      },
    },
  });

  await coordinator.receiveProviderEvent({
    deliveryId: "delivery:turn-request",
    kind: "turn-finalized",
    occurredAt: now,
    stt: { durationMs: 1, provider: "repro-stt" },
    telephoneSessionId: "telephone-session-repro",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-request",
  });
  const confirmed = await coordinator.receiveProviderEvent({
    deliveryId: "delivery:turn-confirm",
    kind: "turn-finalized",
    occurredAt: now,
    stt: { durationMs: 1, provider: "repro-stt" },
    telephoneSessionId: "telephone-session-repro",
    transcript: "Yes.",
    turnId: "turn-confirm",
  });
  const spoken = confirmed.actions[0];
  if (spoken?.kind !== "offer-completion-callback") {
    throw new Error("the confirmation did not produce the delegation readback");
  }

  // What the worker does once the readback has finished playing.
  await coordinator.receiveProviderEvent({
    deliveryId: "tts-timing:turn-confirm:delegation-response",
    durationMs: 8_000,
    kind: "provider-timing",
    occurredAt: now,
    provider: "inworld",
    stage: "tts",
    taskId: spoken.taskId,
  });

  const record = await taskStore.findByTaskId(spoken.taskId);
  expect(record?.task).toMatchObject({
    id: spoken.taskId,
    kind: "keeplore.button-trial",
    question:
      "Make Keeplore's table-view Get Rid Of control match the row-level Remove control without changing card view.",
    status: "pending",
  });
  expect(record?.evidence).toMatchObject([
    {
      details: { responseId: "turn-confirm:delegation-response" },
      kind: "telephone.semantic.response",
    },
    {
      details: {
        durationMs: 8_000,
        outcome: "completed",
        provider: "inworld",
        stage: "tts",
      },
      kind: "telephone.provider.timing",
    },
  ]);

  taskStore.close();
  delegationStore.close();
});

function keeploreRegistration(): KeeploreRegistration {
  return {
    applicationId: "keeplore-production",
    deploymentBoundaries: {
      liveCheckoutPath: "/var/www/keeplore.app",
      releaseRoot: "/opt/keeplore/releases",
      retainedReleases: 2,
      sharedRoot: "/opt/keeplore/shared",
      sourceMirrorPath: "/var/lib/keeplore-source/repository.git",
    },
    permittedSubagentProvider: "codex",
    productionBranch: "main",
    readScope: ["**/*.php", "**/*.js", "**/*.css"],
    registeredAt: "2026-08-21T12:00:00.000Z",
    registeredBy: "fresh-passkey-action",
    repository: "JacobStephens2/keeplore",
    revision: 1,
    verification: {
      checkName: "keeplore-verification",
      command: "vendor/bin/phpunit",
    },
    worktreeRoot: "/var/lib/voice-agent-worktrees/keeplore",
  };
}
