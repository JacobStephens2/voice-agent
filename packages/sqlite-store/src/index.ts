import Database from "better-sqlite3";

import {
  evidenceRecordProjectionSchema,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import type {
  CompletedInquiryPersistence,
  DurableTaskStore,
} from "@voice-agent/durable-store";

interface TaskRow {
  readonly conclusion: string;
  readonly created_at: string;
  readonly id: string;
  readonly kind: "bountywell.health.inquiry";
  readonly question: "Is Bountywell healthy?";
  readonly status: "completed";
  readonly updated_at: string;
}

interface EvidenceEventRow {
  readonly details_json: string;
  readonly id: string;
  readonly kind: EvidenceEventProjection["kind"];
  readonly occurred_at: string;
  readonly sequence: number;
  readonly summary: string;
}

export function createSqliteDurableTaskStore(
  databasePath: string,
): DurableTaskStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const findTaskByRequest = database.prepare<[requestId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE request_id = ?
  `);
  const findTaskById = database.prepare<[taskId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE id = ?
  `);
  const findTaskByOperation = database.prepare<[operationId: string], TaskRow>(`
    SELECT
      durable_tasks.id,
      durable_tasks.kind,
      durable_tasks.status,
      durable_tasks.question,
      durable_tasks.conclusion,
      durable_tasks.created_at,
      durable_tasks.updated_at
    FROM operations
    JOIN durable_tasks ON durable_tasks.id = operations.task_id
    WHERE operations.id = ?
  `);
  const findEventsByTask = database.prepare<
    [taskId: string],
    EvidenceEventRow
  >(`
    SELECT id, sequence, kind, occurred_at, summary, details_json
    FROM evidence_events
    WHERE task_id = ?
    ORDER BY sequence
  `);

  const persistTransaction = database.transaction(
    ({ record, requestId, operationId }: CompletedInquiryPersistence) => {
      database
        .prepare(
          `
            INSERT INTO durable_tasks (
              id, request_id, kind, status, question, conclusion, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.task.id,
          requestId,
          record.task.kind,
          record.task.status,
          record.task.question,
          record.task.conclusion,
          record.task.createdAt,
          record.task.updatedAt,
        );

      database
        .prepare(
          `
            INSERT INTO operations (
              id, task_id, idempotency_key, kind, status, result_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          operationId,
          record.task.id,
          `${requestId}:bountywell.health.observe`,
          "bountywell.health.observe",
          "completed",
          JSON.stringify({ conclusion: record.task.conclusion }),
          record.task.createdAt,
          record.task.updatedAt,
        );

      const insertEvent = database.prepare(`
        INSERT INTO evidence_events (
          id, task_id, sequence, kind, occurred_at, summary, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of record.evidence) {
        insertEvent.run(
          event.id,
          record.task.id,
          event.sequence,
          event.kind,
          event.occurredAt,
          event.summary,
          JSON.stringify(event.details),
        );
      }
    },
  );

  function loadRecord(task: TaskRow): EvidenceRecordProjection {
    return evidenceRecordProjectionSchema.parse({
      evidence: findEventsByTask.all(task.id).map((event) => ({
        details: JSON.parse(event.details_json) as unknown,
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurred_at,
        sequence: event.sequence,
        summary: event.summary,
      })),
      task: {
        conclusion: task.conclusion,
        createdAt: task.created_at,
        id: task.id,
        kind: task.kind,
        question: task.question,
        status: task.status,
        updatedAt: task.updated_at,
      },
    });
  }

  return {
    async close() {
      database.close();
    },
    async findByRequestId(requestId) {
      const task = findTaskByRequest.get(requestId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async findByOperationId(operationId) {
      const task = findTaskByOperation.get(operationId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async findByTaskId(taskId) {
      const task = findTaskById.get(taskId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async persistCompletedInquiry(input) {
      persistTransaction(input);
    },
  };
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_tasks (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES durable_tasks(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES durable_tasks(id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      UNIQUE (task_id, sequence)
    );

    CREATE TRIGGER IF NOT EXISTS evidence_events_no_update
    BEFORE UPDATE ON evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Evidence Events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS evidence_events_no_delete
    BEFORE DELETE ON evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Evidence Events are append-only');
    END;
  `);
}
