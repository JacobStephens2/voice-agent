import Database from "better-sqlite3";

import type {
  FixtureCodebaseRegistration,
  FixtureDeploymentContract,
  FixtureGitHubEvent,
  PromotionOperationProjection,
  PromotionEvidenceEventProjection,
  PromotionEvidenceRecordProjection,
} from "@voice-agent/contracts";
import {
  fixtureCodebaseRegistrationSchema,
  fixtureDeploymentContractSchema,
  promotionEvidenceDetailsSchema,
  promotionEvidenceRecordProjectionSchema,
  promotionMergeProjectionSchema,
  promotionOperationProjectionSchema,
  promotionReleaseProjectionSchema,
  promotionRollbackProjectionSchema,
  promotionVerificationProjectionSchema,
} from "@voice-agent/contracts";

export const fixtureApplicationId = "fixture-production" as const;
export const fixtureRepository = "JacobStephens2/fixture-application" as const;

interface RecordRow {
  readonly circuit_state: "closed" | "half-open" | "open";
  readonly conclusion: string;
  readonly consecutive_failures: number;
  readonly contract_json: string | null;
  readonly created_at: string;
  readonly denial_reason: string | null;
  readonly id: string;
  readonly merge_json: string;
  readonly question: string;
  readonly rollback_json: string;
  readonly status: "completed" | "denied" | "pending" | "running";
  readonly updated_at: string;
}

interface AttemptRow {
  readonly contract_json: string;
  readonly id: string;
  readonly merge_commit: string;
  readonly previous_release_json: string | null;
  readonly queue_sequence: number;
  readonly record_id: string;
  readonly release_json: string | null;
  readonly rollback_json: string;
  readonly status: "queued" | "rolled-back" | "running" | "succeeded";
  readonly verification_json: string | null;
}

interface EvidenceRow {
  readonly details_json: string;
  readonly id: string;
  readonly kind: PromotionEvidenceEventProjection["kind"];
  readonly occurred_at: string;
  readonly sequence: number;
  readonly summary: string;
}

interface ApplicationStateRow {
  readonly circuit_opened_queue_sequence: number | null;
  readonly circuit_state: "closed" | "half-open" | "open";
  readonly consecutive_failures: number;
}

export interface PromotionStoreInspection {
  readonly activeRelease?: PromotionEvidenceRecordProjection["promotion"]["release"];
  readonly attempts: readonly NonNullable<
    PromotionEvidenceRecordProjection["promotion"]["attempt"]
  >[];
  readonly operations: readonly PromotionOperationProjection[];
}

export interface PromotionStore {
  activateContract(contract: FixtureDeploymentContract): FixtureDeploymentContract;
  activateInitialPolicy(now: string): void;
  appendEvidence(
    recordId: string,
    eventId: string,
    kind: PromotionEvidenceEventProjection["kind"],
    occurredAt: string,
    summary: string,
    details: PromotionEvidenceEventProjection["details"],
  ): void;
  claimNext(now: string): AttemptRow | undefined;
  close(): void;
  completeHealthy(input: {
    readonly attemptId: string;
    readonly now: string;
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
    readonly verification: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["verification"]
    >;
  }): PromotionEvidenceRecordProjection;
  completeUnhealthy(input: {
    readonly attemptId: string;
    readonly now: string;
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
    readonly verification: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["verification"]
    >;
  }): PromotionEvidenceRecordProjection;
  findActiveContract(): FixtureDeploymentContract;
  findRecord(taskId: string): PromotionEvidenceRecordProjection | undefined;
  findRegistration(): FixtureCodebaseRegistration;
  hasAttempt(commit: string): boolean;
  hasDelivery(deliveryId: string): boolean;
  inspect(): PromotionStoreInspection;
  performOperation(input: {
    readonly actualHealthStatus: number;
    readonly attempt: AttemptRow;
    readonly contract: FixtureDeploymentContract;
    readonly kind: PromotionOperationProjection["kind"];
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
  }): PromotionOperationProjection;
  persistAccepted(input: {
    readonly attemptId: string;
    readonly contract: FixtureDeploymentContract;
    readonly deliveryId: string;
    readonly event: FixtureGitHubEvent;
    readonly now: string;
    readonly source: "reconciliation" | "webhook";
    readonly taskId: string;
  }): PromotionEvidenceRecordProjection;
  persistDenied(input: {
    readonly authenticated: boolean;
    readonly deliveryId: string;
    readonly duplicate: boolean;
    readonly event: FixtureGitHubEvent;
    readonly now: string;
    readonly reason: string;
    readonly taskId: string;
  }): PromotionEvidenceRecordProjection;
  reorderQueuedAttempts(): void;
}

