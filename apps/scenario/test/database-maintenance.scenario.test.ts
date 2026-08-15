import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  backupSqliteDatabase,
  createSqliteAuthenticationStore,
  createSqliteDurableTaskStore,
  restoreSqliteDatabase,
  verifyVoiceAgentDatabase,
} from "@voice-agent/sqlite-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a verified pre-migration backup can restore before the candidate schema is reapplied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-backup-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const backupPath = join(directory, "pre-migration.sqlite");
  const initialStore = createSqliteAuthenticationStore(databasePath);
  await initialStore.close();

  await backupSqliteDatabase(databasePath, backupPath);

  const changedStore = createSqliteDurableTaskStore(databasePath);
  await changedStore.persistAcceptedInquiry({
    operationId: "operation-after-backup",
    record: {
      evidence: [
        {
          details: { requestId: "request-after-backup" },
          id: "event-after-backup-1",
          kind: "task.accepted",
          occurredAt: "2026-08-15T12:01:00.000Z",
          sequence: 1,
          summary: "Bountywell health inquiry accepted.",
        },
        {
          details: { operationId: "operation-after-backup" },
          id: "event-after-backup-2",
          kind: "operation.accepted",
          occurredAt: "2026-08-15T12:01:00.000Z",
          sequence: 2,
          summary: "Read-only Bountywell health observation accepted.",
        },
      ],
      task: {
        conclusion: "Bountywell inquiry is pending.",
        createdAt: "2026-08-15T12:01:00.000Z",
        id: "task-after-backup",
        kind: "bountywell.health.inquiry",
        question: "Is Bountywell healthy?",
        status: "pending",
        updatedAt: "2026-08-15T12:01:00.000Z",
      },
    },
    requestId: "request-after-backup",
  });
  await changedStore.close();

  await restoreSqliteDatabase(backupPath, databasePath);
  expect(() => verifyVoiceAgentDatabase(databasePath)).toThrow(
    "missing table",
  );
  const migratedStore = createSqliteDurableTaskStore(databasePath);
  await migratedStore.close();
  verifyVoiceAgentDatabase(databasePath);
  const restoredStore = createSqliteDurableTaskStore(databasePath);
  try {
    expect(await restoredStore.findByTaskId("task-after-backup")).toBeUndefined();
    expect(await restoredStore.findBountywellRegistration()).toBeUndefined();
  } finally {
    await restoredStore.close();
  }
});
