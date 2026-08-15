import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("Evidence Records leave the live PWA window after 90 days without breaking idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-retention-"));
  temporaryDirectories.push(directory);
  const store = createSqliteDurableTaskStore(join(directory, "tasks.sqlite"));
  await store.persistAcceptedInquiry({
    operationId: "operation-expired",
    record: {
      evidence: [
        {
          details: { requestId: "request-expired" },
          id: "event-expired-1",
          kind: "task.accepted",
          occurredAt: "2000-01-01T00:00:00.000Z",
          sequence: 1,
          summary: "Bountywell health inquiry accepted.",
        },
        {
          details: { operationId: "operation-expired" },
          id: "event-expired-2",
          kind: "operation.accepted",
          occurredAt: "2000-01-01T00:00:00.000Z",
          sequence: 2,
          summary: "Read-only Bountywell health observation accepted.",
        },
      ],
      task: {
        conclusion: "Bountywell inquiry is pending.",
        createdAt: "2000-01-01T00:00:00.000Z",
        id: "task-expired",
        kind: "bountywell.health.inquiry",
        question: "Is Bountywell healthy?",
        status: "pending",
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    },
    requestId: "request-expired",
  });
  try {
    expect(await store.findByTaskId("task-expired")).toBeUndefined();
    expect(await store.findByOperationId("operation-expired")).toBeUndefined();
    expect(await store.listTasks()).toEqual([]);
    expect(await store.findByRequestId("request-expired")).toEqual({
      expired: true,
    });
    expect(await store.readOperationalMetrics()).toMatchObject({
      operations: { accepted: 0, completed: 0, running: 0 },
      tasks: { completed: 0, pending: 0 },
    });
  } finally {
    await store.close();
  }
});
