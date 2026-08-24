import type Database from "better-sqlite3";

/**
 * The Durable Tasks table, created by every store that mints or reads a Durable
 * Task identity. A Keeplore Delegation registers its task on the same
 * connection that persists the Delegation, so both stores must be able to
 * create this table without depending on which one opened the database first.
 */
export function createDurableTaskTable(database: Database.Database): void {
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
  `);
  ensureColumn(database, "durable_tasks", "cancellation_requested_at", "TEXT");
}

export function ensureColumn(
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
