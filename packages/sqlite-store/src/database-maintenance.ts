import Database from "better-sqlite3";

const requiredTables = [
  "application_registrations",
  "durable_tasks",
  "evidence_events",
  "expired_request_ids",
  "operations",
  "operational_counters",
] as const;

export async function backupSqliteDatabase(
  databasePath: string,
  backupPath: string,
): Promise<void> {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    verifyIntegrity(database);
    await database.backup(backupPath);
  } finally {
    database.close();
  }
  const backup = new Database(backupPath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    verifyIntegrity(backup);
  } finally {
    backup.close();
  }
}

export async function restoreSqliteDatabase(
  backupPath: string,
  databasePath: string,
): Promise<void> {
  const backup = new Database(backupPath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    verifyIntegrity(backup);
    await backup.backup(databasePath);
  } finally {
    backup.close();
  }
  const restored = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    verifyIntegrity(restored);
  } finally {
    restored.close();
  }
}

export function verifyVoiceAgentDatabase(databasePath: string): void {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    verifyIntegrity(database);
    const tables = new Set(
      database
        .prepare<[], { readonly name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table'",
        )
        .all()
        .map((row) => row.name),
    );
    for (const table of requiredTables) {
      if (!tables.has(table)) {
        throw new Error(`Voice Agent database is missing table ${table}`);
      }
    }
    const operationColumns = database
      .prepare<[], { readonly name: string }>("PRAGMA table_info(operations)")
      .all();
    if (!operationColumns.some((column) => column.name === "lease_expires_at")) {
      throw new Error(
        "Voice Agent database is missing operations.lease_expires_at",
      );
    }
  } finally {
    database.close();
  }
}

function verifyIntegrity(database: Database.Database): void {
  const result = database.pragma("integrity_check", { simple: true });
  if (result !== "ok") {
    throw new Error("SQLite integrity verification failed");
  }
}
