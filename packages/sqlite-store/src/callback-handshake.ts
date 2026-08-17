import Database from "better-sqlite3";

import {
  callbackActionResultSchema,
  callbackHandshakeSnapshotSchema,
  inboundTelephoneResultSchema,
  registeredTelephoneSchema,
  telephoneEvidenceEventSchema,
  telephoneEvidenceRecordSummarySchema,
  telephoneSessionEvidenceRecordProjectionSchema,
  type InboundTelephoneResult,
  type RegisteredTelephone,
  type TelephoneEvidenceEvent,
  type TelephoneSessionEvidenceRecordProjection,
} from "@voice-agent/contracts";
import type {
  ApplyCallbackTransitionPersistence,
  ApplyCallbackTransitionResult,
  AppendCallbackEvidencePersistence,
  CallbackDeliveryResult,
  CallbackHandshakeStore,
  CreateCallbackHandshakePersistence,
  CreateCallbackHandshakeResult,
} from "@voice-agent/durable-store";

interface CallbackHandshakeRow {
  readonly projection_json: string;
  readonly snapshot_json: string;
}

interface CallbackDeliveryRow {
  readonly result_json: string;
}

interface CallbackEvidenceRow {
  readonly details_json: string;
  readonly id: string;
  readonly kind: TelephoneEvidenceEvent["kind"];
  readonly occurred_at: string;
  readonly sequence: number;
  readonly summary: string;
}

interface CallbackEvidenceIdentityRow {
  readonly handshake_id: string;
}

