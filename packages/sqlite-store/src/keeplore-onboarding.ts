import Database from "better-sqlite3";

import {
  keeploreDeploymentContractSchema,
  keeplorePolicyAssessmentSchema,
  keeploreRegistrationSchema,
  normalizeStoredRegisteredCodebaseIdentity,
} from "@voice-agent/contracts";
import type {
  KeeploreAssessmentKind,
  KeeploreOnboardingStore,
} from "@voice-agent/durable-store";

export interface SqliteKeeploreOnboardingStore extends KeeploreOnboardingStore {
  close(): void;
}

export function createSqliteKeeploreOnboardingStore(
  databasePath: string,
): SqliteKeeploreOnboardingStore {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS keeplore_registrations (
      revision INTEGER PRIMARY KEY,
      definition_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS keeplore_contracts (
      revision INTEGER PRIMARY KEY,
      definition_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS keeplore_assessments (
      kind TEXT PRIMARY KEY,
      assessment_json TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS keeplore_contracts_no_update
    BEFORE UPDATE ON keeplore_contracts
    BEGIN
      SELECT RAISE(ABORT, 'Keeplore Deployment Contract revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS keeplore_contracts_no_delete
    BEFORE DELETE ON keeplore_contracts
    BEGIN
      SELECT RAISE(ABORT, 'Keeplore Deployment Contract revisions are immutable');
    END;
  `);

  return {
    close() {
      database.close();
    },
    async findActiveContract() {
      const row = database
        .prepare(
          "SELECT definition_json FROM keeplore_contracts ORDER BY revision DESC LIMIT 1",
        )
        .get() as { readonly definition_json: string } | undefined;
      return row === undefined
        ? undefined
        : keeploreDeploymentContractSchema.parse(
            normalizeStoredRegisteredCodebaseIdentity(
              JSON.parse(row.definition_json),
            ),
          );
    },
    async findAssessment(kind) {
      const row = database
        .prepare("SELECT assessment_json FROM keeplore_assessments WHERE kind = ?")
        .get(kind) as { readonly assessment_json: string } | undefined;
      return row === undefined
        ? undefined
        : keeplorePolicyAssessmentSchema.parse(JSON.parse(row.assessment_json));
    },
    async findRegistration() {
      const row = database
        .prepare(
          "SELECT definition_json FROM keeplore_registrations ORDER BY revision DESC LIMIT 1",
        )
        .get() as { readonly definition_json: string } | undefined;
      return row === undefined
        ? undefined
        : keeploreRegistrationSchema.parse(
            normalizeStoredRegisteredCodebaseIdentity(
              JSON.parse(row.definition_json),
            ),
          );
    },
    async saveAssessment(kind: KeeploreAssessmentKind, assessment) {
      database
        .prepare(`
          INSERT INTO keeplore_assessments (kind, assessment_json)
          VALUES (?, ?)
          ON CONFLICT(kind) DO UPDATE SET assessment_json = excluded.assessment_json
        `)
        .run(kind, JSON.stringify(assessment));
    },
    async saveContract(contract) {
      database
        .prepare(
          "INSERT INTO keeplore_contracts (revision, definition_json) VALUES (?, ?)",
        )
        .run(contract.revision, JSON.stringify(contract));
    },
    async saveRegistration(registration) {
      database
        .prepare(
          "INSERT INTO keeplore_registrations (revision, definition_json) VALUES (?, ?)",
        )
        .run(registration.revision, JSON.stringify(registration));
    },
  };
}
