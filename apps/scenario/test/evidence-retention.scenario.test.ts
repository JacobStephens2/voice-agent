import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";
import { createDurableTaskRuntime } from "@voice-agent/runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("the lifecycle policy removes ordinary Evidence Events but preserves durable identities", async () => {
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
  await store.appendEvidence({
    event: {
      details: {
        responseId: "recent-response",
        text: "A recent retained semantic response.",
      },
      id: "recent-event",
      kind: "telephone.semantic.response",
      occurredAt: "2026-07-01T00:00:00.000Z",
      summary: "A recent response remains inside the retention window.",
    },
    taskId: "task-expired",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  try {
    expect(await store.findByTaskId("task-expired")).toBeDefined();
    await store.applyEvidenceRetention({
      cutoff: "2026-01-01T00:00:00.000Z",
    });
    expect(await store.findByTaskId("task-expired")).toMatchObject({
      evidence: [
        expect.objectContaining({
          id: "recent-event",
          kind: "telephone.semantic.response",
        }),
      ],
      task: { id: "task-expired" },
    });
    expect(await store.findByOperationId("operation-expired")).toMatchObject({
      task: { id: "task-expired" },
    });
    expect(await store.listTasks()).toHaveLength(1);
    expect(await store.findByRequestId("request-expired")).toMatchObject({
      task: { id: "task-expired" },
    });
    expect(await store.readOperationalMetrics()).toMatchObject({
      operations: { accepted: 1, completed: 0, running: 0 },
      tasks: { completed: 0, pending: 1 },
    });
    const ids = ["post-retention-observation", "post-retention-operation", "post-retention-task"];
    const runtime = createDurableTaskRuntime({
      healthObserver: {
        async observe() {
          return {
            checks: [
              {
                facts: { statusCode: 200 },
                outcome: "pass" as const,
                source: "public-health" as const,
                summary: "The public health endpoint responded successfully.",
              },
            ],
            observedAt: "2026-08-01T00:00:00.000Z",
            rejectedEvidenceCount: 0,
          };
        },
      },
      nextId() {
        const id = ids.shift();
        if (id === undefined) throw new Error("Missing retention test id");
        return id;
      },
      now: () => "2026-08-01T00:00:00.000Z",
      store,
    });
    const completed = await runtime.processNextBountywellHealthInquiry();
    expect(completed?.task.status).toBe("completed");
    expect(completed?.evidence.map((event) => event.sequence)).toEqual([
      3, 4, 5, 6,
    ]);
  } finally {
    await store.close();
  }
});
