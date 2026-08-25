import Database from "better-sqlite3";

import type { CallAdmissionRecord } from "@voice-agent/contracts";
import type {
  SelfPromotionStore,
  TelephoneBoundaryDecision,
  TelephoneBoundaryStore,
  UnsettledOperation,
} from "@voice-agent/runtime";
import {
  createSqliteSelfPromotionStore,
  createSqliteTelephoneBoundaryStore,
} from "@voice-agent/sqlite-store";

/**
 * The live runtime a Self-Promotion is about to replace: Telephone Sessions
 * admitted through the real boundary store, and Operations in the real durable
 * operations table. A scenario drives this world so the Promotion waits on the
 * same state the Agent Host does, rather than on a rehearsal of it.
 */
export interface SelfPromotionWorld {
  /**
   * Try to admit a new Telephone Session through the ordinary reservation. This
   * is the single gate every entry path uses, so its decision is what a caller
   * meets while a Self-Promotion holds admission closed.
   */
  admitTelephoneSession(sessionId: string): Promise<TelephoneBoundaryDecision>;
  beginTelephoneSession(sessionId: string): Promise<void>;
  /**
   * Turn a session reserved before the gate closed into a live call, as a
   * Callback Handshake that was already in flight would.
   */
  activateTelephoneSession(sessionId: string): Promise<TelephoneBoundaryDecision>;
  /** Start an unsettled Operation of the given kind. */
  beginOperation(input: {
    readonly kind: string;
    readonly operationId: string;
    readonly taskId: string;
  }): Promise<void>;
  close(): Promise<void>;
  endTelephoneSession(sessionId: string): Promise<void>;
  listActiveTelephoneSessionIds(): Promise<readonly string[]>;
  listUnsettledOperations(): Promise<readonly UnsettledOperation[]>;
  readCallAdmission(): Promise<CallAdmissionRecord>;
  /** Let a non-interruptible Operation reach its declared safe boundary. */
  settleOperation(operationId: string): Promise<void>;
  readonly store: SelfPromotionStore;
}

export function createSelfPromotionWorld(input: {
  readonly databasePath: string;
  readonly now: () => string;
}): SelfPromotionWorld {
  const selfPromotion = createSqliteSelfPromotionStore(input.databasePath);
  const boundaries: TelephoneBoundaryStore = createSqliteTelephoneBoundaryStore(
    input.databasePath,
  );
  const database = new Database(input.databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createOperationTables(database);

  const insertTask = database.prepare(`
    INSERT OR IGNORE INTO durable_tasks (
      id, request_id, kind, status, question, conclusion, created_at, updated_at
    ) VALUES (?, ?, 'scenario.work', 'pending', 'Scenario work.',
      'Scenario work is in flight.', ?, ?)
  `);
  const insertOperation = database.prepare(`
    INSERT INTO operations (
      id, task_id, idempotency_key, kind, status, result_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'running', '{}', ?, ?)
  `);
  const completeOperation = database.prepare(`
    UPDATE operations SET status = 'completed', updated_at = ? WHERE id = ?
  `);

  return {
    async activateTelephoneSession(sessionId) {
      return boundaries.activateSession({
        activatedAt: input.now(),
        sessionId,
      });
    },
    async admitTelephoneSession(sessionId) {
      return boundaries.reserveWarmSession({
        reservedAt: input.now(),
        sessionId,
      });
    },
    async beginOperation(operation) {
      const at = input.now();
      insertTask.run(operation.taskId, `request:${operation.taskId}`, at, at);
      insertOperation.run(
        operation.operationId,
        operation.taskId,
        `idempotency:${operation.operationId}`,
        operation.kind,
        at,
        at,
      );
    },
    async beginTelephoneSession(sessionId) {
      const reserved = await boundaries.reserveWarmSession({
        reservedAt: input.now(),
        sessionId,
      });
      if (reserved.decision !== "accepted") {
        throw new Error(
          `The scenario could not reserve ${sessionId}: ${reserved.decision}`,
        );
      }
      const activated = await boundaries.activateSession({
        activatedAt: input.now(),
        sessionId,
      });
      if (activated.decision !== "accepted") {
        throw new Error(`The scenario could not activate ${sessionId}`);
      }
    },
    async close() {
      database.close();
      await boundaries.close();
      await selfPromotion.close();
    },
    async endTelephoneSession(sessionId) {
      // A warm session that never became a call is released rather than ended.
      await boundaries.releaseWarmSession(sessionId);
      await boundaries.endSession({
        durationMs: 1_000,
        endedAt: input.now(),
        reason: "completed",
        sessionId,
      });
    },
    async listActiveTelephoneSessionIds() {
      return selfPromotion.findActiveTelephoneSessionIds();
    },
    async listUnsettledOperations() {
      return selfPromotion.findUnsettledOperations();
    },
    async readCallAdmission() {
      return selfPromotion.readCallAdmission();
    },
    async settleOperation(operationId) {
      completeOperation.run(input.now(), operationId);
    },
    store: selfPromotion,
  };
}

/**
 * The Durable Task and Operation tables as the production store declares them.
 * A Self-Promotion reads unsettled Operations straight out of this table, so a
 * scenario that seeded a different shape would prove nothing.
 */
function createOperationTables(database: Database.Database): void {
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
  `);
}