export function createSqliteCallbackHandshakeStore(
  databasePath: string,
): CallbackHandshakeStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createCallbackSchema(database);

  const findRegistration = database.prepare<
    [],
    { readonly definition_json: string; readonly revision: number }
  >(`
    SELECT revision, definition_json
    FROM registered_telephone_revisions
    ORDER BY revision DESC
    LIMIT 1
  `);
  const findRegistrationRevision = database.prepare<
    [revision: number],
    { readonly definition_json: string }
  >(`
    SELECT definition_json
    FROM registered_telephone_revisions
    WHERE revision = ?
  `);
  const insertRegistration = database.prepare(`
    INSERT INTO registered_telephone_revisions (
      revision, registered_at, definition_json
    ) VALUES (?, ?, ?)
  `);
  const findDelivery = database.prepare<
    [activeDeliveryId: string, expiredDeliveryId: string],
    CallbackDeliveryRow
  >(`
    SELECT result_json FROM callback_provider_deliveries WHERE delivery_id = ?
    UNION ALL
    SELECT result_json FROM expired_callback_deliveries WHERE delivery_id = ?
    LIMIT 1
  `);
  const insertDelivery = database.prepare(`
    INSERT INTO callback_provider_deliveries (
      delivery_id, handshake_id, result_json
    ) VALUES (?, ?, ?)
  `);
  const insertCallbackPlacement = database.prepare(`
    INSERT INTO callback_placement_claims (effect_id, handshake_id)
    VALUES (?, ?)
    ON CONFLICT (effect_id) DO NOTHING
  `);
  const findHandshake = database.prepare<
    [handshakeId: string],
    CallbackHandshakeRow
  >(`
    SELECT snapshot_json, projection_json
    FROM callback_handshakes
    WHERE id = ?
  `);
  const findHandshakeIdByTelephoneSession = database.prepare<
    [telephoneSessionId: string],
    { readonly id: string }
  >(`
    SELECT id
    FROM callback_handshakes
    WHERE json_extract(snapshot_json, '$.telephoneSessionId') = ?
    ORDER BY accepted_at DESC
    LIMIT 1
  `);
  const findDueRetries = database.prepare<
    [now: string],
    { readonly snapshot_json: string }
  >(`
    SELECT snapshot_json
    FROM callback_handshakes
    WHERE state = 'retry-scheduled' AND retry_due_at <= ?
    ORDER BY retry_due_at, id
  `);
  const listHandshakes = database.prepare<[], CallbackHandshakeRow>(`
    SELECT snapshot_json, projection_json
    FROM callback_handshakes
    ORDER BY accepted_at DESC, id DESC
    LIMIT 100
  `);
  const countRecentHandshakes = database.prepare<
    [callerFingerprint: string, cutoff: string],
    { readonly count: number }
  >(`
    SELECT COUNT(*) AS count
    FROM callback_handshakes
    WHERE caller_fingerprint = ? AND accepted_at >= ?
  `);
  const readHandshakeMetrics = database.prepare<
    [],
    { readonly count: number; readonly state: string }
  >(`
    SELECT state, COUNT(*) AS count
    FROM callback_handshakes
    GROUP BY state
  `);
  const readAttemptMetrics = database.prepare<[], { readonly count: number }>(`
    SELECT COUNT(*) AS count
    FROM callback_evidence_events
    WHERE kind = 'telephone.callback.requested'
  `);
  const insertHandshake = database.prepare(`
    INSERT INTO callback_handshakes (
      id, caller_fingerprint, revision, state, accepted_at, retry_due_at,
      snapshot_json, projection_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateHandshake = database.prepare(`
    UPDATE callback_handshakes
    SET revision = ?, state = ?, retry_due_at = ?, snapshot_json = ?,
      projection_json = ?
    WHERE id = ? AND revision = ?
  `);
  const findEvidence = database.prepare<
    [handshakeId: string],
    CallbackEvidenceRow
  >(`
    SELECT id, sequence, kind, occurred_at, summary, details_json
    FROM callback_evidence_events
    WHERE handshake_id = ?
    ORDER BY sequence
  `);
  const insertEvidence = database.prepare(`
    INSERT INTO callback_evidence_events (
      id, handshake_id, sequence, kind, occurred_at, summary, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const findEvidenceById = database.prepare<
    [eventId: string],
    CallbackEvidenceIdentityRow
  >(`
    SELECT handshake_id FROM callback_evidence_events WHERE id = ?
  `);
  const updateProjection = database.prepare(`
    UPDATE callback_handshakes SET projection_json = ? WHERE id = ?
  `);
  const tombstoneExpiredHandshakes = database.prepare(`
    INSERT OR IGNORE INTO expired_callback_handshake_ids (handshake_id, expired_at)
    SELECT id, ? FROM callback_handshakes WHERE accepted_at < ?
  `);
  const deleteExpiredEvidence = database.prepare(`
    DELETE FROM callback_evidence_events
    WHERE occurred_at < ?
  `);

  function parseDelivery(row: CallbackDeliveryRow): CallbackDeliveryResult {
    const parsed = JSON.parse(row.result_json) as unknown;
    const inbound = inboundTelephoneResultSchema.safeParse(parsed);
    return inbound.success
      ? inbound.data
      : callbackActionResultSchema.parse(parsed);
  }

  function loadRecord(
    row: CallbackHandshakeRow,
    handshakeId: string,
  ): TelephoneSessionEvidenceRecordProjection {
    const projection = JSON.parse(row.projection_json) as {
      readonly session?: unknown;
      readonly task?: unknown;
    };
    return telephoneSessionEvidenceRecordProjectionSchema.parse({
      ...projection,
      evidence: findEvidence.all(handshakeId).map((event) =>
        telephoneEvidenceEventSchema.parse({
          details: JSON.parse(event.details_json) as unknown,
          id: event.id,
          kind: event.kind,
          occurredAt: event.occurred_at,
          sequence: event.sequence,
          summary: event.summary,
        }),
      ),
    });
  }

  function insertNewEvidence(
    handshakeId: string,
    projection: TelephoneSessionEvidenceRecordProjection,
  ): void {
    const existing = findEvidence.all(handshakeId).map((event) =>
      telephoneEvidenceEventSchema.parse({
        details: JSON.parse(event.details_json) as unknown,
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurred_at,
        sequence: event.sequence,
        summary: event.summary,
      }),
    );
    if (
      JSON.stringify(existing) !==
      JSON.stringify(projection.evidence.slice(0, existing.length))
    ) {
      throw new Error("Callback Evidence Events cannot be rewritten");
    }
    for (const event of projection.evidence.slice(existing.length)) {
      insertEvidence.run(
        event.id,
        handshakeId,
        event.sequence,
        event.kind,
        event.occurredAt,
        event.summary,
        JSON.stringify(event.details),
      );
    }
  }

  function projectionStateJson(
    projection: TelephoneSessionEvidenceRecordProjection,
  ): string {
    return JSON.stringify({
      session: projection.session,
      task: projection.task,
    });
  }

  const createHandshakeTransaction = database.transaction(
    (
      input: CreateCallbackHandshakePersistence,
    ): CreateCallbackHandshakeResult => {
      const duplicate = findDelivery.get(input.deliveryId, input.deliveryId);
      if (duplicate !== undefined) {
        return { kind: "duplicate", result: parseDelivery(duplicate) };
      }
      const recent = countRecentHandshakes.get(
        input.snapshot.callerFingerprint,
        input.rateLimitCutoff,
      )?.count ?? 0;
      if (recent >= input.maximumAcceptedInWindow) {
        insertDelivery.run(
          input.deliveryId,
          null,
          JSON.stringify(input.rateLimitedResult),
        );
        return { kind: "rate-limited", result: input.rateLimitedResult };
      }
      insertHandshake.run(
        input.snapshot.id,
        input.snapshot.callerFingerprint,
        input.snapshot.revision,
        input.snapshot.state,
        input.acceptedAt,
        input.snapshot.retryDueAt ?? null,
        JSON.stringify(input.snapshot),
        projectionStateJson(input.projection),
      );
      insertNewEvidence(input.snapshot.id, input.projection);
      insertDelivery.run(
        input.deliveryId,
        input.snapshot.id,
        JSON.stringify(input.result),
      );
      return { kind: "created", result: input.result };
    },
  );

  const applyTransitionTransaction = database.transaction(
    (
      input: ApplyCallbackTransitionPersistence,
    ): ApplyCallbackTransitionResult => {
      const duplicate = findDelivery.get(input.deliveryId, input.deliveryId);
      if (duplicate !== undefined) {
        return { kind: "duplicate", result: parseDelivery(duplicate) };
      }
      const updated = updateHandshake.run(
        input.snapshot.revision,
        input.snapshot.state,
        input.snapshot.retryDueAt ?? null,
        JSON.stringify(input.snapshot),
        projectionStateJson(input.projection),
        input.snapshot.id,
        input.expectedRevision,
      );
      if (updated.changes !== 1) return { kind: "conflict" };
      insertNewEvidence(input.snapshot.id, input.projection);
      insertDelivery.run(
        input.deliveryId,
        input.snapshot.id,
        JSON.stringify(input.result),
      );
      return { kind: "applied", result: input.result };
    },
  );

  const appendEvidenceTransaction = database.transaction(
    (
      input: AppendCallbackEvidencePersistence,
    ): TelephoneSessionEvidenceRecordProjection => {
      const row = findHandshake.get(input.handshakeId);
      if (row === undefined) {
        throw new Error("Callback Handshake is unavailable");
      }
      const existing = findEvidenceById.get(input.event.id);
      if (existing !== undefined) {
        if (existing.handshake_id !== input.handshakeId) {
          throw new Error(
            "Telephone Evidence Event identity belongs to another Callback Handshake",
          );
        }
        return loadRecord(row, input.handshakeId);
      }
      const record = loadRecord(row, input.handshakeId);
      const occurredAt =
        record.task.updatedAt < input.updatedAt
          ? input.updatedAt
          : record.task.updatedAt;
      const event = telephoneEvidenceEventSchema.parse({
        ...input.event,
        sequence: (record.evidence.at(-1)?.sequence ?? 0) + 1,
      });
      insertEvidence.run(
        event.id,
        input.handshakeId,
        event.sequence,
        event.kind,
        event.occurredAt,
        event.summary,
        JSON.stringify(event.details),
      );
      updateProjection.run(
        projectionStateJson({
          ...record,
          evidence: [...record.evidence, event],
          session:
            event.kind === "telephone.session.ended"
              ? {
                  ...record.session,
                  durationMs: event.details.durationMs,
                  endedAt: event.occurredAt,
                  endReason: event.details.reason,
                }
              : record.session,
          task: { ...record.task, updatedAt: occurredAt },
        }),
        input.handshakeId,
      );
      return loadRecord(
        requireHandshake(findHandshake.get(input.handshakeId)),
        input.handshakeId,
      );
    },
  );

  const persistRejectedTransaction = database.transaction(
    (deliveryId: string, result: InboundTelephoneResult) => {
      const existing = findDelivery.get(deliveryId, deliveryId);
      if (existing !== undefined) {
        return inboundTelephoneResultSchema.parse(parseDelivery(existing));
      }
      insertDelivery.run(deliveryId, null, JSON.stringify(result));
      return result;
    },
  );

  const expireTransaction = database.transaction((cutoff: string) => {
    tombstoneExpiredHandshakes.run(cutoff, cutoff);
    deleteExpiredEvidence.run(cutoff);
  });
  return {
    async applyEvidenceRetention(input) {
      expireTransaction.immediate(input.cutoff);
    },
    async appendEvidence(input) {
      return appendEvidenceTransaction.immediate(input);
    },
    async appendEvidenceByTelephoneSessionId(input) {
      const row = findHandshakeIdByTelephoneSession.get(
        input.telephoneSessionId,
      );
      if (row === undefined) {
        throw new Error("Telephone Session Evidence Record is unavailable");
      }
      return appendEvidenceTransaction.immediate({
        event: input.event,
        handshakeId: row.id,
        updatedAt: input.updatedAt,
      });
    },
    async applyTransition(input) {
      return applyTransitionTransaction.immediate(input);
    },
    async claimCallbackPlacement(effectId, handshakeId) {
      return insertCallbackPlacement.run(effectId, handshakeId).changes === 1;
    },
    async close() {
      database.close();
    },
    async createHandshake(input) {
      return createHandshakeTransaction.immediate(input);
    },
    async findDelivery(deliveryId) {
      const row = findDelivery.get(deliveryId, deliveryId);
      return row === undefined ? undefined : parseDelivery(row);
    },
    async findDueRetries(now) {
      return findDueRetries
        .all(now)
        .map((row) =>
          callbackHandshakeSnapshotSchema.parse(JSON.parse(row.snapshot_json)),
        );
    },
    async findEvidenceRecord(handshakeId) {
      const row = findHandshake.get(handshakeId);
      return row === undefined ? undefined : loadRecord(row, handshakeId);
    },
    async findHandshake(handshakeId) {
      const row = findHandshake.get(handshakeId);
      return row === undefined
        ? undefined
        : callbackHandshakeSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    },
    async findRegisteredTelephone() {
      const row = findRegistration.get();
      return row === undefined
        ? undefined
        : registeredTelephoneSchema.parse(JSON.parse(row.definition_json));
    },
    async findRegisteredTelephoneRevision(revision) {
      const row = findRegistrationRevision.get(revision);
      return row === undefined
        ? undefined
        : registeredTelephoneSchema.parse(JSON.parse(row.definition_json));
    },
    async listEvidenceRecords() {
      return listHandshakes.all().map((row) => {
        const projection = JSON.parse(row.projection_json) as {
          readonly task?: unknown;
        };
        return telephoneEvidenceRecordSummarySchema.parse(projection.task);
      });
    },
    async persistRejectedDelivery(deliveryId, result) {
      return persistRejectedTransaction.immediate(deliveryId, result);
    },
    async readOperationalMetrics() {
      const states = new Map(
        readHandshakeMetrics.all().map((row) => [row.state, row.count]),
      );
      return {
        attempts: readAttemptMetrics.get()?.count ?? 0,
        handshakes: {
          authorized: states.get("authorized") ?? 0,
          failed: states.get("failed") ?? 0,
          pending:
            (states.get("awaiting-machine") ?? 0) +
            (states.get("awaiting-dtmf") ?? 0) +
            (states.get("retry-scheduled") ?? 0),
        },
      };
    },
    async registerTelephone(input, registeredAt) {
      const revision = (findRegistration.get()?.revision ?? 0) + 1;
      const registration: RegisteredTelephone = registeredTelephoneSchema.parse({
        ...input,
        registeredAt,
        revision,
      });
      insertRegistration.run(
        registration.revision,
        registration.registeredAt,
        JSON.stringify(registration),
      );
      return registration;
    },
  };
}

function requireHandshake(
  row: CallbackHandshakeRow | undefined,
): CallbackHandshakeRow {
  if (row === undefined) {
    throw new Error("Callback Handshake is unavailable");
  }
  return row;
}

function createCallbackSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS registered_telephone_revisions (
      revision INTEGER PRIMARY KEY,
      registered_at TEXT NOT NULL,
      definition_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS callback_handshakes (
      id TEXT PRIMARY KEY,
      caller_fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      retry_due_at TEXT,
      snapshot_json TEXT NOT NULL,
      projection_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS callback_handshakes_rate_limit
      ON callback_handshakes (caller_fingerprint, accepted_at);
    CREATE INDEX IF NOT EXISTS callback_handshakes_retries
      ON callback_handshakes (state, retry_due_at);

    CREATE TABLE IF NOT EXISTS callback_provider_deliveries (
      delivery_id TEXT PRIMARY KEY,
      handshake_id TEXT,
      result_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS callback_placement_claims (
      effect_id TEXT PRIMARY KEY,
      handshake_id TEXT NOT NULL REFERENCES callback_handshakes(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS callback_placement_claims_handshake
      ON callback_placement_claims (handshake_id);

    CREATE TABLE IF NOT EXISTS expired_callback_handshake_ids (
      handshake_id TEXT PRIMARY KEY,
      expired_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expired_callback_deliveries (
      delivery_id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      expired_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS callback_evidence_events (
      id TEXT PRIMARY KEY,
      handshake_id TEXT NOT NULL REFERENCES callback_handshakes(id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      UNIQUE (handshake_id, sequence)
    );

    CREATE TRIGGER IF NOT EXISTS registered_telephone_no_update
    BEFORE UPDATE ON registered_telephone_revisions
    BEGIN
      SELECT RAISE(ABORT, 'Registered Telephone revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS registered_telephone_no_delete
    BEFORE DELETE ON registered_telephone_revisions
    BEGIN
      SELECT RAISE(ABORT, 'Registered Telephone revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS callback_evidence_no_update
    BEFORE UPDATE ON callback_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Callback Evidence Events are append-only');
    END;

    DROP TRIGGER IF EXISTS callback_evidence_no_delete;

    CREATE TRIGGER IF NOT EXISTS callback_evidence_retention_delete_only
    BEFORE DELETE ON callback_evidence_events
    WHEN NOT EXISTS (
      SELECT 1 FROM expired_callback_handshake_ids
      WHERE handshake_id = OLD.handshake_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'Callback Evidence Events are append-only until retention expiry');
    END;
  `);
  ensureCallbackColumn(
    database,
    "callback_provider_deliveries",
    "handshake_id",
    "TEXT",
  );
  database.exec(`
    CREATE INDEX IF NOT EXISTS callback_provider_deliveries_handshake
      ON callback_provider_deliveries (handshake_id);
  `);
}

function ensureCallbackColumn(
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
