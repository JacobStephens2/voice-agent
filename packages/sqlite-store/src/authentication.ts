import Database from "better-sqlite3";

import {
  authenticationStateSchema,
  type AuthenticationSnapshot,
  type AuthenticationStore,
} from "@voice-agent/auth";

interface AuthenticationStateRow {
  readonly revision: number;
  readonly state_json: string;
}

export function createSqliteAuthenticationStore(
  databasePath: string,
): AuthenticationStore {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS authentication_state (
      owner INTEGER PRIMARY KEY CHECK (owner = 1),
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );
  `);

  const readState = database.prepare<[], AuthenticationStateRow>(`
    SELECT revision, state_json
    FROM authentication_state
    WHERE owner = 1
  `);
  const insertState = database.prepare(`
    INSERT INTO authentication_state (owner, revision, state_json)
    VALUES (1, 1, ?)
  `);
  const updateState = database.prepare(`
    UPDATE authentication_state
    SET revision = revision + 1, state_json = ?
    WHERE owner = 1 AND revision = ?
  `);

  return {
    async close() {
      database.close();
    },
    async read(): Promise<AuthenticationSnapshot | undefined> {
      const row = readState.get();
      if (row === undefined) return undefined;
      return {
        revision: row.revision,
        state: authenticationStateSchema.parse(JSON.parse(row.state_json)),
      };
    },
    async write(expectedRevision, state) {
      if (expectedRevision === 0) {
        try {
          insertState.run(JSON.stringify(state));
          return;
        } catch {
          throw new Error("Authentication state changed concurrently");
        }
      }
      const result = updateState.run(JSON.stringify(state), expectedRevision);
      if (result.changes !== 1) {
        throw new Error("Authentication state changed concurrently");
      }
    },
  };
}
