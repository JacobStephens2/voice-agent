import { createSqliteCallbackHandshakeStore } from "@voice-agent/sqlite-store";

const databasePath = requireEnvironment("VOICE_AGENT_DATABASE_PATH");
const store = createSqliteCallbackHandshakeStore(databasePath);
const startedAt = new Date().toISOString();
const deadline = Date.now() + 3 * 60 * 1_000;

try {
  process.stdout.write(
    "Waiting for a new Callback Handshake. Ring the dedicated number now.\n",
  );
  while (Date.now() < deadline) {
    const summaries = await store.listEvidenceRecords();
    const candidates = summaries.filter(
      (summary) => summary.createdAt >= startedAt,
    );
    for (const candidate of candidates) {
      const record = await store.findEvidenceRecord(candidate.id);
      if (record?.session.outcome === "authorized") {
        const kinds = new Set(record.evidence.map((event) => event.kind));
        for (const requiredKind of [
          "telephone.inbound.received",
          "telephone.inbound.notice",
          "telephone.callback.requested",
          "telephone.machine.detected",
          "telephone.dtmf.received",
          "telephone.callback.outcome",
          "telephone.session.authorized",
        ] as const) {
          if (!kinds.has(requiredKind)) {
            throw new Error(
              `The Callback Handshake omitted ${requiredKind} evidence`,
            );
          }
        }
        process.stdout.write(
          `${JSON.stringify({
            authorizedAt: record.session.authorizedAt,
            evidenceKinds: [...kinds],
            evidenceRecordId: record.task.id,
            telephoneSessionId: record.session.id,
          })}\n`,
        );
        process.exitCode = 0;
        break;
      }
    }
    if (process.exitCode === 0) break;
    await delay(500);
  }
  if (process.exitCode === undefined) {
    throw new Error(
      "No new authorized Callback Handshake completed within three minutes",
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
