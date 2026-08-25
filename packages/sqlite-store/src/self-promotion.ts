import Database from "better-sqlite3";

import { callAdmissionRecordSchema } from "@voice-agent/contracts";
import type {
  CallAdmissionRecord,
  SelfPromotionStore,
  UnsettledOperation,
} from "@voice-agent/durable-store";

interface CallAdmissionRow {
  readonly changed_at: string;
  readonly commit_sha: string | null;
  readonly promotion_id: string | null;
  readonly reason: string | null;
  readonly state: "open" | "paused";
}

interface OperationRow {
  readonly id: string;
  readonly kind: string;
  readonly status: "accepted" | "running";
  readonly task_id: string;
}

/**
 * Call Admission lives in one durable row rather than in the process that
 * closes it, because the Self-Promotion that closes it restarts that process.
 * The reserving transaction in the telephone boundary store reads the same row,
 * so admission is decided in one place for every entry path.
 */
export function ensureCallAdmissionSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS call_admission (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('open', 'paused')),
      changed_at TEXT NOT NULL,
      reason TEXT,
      promotion_id TEXT,
      commit_sha TEXT
    );
    INSERT OR IGNORE INTO call_admission (id, state, changed_at)
    VALUES (1, 'open', '1970-01-01T00:00:00.000Z');
  `);
}

export function projectCallAdmission(
  row: CallAdmissionRow | undefined,
): CallAdmissionRecord {
  if (row === undefined) {
    throw new Error("Call Admission state is unavailable");
  }
  return callAdmissionRecordSchema.parse({
    changedAt: row.changed_at,
    ...(row.commit_sha === null ? {} : { commit: row.commit_sha }),
    ...(row.promotion_id === null ? {} : { promotionId: row.promotion_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    state: row.state,
  });
}

export function createSqliteSelfPromotionStore(
  databasePath: string,
): SelfPromotionStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  ensureCallAdmissionSchema(database);

  const readAdmission = database.prepare<[], CallAdmissionRow>(`
    SELECT state, changed_at, reason, promotion_id, commit_sha
    FROM call_admission WHERE id = 1
  `);
  const pauseAdmission = database.prepare(`
    UPDATE call_admission
    SET state = 'paused', changed_at = ?, reason = ?, promotion_id = ?,
      commit_sha = ?
    WHERE id = 1
  `);
  const reopenAdmission = database.prepare(`
    UPDATE call_admission
    SET state = 'open', changed_at = ?, reason = NULL, promotion_id = NULL,
      commit_sha = NULL
    WHERE id = 1
  `);
  const hasTable = database.prepare<[name: string], { readonly name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  // These two tables belong to other stores on the same database. A Promotion
  // may run before either has ever been created, so these statements are
  // prepared on first use and then kept, rather than at construction.
  const prepared = new Map<string, Database.Statement>();
  const prepare = <Row>(sql: string) => {
    const existing = prepared.get(sql);
    if (existing !== undefined) return existing as Database.Statement<[], Row>;
    const statement = database.prepare<[], Row>(sql);
    prepared.set(sql, statement);
    return statement;
  };
  const sessionIdsInState = (state: "active" | "warm") =>
    prepare<{ readonly session_id: string }>(`
      SELECT session_id FROM telephone_boundary_sessions
      WHERE state = '${state}' ORDER BY reserved_at, session_id
    `);
  const unsettledOperations = () =>
    prepare<OperationRow>(`
      SELECT id, task_id, kind, status FROM operations
      WHERE status IN ('accepted', 'running') ORDER BY created_at, id
    `);

  return {
    async close() {
      database.close();
    },
    async findActiveTelephoneSessionIds() {
      // A Promotion may run before the telephone path has ever been used, so an
      // absent table means no live call rather than an unreadable safe point.
      if (hasTable.get("telephone_boundary_sessions") === undefined) return [];
      return sessionIdsInState("active").all().map((row) => row.session_id);
    },
    async findUnsettledOperations() {
      if (hasTable.get("operations") === undefined) return [];
      return unsettledOperations().all().map(
        (row): UnsettledOperation => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          taskId: row.task_id,
        }),
      );
    },
    async findWarmTelephoneSessionIds() {
      if (hasTable.get("telephone_boundary_sessions") === undefined) return [];
      return sessionIdsInState("warm").all().map((row) => row.session_id);
    },
    async pauseCallAdmission(input) {
      pauseAdmission.run(
        input.changedAt,
        input.reason,
        input.promotionId,
        input.commit,
      );
      return projectCallAdmission(readAdmission.get());
    },
    async readCallAdmission() {
      return projectCallAdmission(readAdmission.get());
    },
    async reopenCallAdmission(input) {
      reopenAdmission.run(input.changedAt);
      return projectCallAdmission(readAdmission.get());
    },
  };
}
