import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  keeploreButtonTrialGoal,
  keeploreDelegationBriefSchema,
  keeploreDelegationRecordSchema,
  keeploreDelegationResultSchema,
  keeploreWorktreeSchema,
  type KeeploreDelegationRecord,
  type KeeploreDelegationResult,
} from "@voice-agent/contracts";
import type { KeeploreDelegationStore } from "@voice-agent/durable-store";

import { createDurableTaskTable } from "./durable-task-table.ts";

interface DelegationRow {
  readonly brief_json: string;
  readonly result_json: string | null;
  readonly status: "completed" | "failed" | "pending" | "running" | "stopped";
  readonly stop_requested: number;
  readonly updated_at: string;
  readonly worktree_json: string;
}

export function createSqliteKeeploreDelegationStore(
  databasePath: string,
): KeeploreDelegationStore {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  // A Keeplore Delegation mints a Durable Task identity, so the Durable Tasks
  // row is written on this same connection and in the same transaction.
  createDurableTaskTable(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS keeplore_delegations (
      task_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      delegation_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      worktree_json TEXT NOT NULL,
      result_json TEXT,
      stop_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keeplore_delegation_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (
        kind IN ('accepted', 'claimed', 'resumed', 'stop-requested', 'completed')
      ),
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS keeplore_delegation_events_task_time
      ON keeplore_delegation_events (task_id, occurred_at, event_id);
    CREATE TRIGGER IF NOT EXISTS keeplore_delegation_events_no_update
    BEFORE UPDATE ON keeplore_delegation_events
    BEGIN
      SELECT RAISE(ABORT, 'Keeplore Delegation events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS keeplore_delegation_events_no_delete
    BEFORE DELETE ON keeplore_delegation_events
    BEGIN
      SELECT RAISE(ABORT, 'Keeplore Delegation events are append-only');
    END;
    INSERT OR IGNORE INTO keeplore_delegation_events (
      event_id, task_id, kind, occurred_at, payload_json
    )
    SELECT task_id || ':legacy-accepted', task_id, 'accepted', created_at,
      '{"migration":"projection-backfill"}'
    FROM keeplore_delegations AS delegation
    WHERE NOT EXISTS (
      SELECT 1 FROM keeplore_delegation_events AS event
      WHERE event.task_id = delegation.task_id
    );
  `);
  const selectByTask = database.prepare<[taskId: string], DelegationRow>(`
    SELECT status, brief_json, worktree_json, result_json, stop_requested,
      updated_at FROM keeplore_delegations WHERE task_id = ?
  `);
  const selectAll = database.prepare<[], DelegationRow>(`
    SELECT status, brief_json, worktree_json, result_json, stop_requested,
      updated_at FROM keeplore_delegations ORDER BY created_at, task_id
  `);
  const appendEvent = database.prepare(`
    INSERT INTO keeplore_delegation_events (
      event_id, task_id, kind, occurred_at, payload_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  // Delegations accepted before the Durable Task was registered still owe one
  // Durable Tasks row, or telephone evidence recorded under their identity has
  // nowhere to land.
  database
    .prepare(`
      INSERT OR IGNORE INTO durable_tasks (
        id, request_id, kind, status, question, conclusion, created_at, updated_at
      )
      SELECT task_id, request_id, 'keeplore.button-trial', status, ?,
        CASE status
          WHEN 'completed' THEN 'Keeplore Button Trial pull request is ready for Human Merge.'
          WHEN 'running' THEN 'Keeplore Button Trial is running.'
          WHEN 'stopped' THEN 'Keeplore Button Trial stopped with its worktree preserved.'
          WHEN 'failed' THEN 'Keeplore Button Trial could not be verified.'
          ELSE 'Keeplore Button Trial is delegated.'
        END,
        created_at, updated_at
      FROM keeplore_delegations
    `)
    .run(keeploreButtonTrialGoal);
  const insertDurableTask = database.prepare(`
    INSERT INTO durable_tasks (
      id, request_id, kind, status, question, conclusion, created_at, updated_at
    ) VALUES (?, ?, 'keeplore.button-trial', ?, ?, ?, ?, ?)
  `);
  const updateDurableTask = database.prepare(`
    UPDATE durable_tasks
    SET status = ?, conclusion = ?, updated_at = ?
    WHERE id = ?
  `);

  return {
    async claimNext(input) {
      const claim = database.transaction(() => {
        const row = database
          .prepare<[], DelegationRow>(`
            SELECT status, brief_json, worktree_json, result_json,
              stop_requested, updated_at
            FROM keeplore_delegations
            WHERE status IN ('running', 'pending')
            ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
              created_at, task_id
            LIMIT 1
          `)
          .get();
        if (row === undefined) return undefined;
        const brief = keeploreDelegationBriefSchema.parse(
          JSON.parse(row.brief_json),
        );
        const worktree = keeploreWorktreeSchema.parse({
          ...JSON.parse(row.worktree_json),
          state: "running",
        });
        if (row.status === "pending") {
          database
            .prepare(`
              UPDATE keeplore_delegations
              SET status = 'running', worktree_json = ?, updated_at = ?
              WHERE task_id = ? AND status = 'pending'
            `)
            .run(JSON.stringify(worktree), input.claimedAt, brief.durableTask.id);
          updateDurableTask.run(
            "running",
            conclusionFor("running"),
            input.claimedAt,
            brief.durableTask.id,
          );
        }
        appendEvent.run(
          randomUUID(),
          brief.durableTask.id,
          row.status === "running" ? "resumed" : "claimed",
          input.claimedAt,
          JSON.stringify({
            delegationId: brief.delegationId,
            worktree: worktree.path,
          }),
        );
        return {
          brief,
          stopRequested: row.stop_requested === 1,
          worktree,
        };
      });
      return claim.immediate();
    },
    close() {
      database.close();
    },
    async complete(input) {
      database.transaction(() => {
        database
          .prepare(`
            UPDATE keeplore_delegations
            SET status = ?, worktree_json = ?, result_json = ?, updated_at = ?
            WHERE task_id = ?
          `)
          .run(
            input.result.status,
            JSON.stringify(input.result.worktree),
            JSON.stringify(input.result),
            input.completedAt,
            input.taskId,
          );
        updateDurableTask.run(
          input.result.status,
          conclusionFor(input.result.status),
          input.completedAt,
          input.taskId,
        );
        appendEvent.run(
          randomUUID(),
          input.taskId,
          "completed",
          input.completedAt,
          JSON.stringify({ result: input.result }),
        );
      }).immediate();
      return requireRecord(selectByTask.get(input.taskId));
    },
    async findByTaskId(taskId) {
      const row = selectByTask.get(taskId);
      return row === undefined ? undefined : projectRecord(row);
    },
    async list() {
      return selectAll.all().map(projectRecord);
    },
    async persistAccepted(input) {
      database.transaction(() => {
        insertDurableTask.run(
          input.brief.durableTask.id,
          input.brief.durableTask.requestId,
          "pending",
          keeploreButtonTrialGoal,
          conclusionFor("pending"),
          input.brief.durableTask.acceptedAt,
          input.brief.durableTask.acceptedAt,
        );
        database
          .prepare(`
            INSERT INTO keeplore_delegations (
              task_id, request_id, delegation_id, status, brief_json,
              worktree_json, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
          `)
          .run(
            input.brief.durableTask.id,
            input.brief.durableTask.requestId,
            input.brief.delegationId,
            JSON.stringify(input.brief),
            JSON.stringify(input.worktree),
            input.brief.durableTask.acceptedAt,
            input.brief.durableTask.acceptedAt,
          );
        appendEvent.run(
          randomUUID(),
          input.brief.durableTask.id,
          "accepted",
          input.brief.durableTask.acceptedAt,
          JSON.stringify({
            brief: input.brief,
            worktree: input.worktree,
          }),
        );
      }).immediate();
      return requireRecord(selectByTask.get(input.brief.durableTask.id));
    },
    async requestStop(input) {
      database.transaction(() => {
        const update = database
          .prepare(`
            UPDATE keeplore_delegations
            SET stop_requested = 1, updated_at = ?
            WHERE task_id = ? AND status IN ('pending', 'running')
          `)
          .run(input.requestedAt, input.taskId);
        if (update.changes > 0) {
          appendEvent.run(
            randomUUID(),
            input.taskId,
            "stop-requested",
            input.requestedAt,
            JSON.stringify({ requested: true }),
          );
          const stopping = selectByTask.get(input.taskId);
          if (stopping !== undefined) {
            updateDurableTask.run(
              stopping.status,
              conclusionFor(stopping.status),
              input.requestedAt,
              input.taskId,
            );
          }
        }
      }).immediate();
      const row = selectByTask.get(input.taskId);
      return row === undefined ? undefined : projectRecord(row);
    },
    async stopRequested(taskId) {
      return selectByTask.get(taskId)?.stop_requested === 1;
    },
  };
}

function requireRecord(row: DelegationRow | undefined): KeeploreDelegationRecord {
  if (row === undefined) throw new Error("Keeplore Delegation is unavailable");
  return projectRecord(row);
}

function projectRecord(row: DelegationRow): KeeploreDelegationRecord {
  const brief = keeploreDelegationBriefSchema.parse(JSON.parse(row.brief_json));
  const worktree = keeploreWorktreeSchema.parse(JSON.parse(row.worktree_json));
  const result: KeeploreDelegationResult | undefined =
    row.result_json === null
      ? undefined
      : keeploreDelegationResultSchema.parse(JSON.parse(row.result_json));
  return keeploreDelegationRecordSchema.parse({
    delegation: {
      brief,
      ...(result === undefined ? {} : { result }),
      stopRequested: row.stop_requested === 1,
      worktree,
    },
    task: {
      conclusion: conclusionFor(row.status),
      createdAt: brief.durableTask.acceptedAt,
      id: brief.durableTask.id,
      kind: "keeplore.button-trial",
      question: keeploreButtonTrialGoal,
      status: row.status,
      updatedAt: row.updated_at,
    },
  });
}

function conclusionFor(status: DelegationRow["status"]): KeeploreDelegationRecord["task"]["conclusion"] {
  if (status === "completed") {
    return "Keeplore Button Trial pull request is ready for Human Merge.";
  }
  if (status === "running") return "Keeplore Button Trial is running.";
  if (status === "stopped") {
    return "Keeplore Button Trial stopped with its worktree preserved.";
  }
  if (status === "failed") return "Keeplore Button Trial could not be verified.";
  return "Keeplore Button Trial is delegated.";
}
