import Database from "better-sqlite3";
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import {
  bountywellHealthObservationSchema,
  bountywellRegistrationSchema,
  evidenceRecordProjectionSchema,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import type {
  AcceptedInquiryPersistence,
  ApplicationRegistry,
  ClaimedBountywellOperation,
  CompletedInquiryPersistence,
  DurableTaskStore,
} from "@voice-agent/durable-store";
import { createBountywellReadRegistration } from "@voice-agent/policy";

export { createSqliteAuthenticationStore } from "./authentication.ts";
export { createSqliteCallbackHandshakeStore } from "./callback-handshake.ts";
export {
  backupSqliteDatabase,
  restoreSqliteDatabase,
  verifyVoiceAgentDatabase,
} from "./database-maintenance.ts";

interface TaskRow {
  readonly conclusion: string;
  readonly created_at: string;
  readonly id: string;
  readonly kind: "bountywell.health.inquiry";
  readonly question: "Is Bountywell healthy?";
  readonly status: "completed" | "pending";
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

interface OperationRow {
  readonly id: string;
  readonly status: "accepted" | "completed" | "running";
  readonly task_id: string;
}

const liveEvidenceRetentionDays = 90;

export function createSqliteDurableTaskStore(
  databasePath: string,
): DurableTaskStore & ApplicationRegistry {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const findTaskByRequest = database.prepare<[requestId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE request_id = ?
  `);
  const findExpiredRequest = database.prepare<
    [requestId: string],
    { readonly request_id: string }
  >(`
    SELECT request_id FROM expired_request_ids WHERE request_id = ?
  `);
  const findLiveTaskByRequest = database.prepare<[requestId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE request_id = ?
      AND created_at >= strftime(
        '%Y-%m-%dT%H:%M:%fZ', 'now', '-${liveEvidenceRetentionDays} days'
      )
  `);
  const findTaskById = database.prepare<[taskId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE id = ?
  `);
  const findLiveTaskById = database.prepare<[taskId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE id = ?
      AND created_at >= strftime(
        '%Y-%m-%dT%H:%M:%fZ', 'now', '-${liveEvidenceRetentionDays} days'
      )
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
  const listTasks = database.prepare<[], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at
    FROM durable_tasks
    WHERE created_at >= strftime(
      '%Y-%m-%dT%H:%M:%fZ', 'now', '-${liveEvidenceRetentionDays} days'
    )
    ORDER BY updated_at DESC
    LIMIT 100
  `);
  const findRegistration = database.prepare<[], { definition_json: string }>(`
    SELECT definition_json
    FROM application_registrations
    WHERE application_id = 'bountywell-production'
    ORDER BY revision DESC
    LIMIT 1
  `);
  const insertRegistration = database.prepare(`
    INSERT INTO application_registrations (
      application_id, revision, registered_at, definition_json
    ) VALUES (?, ?, ?, ?)
  `);
  const insertTask = database.prepare(`
    INSERT INTO durable_tasks (
      id, request_id, kind, status, question, conclusion, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOperation = database.prepare(`
    INSERT INTO operations (
      id, task_id, idempotency_key, kind, status, result_json,
      created_at, updated_at, lease_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO evidence_events (
      id, task_id, sequence, kind, occurred_at, summary, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const findClaimableOperation = database.prepare<
    [claimedAt: string],
    OperationRow
  >(`
    SELECT id, task_id, status
    FROM operations
    WHERE kind = 'bountywell.health.observe'
      AND (
        status = 'accepted'
        OR (status = 'running' AND lease_expires_at <= ?)
      )
    ORDER BY created_at, id
    LIMIT 1
  `);
  const claimOperation = database.prepare(`
    UPDATE operations
    SET status = 'running', lease_expires_at = ?, updated_at = ?
    WHERE id = ?
      AND (
        status = 'accepted'
        OR (status = 'running' AND lease_expires_at <= ?)
      )
  `);
  const findOperation = database.prepare<[operationId: string], OperationRow>(`
    SELECT id, task_id, status
    FROM operations
    WHERE id = ?
  `);
  const completeOperation = database.prepare(`
    UPDATE operations
    SET status = 'completed', result_json = ?, updated_at = ?,
      lease_expires_at = NULL
    WHERE id = ? AND task_id = ? AND status = 'running'
  `);
  const completeTask = database.prepare(`
    UPDATE durable_tasks
    SET status = 'completed', conclusion = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const readTaskMetrics = database.prepare<
    [],
    { readonly completed: number; readonly pending: number }
  >(`
    SELECT
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM durable_tasks
  `);
  const readOperationMetrics = database.prepare<
    [],
    {
      readonly accepted: number;
      readonly completed: number;
      readonly running: number;
    }
  >(`
    SELECT
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM operations
  `);
  const readPolicyDenials = database.prepare<
    [],
    { readonly value: number }
  >(`
    SELECT value FROM operational_counters WHERE name = 'policy_denials'
  `);
  const incrementPolicyDenials = database.prepare(`
    INSERT INTO operational_counters (name, value)
    VALUES ('policy_denials', 1)
    ON CONFLICT(name) DO UPDATE SET value = value + 1
  `);
  const readLatestObservation = database.prepare<
    [],
    { readonly details_json: string }
  >(`
    SELECT details_json
    FROM evidence_events
    WHERE kind = 'evidence.observed'
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `);
  const tombstoneExpiredRequests = database.prepare(`
    INSERT OR IGNORE INTO expired_request_ids (request_id, expired_at)
    SELECT request_id, ?
    FROM durable_tasks
    WHERE created_at < ?
  `);
  const deleteExpiredEvents = database.prepare(`
    DELETE FROM evidence_events
    WHERE task_id IN (
      SELECT id FROM durable_tasks WHERE created_at < ?
    )
  `);
  const deleteExpiredOperations = database.prepare(`
    DELETE FROM operations
    WHERE task_id IN (
      SELECT id FROM durable_tasks WHERE created_at < ?
    )
  `);
  const deleteExpiredTasks = database.prepare(`
    DELETE FROM durable_tasks WHERE created_at < ?
  `);

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

  function insertEvidence(
    taskId: string,
    evidence: readonly EvidenceEventProjection[],
  ): void {
    for (const event of evidence) {
      insertEvent.run(
        event.id,
        taskId,
        event.sequence,
        event.kind,
        event.occurredAt,
        event.summary,
        JSON.stringify(event.details),
      );
    }
  }

  const persistAcceptedTransaction = database.transaction(
    ({ record, requestId, operationId }: AcceptedInquiryPersistence) => {
      insertTask.run(
        record.task.id,
        requestId,
        record.task.kind,
        record.task.status,
        record.task.question,
        record.task.conclusion,
        record.task.createdAt,
        record.task.updatedAt,
      );
      insertOperation.run(
        operationId,
        record.task.id,
        `${requestId}:bountywell.health.observe`,
        "bountywell.health.observe",
        "accepted",
        "{}",
        record.task.createdAt,
        record.task.updatedAt,
      );
      insertEvidence(record.task.id, record.evidence);
      return loadRecord(requireTask(findTaskById.get(record.task.id)));
    },
  );

  const claimTransaction = database.transaction(
    (input: {
      readonly claimedAt: string;
      readonly leaseExpiresAt: string;
    }): ClaimedBountywellOperation | undefined => {
      const operation = findClaimableOperation.get(input.claimedAt);
      if (operation === undefined) return undefined;
      const result = claimOperation.run(
        input.leaseExpiresAt,
        input.claimedAt,
        operation.id,
        input.claimedAt,
      );
      return result.changes === 1
        ? { operationId: operation.id, taskId: operation.task_id }
        : undefined;
    },
  );

  const completeTransaction = database.transaction(
    (input: CompletedInquiryPersistence): EvidenceRecordProjection => {
      const operation = findOperation.get(input.operationId);
      if (operation === undefined || operation.task_id !== input.taskId) {
        throw new Error("Claimed Bountywell Operation is unavailable");
      }
      if (operation.status === "completed") {
        return loadRecord(
          requireTask(findTaskByOperation.get(input.operationId)),
        );
      }
      const operationResult = completeOperation.run(
        JSON.stringify({ conclusion: input.conclusion }),
        input.observedAt,
        input.operationId,
        input.taskId,
      );
      const taskResult = completeTask.run(
        input.conclusion,
        input.observedAt,
        input.taskId,
      );
      if (operationResult.changes !== 1 || taskResult.changes !== 1) {
        throw new Error("Claimed Bountywell Operation changed concurrently");
      }
      insertEvidence(input.taskId, input.evidence);
      return loadRecord(requireTask(findTaskById.get(input.taskId)));
    },
  );

  const expireTransaction = database.transaction((cutoff: string) => {
    tombstoneExpiredRequests.run(cutoff, cutoff);
    deleteExpiredEvents.run(cutoff);
    deleteExpiredOperations.run(cutoff);
    deleteExpiredTasks.run(cutoff);
  });
  function expireOldEvidence(): void {
    expireTransaction.immediate(
      new Date(
        Date.now() - liveEvidenceRetentionDays * 24 * 60 * 60 * 1_000,
      ).toISOString(),
    );
  }
  expireOldEvidence();

  return {
    async claimBountywellOperation(input) {
      expireOldEvidence();
      return claimTransaction.immediate(input);
    },
    async close() {
      database.close();
    },
    async completeBountywellInquiry(input) {
      expireOldEvidence();
      return completeTransaction.immediate(input);
    },
    async findByOperationId(operationId) {
      expireOldEvidence();
      const task = findTaskByOperation.get(operationId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async findByRequestId(requestId) {
      expireOldEvidence();
      const liveTask = findLiveTaskByRequest.get(requestId);
      if (liveTask !== undefined) return loadRecord(liveTask);
      return findExpiredRequest.get(requestId) === undefined
        ? undefined
        : { expired: true };
    },
    async findByTaskId(taskId) {
      expireOldEvidence();
      const task = findLiveTaskById.get(taskId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async findBountywellRegistration() {
      const row = findRegistration.get();
      return row === undefined
        ? undefined
        : bountywellRegistrationSchema.parse(JSON.parse(row.definition_json));
    },
    async listTasks() {
      expireOldEvidence();
      return listTasks.all().map((task) => ({
        conclusion:
          evidenceRecordProjectionSchema.shape.task.shape.conclusion.parse(
            task.conclusion,
          ),
        createdAt: task.created_at,
        id: task.id,
        kind: task.kind,
        question: task.question,
        status: task.status,
        updatedAt: task.updated_at,
      }));
    },
    async readOperationalMetrics() {
      expireOldEvidence();
      const taskMetrics = readTaskMetrics.get() ?? { completed: 0, pending: 0 };
      const operationMetrics = readOperationMetrics.get() ?? {
        accepted: 0,
        completed: 0,
        running: 0,
      };
      const latestObservation = readLatestObservation.get();
      let bountywellChecks: Array<{
        readonly outcome: "fail" | "pass";
        readonly source:
          | "authentication-boundary"
          | "local-health"
          | "public-health"
          | "resource-health"
          | "service-state";
      }> = [];
      if (latestObservation !== undefined) {
        const details = JSON.parse(latestObservation.details_json) as {
          readonly checks?: unknown;
        };
        const checks = bountywellHealthObservationSchema.shape.checks.safeParse(
          details.checks,
        );
        if (checks.success) {
          bountywellChecks = checks.data.map((check) => ({
            outcome: check.outcome,
            source: check.source,
          }));
        }
      }
      return {
        bountywellChecks,
        operations: {
          accepted: operationMetrics.accepted ?? 0,
          completed: operationMetrics.completed ?? 0,
          running: operationMetrics.running ?? 0,
        },
        policyDenials: readPolicyDenials.get()?.value ?? 0,
        storage: readStorageMetrics(databasePath),
        tasks: {
          completed: taskMetrics.completed ?? 0,
          pending: taskMetrics.pending ?? 0,
        },
      };
    },
    async recordPolicyDenial() {
      incrementPolicyDenials.run();
    },
    async persistAcceptedInquiry(input) {
      expireOldEvidence();
      if (findExpiredRequest.get(input.requestId) !== undefined) {
        throw new Error("Evidence Record retention expired");
      }
      try {
        return persistAcceptedTransaction.immediate(input);
      } catch (error) {
        const existing = findTaskByRequest.get(input.requestId);
        if (existing !== undefined && isSqliteConstraint(error)) {
          const liveExisting = findLiveTaskByRequest.get(input.requestId);
          if (liveExisting === undefined) {
            throw new Error("Evidence Record retention expired");
          }
          return loadRecord(liveExisting);
        }
        throw error;
      }
    },
    async registerBountywell(registeredAt) {
      const row = findRegistration.get();
      if (row !== undefined) {
        return bountywellRegistrationSchema.parse(JSON.parse(row.definition_json));
      }
      const registration = createBountywellReadRegistration(registeredAt);
      insertRegistration.run(
        registration.applicationId,
        registration.revision,
        registration.registeredAt,
        JSON.stringify(registration),
      );
      return registration;
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
      updated_at TEXT NOT NULL,
      lease_expires_at TEXT
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

    CREATE TABLE IF NOT EXISTS application_registrations (
      application_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      registered_at TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      PRIMARY KEY (application_id, revision)
    );

    CREATE TABLE IF NOT EXISTS operational_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK (value >= 0)
    );

    CREATE TABLE IF NOT EXISTS expired_request_ids (
      request_id TEXT PRIMARY KEY,
      expired_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS application_registrations_no_update
    BEFORE UPDATE ON application_registrations
    BEGIN
      SELECT RAISE(ABORT, 'Application registrations are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS application_registrations_no_delete
    BEFORE DELETE ON application_registrations
    BEGIN
      SELECT RAISE(ABORT, 'Application registrations are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS evidence_events_no_update
    BEFORE UPDATE ON evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Evidence Events are append-only');
    END;

    DROP TRIGGER IF EXISTS evidence_events_no_delete;

    CREATE TRIGGER IF NOT EXISTS evidence_events_retention_delete_only
    BEFORE DELETE ON evidence_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM durable_tasks
      JOIN expired_request_ids
        ON expired_request_ids.request_id = durable_tasks.request_id
      WHERE durable_tasks.id = OLD.task_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Evidence Events are append-only until retention expiry');
    END;
  `);
  ensureColumn(database, "operations", "lease_expires_at", "TEXT");
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    readonly name: string;
  }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function requireTask(task: TaskRow | undefined): TaskRow {
  if (task === undefined) throw new Error("Durable Task is unavailable");
  return task;
}

function readStorageMetrics(databasePath: string): {
  readonly databaseBytes: number;
  readonly filesystemAvailableBytes: number;
} {
  const databaseBytes = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .map((path) => {
      try {
        return statSync(path).size;
      } catch (error) {
        if (isMissingFile(error)) return 0;
        throw error;
      }
    })
    .reduce((total, bytes) => total + bytes, 0);
  const filesystem = statfsSync(dirname(databasePath));
  return {
    databaseBytes,
    filesystemAvailableBytes: filesystem.bavail * filesystem.bsize,
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
