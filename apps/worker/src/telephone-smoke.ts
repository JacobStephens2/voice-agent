import { telephoneSpeechProviderStages } from "@voice-agent/contracts";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

const databasePath = requireEnvironment("VOICE_AGENT_DATABASE_PATH");
const store = createSqliteDurableTaskStore(databasePath);
const startedAt = new Date().toISOString();
const deadline = Date.now() + 3 * 60 * 1_000;

try {
  process.stdout.write(
    "Waiting for a new telephone Bountywell inquiry. Ask whether Bountywell is healthy now.\n",
  );
  while (Date.now() < deadline) {
    const summaries = await store.listTasks();
    const candidates = summaries.filter(
      (summary) =>
        summary.createdAt >= startedAt &&
        summary.kind === "bountywell.health.inquiry",
    );
    for (const candidate of candidates) {
      const record = await store.findByTaskId(candidate.id);
      if (record?.task.status !== "completed") continue;
      if (record.task.conclusion !== "Bountywell API is healthy.") {
        throw new Error(record.task.conclusion);
      }
      const kinds = new Set(record.evidence.map((event) => event.kind));
      const hasRequiredEvidence = ([
        "telephone.turn.finalized",
        "telephone.provider.timing",
        "task.accepted",
        "operation.accepted",
        "evidence.observed",
        "operation.completed",
        "task.completed",
        "telephone.semantic.response",
      ] as const).every((requiredKind) => kinds.has(requiredKind));
      if (!hasRequiredEvidence) continue;
      const timingStages = new Set(
        record.evidence.flatMap((event) =>
          event.kind === "telephone.provider.timing"
            ? [event.details.stage]
            : [],
        ),
      );
      const hasRequiredTiming = telephoneSpeechProviderStages.every(
        (requiredStage) => timingStages.has(requiredStage),
      );
      if (!hasRequiredTiming) continue;
      const observed = record.evidence.find(
        (event) => event.kind === "evidence.observed",
      );
      if (observed?.kind !== "evidence.observed") {
        throw new Error("The telephone inquiry has no bounded observation");
      }
      const sources = new Set(observed.details.checks.map((check) => check.source));
      if (
        !sources.has("public-health") ||
        !sources.has("authentication-boundary")
      ) {
        throw new Error(
          "The telephone answer omitted primary or authentication-boundary evidence",
        );
      }
      const operation = record.evidence.find(
        (event) => event.kind === "operation.accepted",
      );
      const response = record.evidence.find(
        (event) => event.kind === "telephone.semantic.response",
      );
      if (
        operation?.kind !== "operation.accepted" ||
        response?.kind !== "telephone.semantic.response"
      ) {
        throw new Error("The telephone answer omitted Operation or speech evidence");
      }
      process.stdout.write(
        `${JSON.stringify({
          conclusion: record.task.conclusion,
          operationId: operation.details.operationId,
          responseId: response.details.responseId,
          taskId: record.task.id,
          timingStages: [...timingStages],
        })}\n`,
      );
      process.exitCode = 0;
      break;
    }
    if (process.exitCode === 0) break;
    await delay(500);
  }
  if (process.exitCode === undefined) {
    throw new Error(
      "No new completed telephone Bountywell inquiry arrived within three minutes",
    );
  }
} finally {
  await store.close();
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