export function createPromotionStore(databasePath: string): PromotionStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createPromotionSchema(database);

  function findRegistration(): FixtureCodebaseRegistration {
    const row = database
      .prepare("SELECT definition_json FROM promotion_registrations LIMIT 1")
      .get() as { readonly definition_json: string } | undefined;
    if (row === undefined) throw new Error("Fixture Registered Codebase is unavailable");
    return parseStored(row.definition_json, fixtureCodebaseRegistrationSchema);
  }

  function findActiveContract(): FixtureDeploymentContract {
    const row = database
      .prepare(`
        SELECT promotion_contracts.definition_json
        FROM promotion_active_contracts
        JOIN promotion_contracts
          ON promotion_contracts.application_id = promotion_active_contracts.application_id
          AND promotion_contracts.revision = promotion_active_contracts.revision
        WHERE promotion_active_contracts.application_id = ?
      `)
      .get(fixtureApplicationId) as { readonly definition_json: string } | undefined;
    if (row === undefined) throw new Error("Active Deployment Contract is unavailable");
    return parseStored(row.definition_json, fixtureDeploymentContractSchema);
  }

  function readApplicationState(): ApplicationStateRow {
    return database
      .prepare(`
        SELECT consecutive_failures, circuit_state,
          circuit_opened_queue_sequence
        FROM promotion_application_state
        WHERE application_id = ?
      `)
      .get(fixtureApplicationId) as ApplicationStateRow;
  }

  function projectMerge(input: {
    readonly deliveryId: string;
    readonly event: FixtureGitHubEvent;
    readonly source: "reconciliation" | "webhook";
  }): PromotionEvidenceRecordProjection["promotion"]["merge"] {
    return {
      actor: input.event.mergedBy?.login ?? "unknown",
      beforeCommit: input.event.beforeCommit,
      branch: input.event.branch,
      commit: input.event.commit,
      deliveryId: input.deliveryId,
      repository: input.event.repository,
      source: input.source,
    };
  }

  function findAttemptByRecord(recordId: string): AttemptRow | undefined {
    return database
      .prepare(`
        SELECT id, record_id, merge_commit, queue_sequence, status,
          contract_json, release_json, verification_json, rollback_json,
          previous_release_json
        FROM promotion_attempts
        WHERE record_id = ?
      `)
      .get(recordId) as AttemptRow | undefined;
  }

  function findAttempt(attemptId: string): AttemptRow {
    const attempt = database
      .prepare(`
        SELECT id, record_id, merge_commit, queue_sequence, status,
          contract_json, release_json, verification_json, rollback_json,
          previous_release_json
        FROM promotion_attempts
        WHERE id = ?
      `)
      .get(attemptId) as AttemptRow | undefined;
    if (attempt === undefined) throw new Error("Promotion Attempt is unavailable");
    return attempt;
  }

  function findRecord(taskId: string): PromotionEvidenceRecordProjection | undefined {
    const row = database
      .prepare(`
        SELECT id, status, question, conclusion, created_at, updated_at,
          merge_json, contract_json, denial_reason, rollback_json,
          circuit_state, consecutive_failures
        FROM promotion_records
        WHERE id = ?
      `)
      .get(taskId) as RecordRow | undefined;
    if (row === undefined) return undefined;
    const attempt = findAttemptByRecord(taskId);
    const evidence = database
      .prepare(`
        SELECT id, sequence, kind, occurred_at, summary, details_json
        FROM promotion_evidence_events
        WHERE record_id = ?
        ORDER BY sequence
      `)
      .all(taskId) as EvidenceRow[];
    const merge = parseStored(row.merge_json, promotionMergeProjectionSchema);
    const contract =
      row.contract_json === null
        ? undefined
        : parseStored(row.contract_json, fixtureDeploymentContractSchema);
    const release =
      attempt?.release_json === null || attempt?.release_json === undefined
        ? undefined
        : parseStored(attempt.release_json, promotionReleaseProjectionSchema);
    const verification =
      attempt?.verification_json === null ||
      attempt?.verification_json === undefined
        ? undefined
        : parseStored(
            attempt.verification_json,
            promotionVerificationProjectionSchema,
          );
    const rollback = parseStored(
      attempt?.rollback_json ?? row.rollback_json,
      promotionRollbackProjectionSchema,
    );
    return promotionEvidenceRecordProjectionSchema.parse({
      evidence: evidence.map((event) => ({
        details: parseStored(
          event.details_json,
          promotionEvidenceDetailsSchema,
        ),
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurred_at,
        sequence: event.sequence,
        summary: event.summary,
      })),
      promotion: {
        ...(attempt === undefined
          ? {}
          : {
              attempt: {
                id: attempt.id,
                mergeCommit: attempt.merge_commit,
                queueSequence: attempt.queue_sequence,
                status: attempt.status,
              },
            }),
        circuit: {
          consecutiveFailures: row.consecutive_failures,
          state: row.circuit_state,
        },
        ...(contract === undefined
          ? {}
          : {
              contract: {
                activatedAt: contract.activatedAt,
                revision: contract.revision,
                source: contract.source,
              },
            }),
        ...(row.denial_reason === null ? {} : { denialReason: row.denial_reason }),
        merge,
        ...(release === undefined ? {} : { release }),
        rollback,
        ...(verification === undefined ? {} : { verification }),
      },
      task: {
        conclusion: row.conclusion,
        createdAt: row.created_at,
        id: row.id,
        kind: "human-merge.promotion",
        question: row.question,
        status: row.status,
        updatedAt: row.updated_at,
      },
    });
  }

  function appendEvidence(
    recordId: string,
    eventId: string,
    kind: PromotionEvidenceEventProjection["kind"],
    occurredAt: string,
    summary: string,
    details: PromotionEvidenceEventProjection["details"],
  ): void {
    const next = database
      .prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM promotion_evidence_events
        WHERE record_id = ?
      `)
      .get(recordId) as { readonly sequence: number };
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_evidence_events (
          id, record_id, sequence, kind, occurred_at, summary, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        recordId,
        next.sequence,
        kind,
        occurredAt,
        summary,
        JSON.stringify(details),
      );
  }

  function hasDelivery(deliveryId: string): boolean {
    return (
      database
        .prepare(`
          SELECT 1
          FROM promotion_delivery_identities
          WHERE delivery_id = ?
        `)
        .get(deliveryId) !== undefined
    );
  }

  function hasAttempt(commit: string): boolean {
    return (
      database
        .prepare(`
          SELECT 1
          FROM promotion_attempts
          WHERE application_id = ? AND merge_commit = ?
        `)
        .get(fixtureApplicationId, commit) !== undefined
    );
  }

  function activateInitialPolicy(now: string): void {
    const registration: FixtureCodebaseRegistration = {
      applicationId: fixtureApplicationId,
      liveCheckoutPath: "/fixture/live",
      productionBranch: "main",
      registeredAt: now,
      repository: fixtureRepository,
      sourceCheckoutRoot: "/fixture/source",
    };
    const contract: FixtureDeploymentContract = {
      activatedAt: now,
      activatedBy: "fresh-passkey-action",
      applicationId: fixtureApplicationId,
      buildCommand: "pnpm build",
      health: { expectedStatus: 204, path: "/health" },
      preflightCommand: "pnpm test --run",
      releaseRoot: "/fixture/releases",
      revision: 1,
      source: "voice-agent-policy",
    };
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_registrations (
          application_id, definition_json
        ) VALUES (?, ?)
      `)
      .run(fixtureApplicationId, JSON.stringify(registration));
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_contracts (
          application_id, revision, definition_json
        ) VALUES (?, ?, ?)
      `)
      .run(fixtureApplicationId, contract.revision, JSON.stringify(contract));
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_active_contracts (
          application_id, revision
        ) VALUES (?, ?)
      `)
      .run(fixtureApplicationId, contract.revision);
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_application_state (
          application_id, active_release_json, consecutive_failures, circuit_state
        ) VALUES (?, NULL, 0, 'closed')
      `)
      .run(fixtureApplicationId);
  }

  const activateContractTransaction = database.transaction(
    (contract: FixtureDeploymentContract): FixtureDeploymentContract => {
      const existing = database
        .prepare(`
          SELECT 1
          FROM promotion_contracts
          WHERE application_id = ? AND revision = ?
        `)
        .get(contract.applicationId, contract.revision);
      if (existing !== undefined) {
        throw new Error(
          `Deployment Contract revision ${contract.revision} already exists`,
        );
      }
      const active = findActiveContract();
      if (!Number.isInteger(contract.revision) || contract.revision <= active.revision) {
        throw new Error("Deployment Contract revisions must increase");
      }
      const registration = findRegistration();
      if (
        contract.releaseRoot === registration.liveCheckoutPath ||
        contract.releaseRoot.startsWith(`${registration.liveCheckoutPath}/`) ||
        !contract.releaseRoot.startsWith("/fixture/releases")
      ) {
        throw new Error("Deployment Contract Release root is outside policy");
      }
      database
        .prepare(`
          INSERT INTO promotion_contracts (
            application_id, revision, definition_json
          ) VALUES (?, ?, ?)
        `)
        .run(
          contract.applicationId,
          contract.revision,
          JSON.stringify(contract),
        );
      database
        .prepare(`
          INSERT INTO promotion_active_contracts (application_id, revision)
          VALUES (?, ?)
          ON CONFLICT(application_id) DO UPDATE SET revision = excluded.revision
        `)
        .run(contract.applicationId, contract.revision);
      return findActiveContract();
    },
  );

  const persistAcceptedTransaction = database.transaction(
    (input: {
      readonly attemptId: string;
      readonly contract: FixtureDeploymentContract;
      readonly deliveryId: string;
      readonly event: FixtureGitHubEvent;
      readonly now: string;
      readonly source: "reconciliation" | "webhook";
      readonly taskId: string;
    }): PromotionEvidenceRecordProjection => {
      const applicationState = readApplicationState();
      const sequence = database
        .prepare(`
          SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS sequence
          FROM promotion_attempts
        `)
        .get() as { readonly sequence: number };
      const merge = projectMerge(input);
      database
        .prepare(`
          INSERT INTO promotion_records (
            id, status, question, conclusion, created_at, updated_at,
            merge_json, contract_json, denial_reason, rollback_json,
            circuit_state, consecutive_failures
          ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `)
        .run(
          input.taskId,
          `Promote ${input.event.repository}@${input.event.commit}`,
          `Promotion for ${input.event.commit} is queued.`,
          input.now,
          input.now,
          JSON.stringify(merge),
          JSON.stringify(input.contract),
          JSON.stringify({ performed: false }),
          applicationState.circuit_state,
          applicationState.consecutive_failures,
        );
      database
        .prepare(`
          INSERT INTO promotion_delivery_identities (
            delivery_id, record_id, received_at
          ) VALUES (?, ?, ?)
        `)
        .run(input.deliveryId, input.taskId, input.now);
      database
        .prepare(`
          INSERT INTO promotion_attempts (
            id, record_id, application_id, merge_commit, queue_sequence,
            status, contract_json, release_json, verification_json, rollback_json
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?)
        `)
        .run(
          input.attemptId,
          input.taskId,
          fixtureApplicationId,
          input.event.commit,
          sequence.sequence,
          JSON.stringify(input.contract),
          JSON.stringify({ performed: false }),
        );
      appendEvidence(
        input.taskId,
        `${input.taskId}:merge`,
        input.source === "reconciliation"
          ? "reconciliation.discovered"
          : "merge.accepted",
        input.now,
        input.source === "reconciliation"
          ? `Reconciliation discovered missed Human Merge ${input.event.commit}.`
          : `Authenticated Human Merge ${input.event.commit} accepted.`,
        {
          actor: input.event.mergedBy?.login ?? "unknown",
          beforeCommit: input.event.beforeCommit,
          commit: input.event.commit,
          deliveryId: input.deliveryId,
        },
      );
      appendEvidence(
        input.taskId,
        `${input.taskId}:queued`,
        "promotion.queued",
        input.now,
        `Promotion Attempt ${input.attemptId} queued without coalescing.`,
        {
          attemptId: input.attemptId,
          contractRevision: input.contract.revision,
          queueSequence: sequence.sequence,
        },
      );
      return requireRecord(findRecord(input.taskId));
    },
  );

  const persistDeniedTransaction = database.transaction(
    (input: {
      readonly authenticated: boolean;
      readonly deliveryId: string;
      readonly duplicate: boolean;
      readonly event: FixtureGitHubEvent;
      readonly now: string;
      readonly reason: string;
      readonly taskId: string;
    }): PromotionEvidenceRecordProjection => {
      const applicationState = readApplicationState();
      const merge = projectMerge({
        deliveryId: input.deliveryId,
        event: input.event,
        source: "webhook",
      });
      database
        .prepare(`
          INSERT INTO promotion_records (
            id, status, question, conclusion, created_at, updated_at,
            merge_json, contract_json, denial_reason, rollback_json,
            circuit_state, consecutive_failures
          ) VALUES (?, 'denied', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `)
        .run(
          input.taskId,
          `Evaluate GitHub delivery ${input.deliveryId}`,
          `GitHub delivery denied: ${input.reason}.`,
          input.now,
          input.now,
          JSON.stringify(merge),
          input.reason,
          JSON.stringify({ performed: false }),
          applicationState.circuit_state,
          applicationState.consecutive_failures,
        );
      if (input.authenticated && !input.duplicate) {
        database
          .prepare(`
            INSERT INTO promotion_delivery_identities (
              delivery_id, record_id, received_at
            ) VALUES (?, ?, ?)
          `)
          .run(input.deliveryId, input.taskId, input.now);
      }
      appendEvidence(
        input.taskId,
        `${input.taskId}:denied`,
        input.duplicate ? "delivery.duplicate" : "delivery.denied",
        input.now,
        input.duplicate
          ? `Duplicate delivery ${input.deliveryId} ignored.`
          : `GitHub delivery denied: ${input.reason}.`,
        {
          authenticated: input.authenticated,
          deliveryId: input.deliveryId,
          reason: input.reason,
        },
      );
      return requireRecord(findRecord(input.taskId));
    },
  );

  function claimNext(now: string): AttemptRow | undefined {
    const claimTransaction = database.transaction(() => {
      const running = database
        .prepare(`
          SELECT id, record_id, merge_commit, queue_sequence, status,
            contract_json, release_json, verification_json, rollback_json,
            previous_release_json
          FROM promotion_attempts
          WHERE status = 'running'
          ORDER BY queue_sequence
          LIMIT 1
        `)
        .get() as AttemptRow | undefined;
      if (running !== undefined) return running;
      const applicationState = readApplicationState();
      if (applicationState.circuit_state === "half-open") return undefined;
      const attempt = database
        .prepare(`
          SELECT id, record_id, merge_commit, queue_sequence, status,
            contract_json, release_json, verification_json, rollback_json,
            previous_release_json
          FROM promotion_attempts
          WHERE status = 'queued'
            AND (
              ? != 'open'
              OR queue_sequence > ?
            )
          ORDER BY queue_sequence
          LIMIT 1
        `)
        .get(
          applicationState.circuit_state,
          applicationState.circuit_opened_queue_sequence ?? Number.MAX_SAFE_INTEGER,
        ) as AttemptRow | undefined;
      if (attempt === undefined) return undefined;
      const claim = database
        .prepare(`
          UPDATE promotion_attempts
          SET status = 'running'
          WHERE id = ? AND status = 'queued'
        `)
        .run(attempt.id);
      if (claim.changes !== 1) return undefined;
      if (applicationState.circuit_state === "open") {
        database
          .prepare(`
            UPDATE promotion_application_state
            SET circuit_state = 'half-open'
            WHERE application_id = ? AND circuit_state = 'open'
          `)
          .run(fixtureApplicationId);
        database
          .prepare(`
            UPDATE promotion_records
            SET circuit_state = 'half-open'
            WHERE id = ?
          `)
          .run(attempt.record_id);
        appendEvidence(
          attempt.record_id,
          `${attempt.id}:circuit-half-open`,
          "circuit.changed",
          now,
          "Deployment Circuit Breaker entered half-open for one recovery attempt.",
          { state: "half-open" },
        );
      }
      database
        .prepare(`
          UPDATE promotion_records
          SET status = 'running', conclusion = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          `Promotion for ${attempt.merge_commit} is running.`,
          now,
          attempt.record_id,
        );
      return findAttempt(attempt.id);
    });
    return claimTransaction.immediate();
  }

  function performOperation(input: {
    readonly actualHealthStatus: number;
    readonly attempt: AttemptRow;
    readonly contract: FixtureDeploymentContract;
    readonly kind: PromotionOperationProjection["kind"];
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
  }): PromotionOperationProjection {
    const operationId = `${input.attempt.id}:${input.kind}`;
    const existing = database
      .prepare("SELECT operation_json FROM promotion_operations WHERE operation_id = ?")
      .get(operationId) as { readonly operation_json: string } | undefined;
    if (existing !== undefined) {
      return parseStored(
        existing.operation_json,
        promotionOperationProjectionSchema,
      );
    }
    const operation: PromotionOperationProjection =
      input.kind === "release.build"
        ? {
            command: input.contract.buildCommand,
            kind: input.kind,
            operationId,
            outcome: "completed",
            releasePath: input.release.path,
            sourcePath: `/fixture/source/${input.attempt.merge_commit}`,
          }
        : input.kind === "release.preflight"
          ? {
              command: input.contract.preflightCommand,
              kind: input.kind,
              operationId,
              outcome: "passed",
            }
          : input.kind === "release.verify"
            ? {
                actualStatus: input.actualHealthStatus,
                kind: input.kind,
                operationId,
                outcome:
                  input.actualHealthStatus === input.contract.health.expectedStatus
                    ? "healthy"
                    : "unhealthy",
              }
            : input.kind === "release.rollback"
              ? {
                  kind: input.kind,
                  operationId,
                  outcome: "completed",
                  ...(findAttempt(input.attempt.id).previous_release_json === null
                    ? {}
                    : {
                        restoredReleaseId: parseStored(
                          findAttempt(input.attempt.id).previous_release_json ??
                            "null",
                          promotionReleaseProjectionSchema,
                        ).id,
                      }),
                }
            : {
                kind: input.kind,
                operationId,
                outcome: "completed",
              };
    const persist = database.transaction(() => {
      if (input.kind === "release.switch") {
        const environment = database
          .prepare(`
            SELECT active_release_json
            FROM promotion_environment
            WHERE application_id = ?
          `)
          .get(fixtureApplicationId) as {
          readonly active_release_json: string | null;
        };
        database
          .prepare(`
            UPDATE promotion_attempts
            SET previous_release_json = ?
            WHERE id = ? AND previous_release_json IS NULL
          `)
          .run(environment.active_release_json, input.attempt.id);
        database
          .prepare(`
            UPDATE promotion_environment
            SET active_release_json = ?
            WHERE application_id = ?
          `)
          .run(JSON.stringify(input.release), fixtureApplicationId);
      } else if (input.kind === "release.rollback") {
        const currentAttempt = findAttempt(input.attempt.id);
        database
          .prepare(`
            UPDATE promotion_environment
            SET active_release_json = ?
            WHERE application_id = ?
          `)
          .run(currentAttempt.previous_release_json, fixtureApplicationId);
      }
      database
        .prepare(`
          INSERT INTO promotion_operations (
            operation_id, attempt_id, kind, operation_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(operationId, input.attempt.id, input.kind, JSON.stringify(operation));
    });
    persist.immediate();
    return operation;
  }

  const completeHealthyTransaction = database.transaction(
    (input: {
      readonly attemptId: string;
      readonly now: string;
      readonly release: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["release"]
      >;
      readonly verification: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["verification"]
      >;
    }): PromotionEvidenceRecordProjection => {
      const attempt = findAttempt(input.attemptId);
      const previousCircuit = readApplicationState();
      database
        .prepare(`
          UPDATE promotion_attempts
          SET status = 'succeeded', release_json = ?, verification_json = ?
          WHERE id = ?
        `)
        .run(JSON.stringify(input.release), JSON.stringify(input.verification), input.attemptId);
      database
        .prepare(`
          UPDATE promotion_application_state
          SET active_release_json = ?, consecutive_failures = 0,
            circuit_state = 'closed', circuit_opened_queue_sequence = NULL
          WHERE application_id = ?
        `)
        .run(JSON.stringify(input.release), fixtureApplicationId);
      database
        .prepare(`
          UPDATE promotion_records
          SET status = 'completed', conclusion = ?, updated_at = ?,
            circuit_state = 'closed', consecutive_failures = 0
          WHERE id = ?
        `)
        .run(
          `Release ${attempt.merge_commit} is active and healthy.`,
          input.now,
          attempt.record_id,
        );
      if (previousCircuit.circuit_state !== "closed") {
        appendEvidence(
          attempt.record_id,
          `${attempt.id}:circuit-closed`,
          "circuit.changed",
          input.now,
          "Healthy verification closed the Deployment Circuit Breaker.",
          { state: "closed" },
        );
      }
      return requireRecord(findRecord(attempt.record_id));
    },
  );

  const completeUnhealthyTransaction = database.transaction(
    (input: {
      readonly attemptId: string;
      readonly now: string;
      readonly release: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["release"]
      >;
      readonly verification: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["verification"]
      >;
    }): PromotionEvidenceRecordProjection => {
      const attempt = findAttempt(input.attemptId);
      const applicationState = readApplicationState();
      const consecutiveFailures = applicationState.consecutive_failures + 1;
      const circuitState = consecutiveFailures >= 3 ? "open" : "closed";
      const latestAcceptedSequence = database
        .prepare(`
          SELECT COALESCE(MAX(queue_sequence), 0) AS queue_sequence
          FROM promotion_attempts
          WHERE application_id = ?
        `)
        .get(fixtureApplicationId) as { readonly queue_sequence: number };
      const restoredRelease =
        attempt.previous_release_json === null
          ? undefined
          : parseStored(
              attempt.previous_release_json,
              promotionReleaseProjectionSchema,
            );
      const rollback: PromotionEvidenceRecordProjection["promotion"]["rollback"] = {
        attemptedReleaseId: input.release.id,
        performed: true,
        ...(restoredRelease === undefined
          ? {}
          : { restoredReleaseId: restoredRelease.id }),
      };
      database
        .prepare(`
          UPDATE promotion_attempts
          SET status = 'rolled-back', release_json = ?, verification_json = ?,
            rollback_json = ?
          WHERE id = ?
        `)
        .run(
          JSON.stringify(input.release),
          JSON.stringify(input.verification),
          JSON.stringify(rollback),
          input.attemptId,
        );
      database
        .prepare(`
          UPDATE promotion_application_state
          SET active_release_json = ?, consecutive_failures = ?,
            circuit_state = ?, circuit_opened_queue_sequence = ?
          WHERE application_id = ?
        `)
        .run(
          attempt.previous_release_json,
          consecutiveFailures,
          circuitState,
          circuitState === "open" ? latestAcceptedSequence.queue_sequence : null,
          fixtureApplicationId,
        );
      const conclusion =
        restoredRelease === undefined
          ? `Release ${attempt.merge_commit} was unhealthy; no prior Release was available.`
          : `Release ${attempt.merge_commit} was unhealthy; ${restoredRelease.id} was restored.`;
      database
        .prepare(`
          UPDATE promotion_records
          SET status = 'completed', conclusion = ?, updated_at = ?,
            circuit_state = ?, consecutive_failures = ?, rollback_json = ?
          WHERE id = ?
        `)
        .run(
          conclusion,
          input.now,
          circuitState,
          consecutiveFailures,
          JSON.stringify(rollback),
          attempt.record_id,
        );
      if (circuitState === "open") {
        appendEvidence(
          attempt.record_id,
          `${attempt.id}:circuit-open`,
          "circuit.changed",
          input.now,
          applicationState.circuit_state === "half-open"
            ? "The failed half-open attempt reopened the Deployment Circuit Breaker."
            : "Three consecutive failures opened the Deployment Circuit Breaker.",
          { consecutiveFailures, state: "open" },
        );
      }
      return requireRecord(findRecord(attempt.record_id));
    },
  );

  function inspect(): PromotionStoreInspection {
    const environment = database
      .prepare(`
        SELECT active_release_json
        FROM promotion_environment
        WHERE application_id = ?
      `)
      .get(fixtureApplicationId) as {
      readonly active_release_json: string | null;
    };
    const operations = database
      .prepare("SELECT operation_json FROM promotion_operations ORDER BY rowid")
      .all() as Array<{ readonly operation_json: string }>;
    const attempts = database
      .prepare(`
        SELECT id, merge_commit, queue_sequence, status
        FROM promotion_attempts
        ORDER BY queue_sequence
      `)
      .all() as Array<{
      readonly id: string;
      readonly merge_commit: string;
      readonly queue_sequence: number;
      readonly status: AttemptRow["status"];
    }>;
    return {
      ...(environment.active_release_json === null
        ? {}
        : {
            activeRelease: parseStored(
              environment.active_release_json,
              promotionReleaseProjectionSchema,
            ),
          }),
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        mergeCommit: attempt.merge_commit,
        queueSequence: attempt.queue_sequence,
        status: attempt.status,
      })),
      operations: operations.map((operation) =>
        parseStored(operation.operation_json, promotionOperationProjectionSchema),
      ),
    };
  }

  const reorderQueuedAttemptsTransaction = database.transaction(() => {
    const queued = database
      .prepare(`
        SELECT promotion_attempts.id, promotion_attempts.queue_sequence,
          promotion_records.merge_json
        FROM promotion_attempts
        JOIN promotion_records
          ON promotion_records.id = promotion_attempts.record_id
        WHERE promotion_attempts.status = 'queued'
        ORDER BY promotion_attempts.queue_sequence
      `)
      .all() as Array<{
      readonly id: string;
      readonly merge_json: string;
      readonly queue_sequence: number;
    }>;
    const remaining = queued.map((attempt) => ({
      ...attempt,
      merge: parseStored(attempt.merge_json, promotionMergeProjectionSchema),
    }));
    const ordered: typeof remaining = [];
    while (remaining.length > 0) {
      const remainingCommits = new Set(
        remaining.map((attempt) => attempt.merge.commit),
      );
      const nextIndex = remaining.findIndex(
        (attempt) => !remainingCommits.has(attempt.merge.beforeCommit),
      );
      if (nextIndex === -1) {
        throw new Error("Queued Promotion Attempts are not an ordered merge chain");
      }
      const [next] = remaining.splice(nextIndex, 1);
      if (next !== undefined) ordered.push(next);
    }
    const terminal = database
      .prepare(`
        SELECT COALESCE(MAX(queue_sequence), 0) AS queue_sequence
        FROM promotion_attempts
        WHERE status != 'queued'
      `)
      .get() as { readonly queue_sequence: number };
    database
      .prepare(`
        UPDATE promotion_attempts
        SET queue_sequence = -queue_sequence
        WHERE status = 'queued'
      `)
      .run();
    const updateSequence = database.prepare(`
      UPDATE promotion_attempts
      SET queue_sequence = ?
      WHERE id = ? AND status = 'queued'
    `);
    ordered.forEach((attempt, index) => {
      updateSequence.run(terminal.queue_sequence + index + 1, attempt.id);
    });
  });

  return {
    activateContract(contract) {
      return activateContractTransaction.immediate(contract);
    },
    activateInitialPolicy,
    appendEvidence,
    claimNext,
    close() {
      database.close();
    },
    completeHealthy(input) {
      return completeHealthyTransaction.immediate(input);
    },
    completeUnhealthy(input) {
      return completeUnhealthyTransaction.immediate(input);
    },
    findActiveContract,
    findRecord,
    findRegistration,
    hasAttempt,
    hasDelivery,
    inspect,
    performOperation,
    persistAccepted(input) {
      return persistAcceptedTransaction.immediate(input);
    },
    persistDenied(input) {
      return persistDeniedTransaction.immediate(input);
    },
    reorderQueuedAttempts() {
      reorderQueuedAttemptsTransaction.immediate();
    },
  };
}

function createPromotionSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS promotion_registrations (
      application_id TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_contracts (
      application_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      PRIMARY KEY (application_id, revision)
    );

    CREATE TABLE IF NOT EXISTS promotion_active_contracts (
      application_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      FOREIGN KEY (application_id, revision)
        REFERENCES promotion_contracts(application_id, revision)
    );

    CREATE TABLE IF NOT EXISTS promotion_records (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      merge_json TEXT NOT NULL,
      contract_json TEXT,
      denial_reason TEXT,
      rollback_json TEXT NOT NULL,
      circuit_state TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_delivery_identities (
      delivery_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES promotion_records(id),
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_attempts (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL UNIQUE REFERENCES promotion_records(id),
      application_id TEXT NOT NULL,
      merge_commit TEXT NOT NULL,
      queue_sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      release_json TEXT,
      verification_json TEXT,
      rollback_json TEXT NOT NULL,
      previous_release_json TEXT,
      UNIQUE (application_id, merge_commit)
    );

    CREATE TABLE IF NOT EXISTS promotion_evidence_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES promotion_records(id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      UNIQUE (record_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS promotion_operations (
      operation_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES promotion_attempts(id),
      kind TEXT NOT NULL,
      operation_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_application_state (
      application_id TEXT PRIMARY KEY,
      active_release_json TEXT,
      consecutive_failures INTEGER NOT NULL,
      circuit_state TEXT NOT NULL,
      circuit_opened_queue_sequence INTEGER
    );

    CREATE TABLE IF NOT EXISTS promotion_environment (
      application_id TEXT PRIMARY KEY,
      active_release_json TEXT
    );

    INSERT OR IGNORE INTO promotion_environment (
      application_id, active_release_json
    ) VALUES ('fixture-production', NULL);

    CREATE TRIGGER IF NOT EXISTS promotion_contracts_no_update
    BEFORE UPDATE ON promotion_contracts
    BEGIN
      SELECT RAISE(ABORT, 'Deployment Contract revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_contracts_no_delete
    BEFORE DELETE ON promotion_contracts
    BEGIN
      SELECT RAISE(ABORT, 'Deployment Contract revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_evidence_no_update
    BEFORE UPDATE ON promotion_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Promotion Evidence Events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_evidence_no_delete
    BEFORE DELETE ON promotion_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Promotion Evidence Events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_operations_no_update
    BEFORE UPDATE ON promotion_operations
    BEGIN
      SELECT RAISE(ABORT, 'Promotion Operations are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_operations_no_delete
    BEFORE DELETE ON promotion_operations
    BEGIN
      SELECT RAISE(ABORT, 'Promotion Operations are immutable');
    END;
  `);
}

interface StoredValueSchema<T> {
  parse(value: unknown): T;
}

function parseStored<T>(value: string, schema: StoredValueSchema<T>): T {
  return schema.parse(JSON.parse(value));
}

function requireRecord(
  record: PromotionEvidenceRecordProjection | undefined,
): PromotionEvidenceRecordProjection {
  if (record === undefined) throw new Error("Promotion Evidence Record is unavailable");
  return record;
}
