import Database from "better-sqlite3";

import {
  bountywellHealthInquirySchema,
  bountywellHealthObservationSchema,
  evidenceRecordProjectionSchema,
  type BountywellHealthObserver,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";

export interface DurableTaskRuntime {
  submitBountywellHealthInquiry(request: {
    readonly requestId: string;
    readonly question: string;
  }): Promise<EvidenceRecordProjection>;
  getEvidenceRecord(taskId: string): Promise<EvidenceRecordProjection | undefined>;
  close(): Promise<void>;
}

export interface DurableTaskRuntimeOptions {
  readonly databasePath: string;
  readonly healthObserver: BountywellHealthObserver;
  readonly nextId: () => string;
  readonly now: () => string;
}

interface TaskRow {
  readonly conclusion: string;
  readonly created_at: string;
  readonly id: string;
  readonly kind: "bountywell.health.inquiry";
  readonly question: string;
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

export function createDurableTaskRuntime(
  options: DurableTaskRuntimeOptions,
): DurableTaskRuntime {
  const database = new Database(options.databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const findTaskByRequest = database.prepare<
    [requestId: string],
    TaskRow
  >(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE request_id = ?
  `);
  const findTaskById = database.prepare<[taskId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE id = ?
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

  const persistCompletedInquiry = database.transaction(
    (record: EvidenceRecordProjection, requestId: string, operationId: string) => {
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

    async getEvidenceRecord(taskId) {
      const task = findTaskById.get(taskId);
      return task === undefined ? undefined : loadRecord(task);
    },

    async submitBountywellHealthInquiry(request) {
      const normalizedRequest = bountywellHealthInquirySchema.safeParse(request);
      if (!normalizedRequest.success) {
        throw new Error("Unsupported Bountywell health inquiry");
      }

      const existingTask = findTaskByRequest.get(normalizedRequest.data.requestId);
      if (existingTask !== undefined) {
        return loadRecord(existingTask);
      }

      const taskId = options.nextId();
      const operationId = options.nextId();
      const eventIds = Array.from({ length: 5 }, () => options.nextId());
      const acceptedAt = options.now();
      const observation = bountywellHealthObservationSchema.parse(
        await options.healthObserver.observe({ operationId, taskId }),
      );
      const conclusion = observation.checks.every(
        (check) => check.outcome === "pass",
      )
        ? "Bountywell API is healthy."
        : "Bountywell API health could not be confirmed.";

      const record: EvidenceRecordProjection = {
        evidence: [
          {
            details: { requestId: normalizedRequest.data.requestId },
            id: requireEventId(eventIds, 0),
            kind: "task.accepted",
            occurredAt: acceptedAt,
            sequence: 1,
            summary: "Bountywell health inquiry accepted.",
          },
          {
            details: { operationId },
            id: requireEventId(eventIds, 1),
            kind: "operation.accepted",
            occurredAt: acceptedAt,
            sequence: 2,
            summary: "Read-only Bountywell health observation accepted.",
          },
          {
            details: {
              checks: observation.checks,
              rejectedEvidenceCount: observation.rejectedEvidenceCount,
            },
            id: requireEventId(eventIds, 2),
            kind: "evidence.observed",
            occurredAt: observation.observedAt,
            sequence: 3,
            summary: "Bounded Bountywell health evidence observed.",
          },
          {
            details: { operationId },
            id: requireEventId(eventIds, 3),
            kind: "operation.completed",
            occurredAt: observation.observedAt,
            sequence: 4,
            summary: "Read-only Bountywell health observation completed.",
          },
          {
            details: {},
            id: requireEventId(eventIds, 4),
            kind: "task.completed",
            occurredAt: observation.observedAt,
            sequence: 5,
            summary: conclusion,
          },
        ],
        task: {
          conclusion,
          createdAt: acceptedAt,
          id: taskId,
          kind: "bountywell.health.inquiry",
          question: normalizedRequest.data.question,
          status: "completed",
          updatedAt: observation.observedAt,
        },
      };

      persistCompletedInquiry(record, normalizedRequest.data.requestId, operationId);
      return record;
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
  `);
}

function requireEventId(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`Missing deterministic event identifier at index ${index}`);
  }
  return id;
}
