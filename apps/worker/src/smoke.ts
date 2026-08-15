import { randomUUID } from "node:crypto";

import { createUnixSocketBountywellObserver } from "@voice-agent/operations-broker";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

const databasePath = requireEnvironment("VOICE_AGENT_DATABASE_PATH");
const socketPath = requireEnvironment("VOICE_AGENT_BROKER_SOCKET_PATH");
const requestId = requireEnvironment("VOICE_AGENT_SMOKE_REQUEST_ID");
const store = createSqliteDurableTaskStore(databasePath);
const runtime = createDurableTaskRuntime({
  applicationRegistry: store,
  healthObserver: createUnixSocketBountywellObserver(socketPath),
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store,
});

try {
  if ((await runtime.getBountywellRegistration()) === undefined) {
    throw new Error("Bountywell must be registered through a Fresh Passkey Action");
  }
  const accepted = await runtime.acceptBountywellHealthInquiry({
    question: "Is Bountywell healthy?",
    requestId,
  });
  let record = accepted;
  const deadline = Date.now() + 15_000;
  while (record.task.status !== "completed" && Date.now() < deadline) {
    await runtime.processNextBountywellHealthInquiry();
    record =
      (await runtime.getEvidenceRecord(accepted.task.id)) ?? accepted;
    if (record.task.status !== "completed") await delay(250);
  }
  if (record.task.status !== "completed") {
    throw new Error("The production inquiry did not complete within 15 seconds");
  }
  const observed = record.evidence.find(
    (event) => event.kind === "evidence.observed",
  );
  const operation = record.evidence.find(
    (event) => event.kind === "operation.accepted",
  );
  if (observed?.kind !== "evidence.observed") {
    throw new Error("The production inquiry has no bounded observation");
  }
  if (operation?.kind !== "operation.accepted") {
    throw new Error("The production inquiry has no Operation identity");
  }
  const sources = new Set(observed.details.checks.map((check) => check.source));
  for (const requiredSource of [
    "public-health",
    "authentication-boundary",
    "local-health",
    "service-state",
    "resource-health",
  ] as const) {
    if (!sources.has(requiredSource)) {
      throw new Error(`The production inquiry omitted ${requiredSource}`);
    }
  }
  if (record.task.conclusion !== "Bountywell API is healthy.") {
    throw new Error(record.task.conclusion);
  }
  process.stdout.write(
    `${JSON.stringify({
      conclusion: record.task.conclusion,
      observedAt: observed.occurredAt,
      operationId: operation.details.operationId,
      sources: [...sources],
      taskId: record.task.id,
      uncertainty: observed.details.uncertainty ?? null,
    })}\n`,
  );
} finally {
  await runtime.close();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
