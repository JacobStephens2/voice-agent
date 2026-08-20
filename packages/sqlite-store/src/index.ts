import Database from "better-sqlite3";
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import {
  bountywellHealthObservationSchema,
  bountywellRegistrationSchema,
  evidenceRecordProjectionSchema,
  evidenceRecordSummarySchema,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import type {
  AcceptedInquiryPersistence,
  AcceptedOperationPersistence,
  ApplicationRegistry,
  AppendedEvidencePersistence,
  CancellationRequestPersistence,
  ClaimedBountywellOperation,
  CompletedInquiryPersistence,
  CompletedOperationPersistence,
  DurableTaskStore,
  StoredOperation,
} from "@voice-agent/durable-store";
import {
  createBountywellReadRegistration,
  createBountywellRestartRegistration,
} from "@voice-agent/policy";

export { createSqliteAuthenticationStore } from "./authentication.ts";
export {
  createSqliteKeeploreOnboardingStore,
  type SqliteKeeploreOnboardingStore,
} from "./keeplore-onboarding.ts";
export { createSqliteCallbackHandshakeStore } from "./callback-handshake.ts";
export { createSqliteTelephoneBoundaryStore } from "./telephone-boundaries.ts";
export { createSqliteTaskContinuityStore } from "./task-continuity.ts";
export {
  backupSqliteDatabase,
  restoreSqliteDatabase,
  verifyVoiceAgentDatabase,
} from "./database-maintenance.ts";

interface TaskRow {
  readonly cancellation_requested_at: string | null;
  readonly conclusion: string;
  readonly created_at: string;
  readonly id: string;
  readonly kind: "bountywell.health.inquiry" | "bountywell.outage.recovery";
  readonly question:
    | "Bountywell's API appears unavailable."
    | "Is Bountywell healthy?"
    | "Is the guarded Bountywell Outage Drill ready?";
  readonly status: "cancelled" | "completed" | "pending";
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

interface EvidenceEventIdentityRow {
  readonly task_id: string;
}

interface OperationRow {
  readonly id: string;
  readonly kind: StoredOperation["kind"];
  readonly status: "accepted" | "completed" | "running";
  readonly task_id: string;
}

interface SpeechTimingMetricRow {
  readonly count: number;
  readonly provider: string;
  readonly stage: string;
  readonly total_duration_ms: number;
}

export function createSqliteDurableTaskStore(
  databasePath: string,
): DurableTaskStore & ApplicationRegistry {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const findTaskByRequest = database.prepare<[requestId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at,
      cancellation_requested_at
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
    SELECT id, kind, status, question, conclusion, created_at, updated_at,
      cancellation_requested_at
    FROM durable_tasks
    WHERE request_id = ?
  `);
  const findTaskById = database.prepare<[taskId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at,
      cancellation_requested_at
    FROM durable_tasks
    WHERE id = ?
  `);
  const findLiveTaskById = database.prepare<[taskId: string], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at,
      cancellation_requested_at
    FROM durable_tasks
    WHERE id = ?
  `);
  const findTaskByOperation = database.prepare<[operationId: string], TaskRow>(`
    SELECT
      durable_tasks.id,
      durable_tasks.kind,
      durable_tasks.status,
      durable_tasks.question,
      durable_tasks.conclusion,
      durable_tasks.created_at,
      durable_tasks.updated_at,
      durable_tasks.cancellation_requested_at
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
  const findEventById = database.prepare<
    [eventId: string],
    EvidenceEventIdentityRow
  >(`
    SELECT task_id FROM evidence_events WHERE id = ?
  `);
  const listTasks = database.prepare<[], TaskRow>(`
    SELECT id, kind, status, question, conclusion, created_at, updated_at,
      cancellation_requested_at
    FROM durable_tasks
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
    SELECT operations.id, operations.task_id, operations.status, operations.kind
    FROM operations
    JOIN durable_tasks ON durable_tasks.id = operations.task_id
    WHERE operations.kind = 'bountywell.health.observe'
      AND durable_tasks.kind = 'bountywell.health.inquiry'
      AND durable_tasks.status = 'pending'
      AND durable_tasks.cancellation_requested_at IS NULL
      AND (
        operations.status = 'accepted'
        OR (
          operations.status = 'running'
          AND operations.lease_expires_at <= ?
        )
      )
    ORDER BY operations.created_at, operations.id
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
    SELECT id, task_id, status, kind
    FROM operations
    WHERE id = ?
  `);
  const listOperationsByTask = database.prepare<[taskId: string], OperationRow>(`
    SELECT id, task_id, status, kind
    FROM operations
    WHERE task_id = ?
    ORDER BY created_at, id
  `);
  const findOperationByIdempotencyKey = database.prepare<
    [idempotencyKey: string],
    OperationRow
  >(`
    SELECT id, task_id, status, kind
    FROM operations
    WHERE idempotency_key = ?
  `);
  const completeOperation = database.prepare(`
    UPDATE operations
    SET status = 'completed', result_json = ?, updated_at = ?,
      lease_expires_at = NULL
    WHERE id = ? AND task_id = ? AND status = 'running'
  `);
  const updatePendingTaskSummary = database.prepare(`
    UPDATE durable_tasks
    SET conclusion = ?, question = COALESCE(?, question), updated_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const completeTask = database.prepare(`
    UPDATE durable_tasks
    SET status = 'completed', conclusion = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const completeAcceptedOrRunningOperation = database.prepare(`
    UPDATE operations
    SET status = 'completed', result_json = ?, updated_at = ?,
      lease_expires_at = NULL
    WHERE id = ? AND task_id = ? AND status IN ('accepted', 'running')
  `);
  const cancelTask = database.prepare(`
    UPDATE durable_tasks
    SET status = 'cancelled', conclusion = 'Bountywell inquiry cancelled.',
      updated_at = ?, cancellation_requested_at = COALESCE(cancellation_requested_at, ?)
    WHERE id = ? AND status = 'pending'
  `);
  const requestCancellation = database.prepare(`
    UPDATE durable_tasks
    SET cancellation_requested_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const findRunningTaskOperation = database.prepare<
    [taskId: string],
    { readonly id: string }
  >(`
    SELECT id FROM operations
    WHERE task_id = ? AND kind = 'bountywell.health.observe' AND status = 'running'
    LIMIT 1
  `);
  const findCancellationRequest = database.prepare<
    [requestId: string],
    { readonly task_id: string }
  >(`
    SELECT task_id FROM task_cancellation_requests WHERE request_id = ?
  `);
  const insertCancellationRequest = database.prepare(`
    INSERT INTO task_cancellation_requests (request_id, task_id, operation_id)
    VALUES (?, ?, ?)
  `);
  const updateTaskTimestamp = database.prepare(`
    UPDATE durable_tasks
    SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
    WHERE id = ?
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
  const readNotificationMetrics = database.prepare<
    [],
    { readonly requested: number; readonly sent: number }
  >(`
    SELECT
      SUM(CASE WHEN kind = 'notification.requested' THEN 1 ELSE 0 END) AS requested,
      SUM(CASE WHEN kind = 'notification.sent' THEN 1 ELSE 0 END) AS sent
    FROM evidence_events
  `);
  const readSpeechTimingMetrics = database.prepare<[], SpeechTimingMetricRow>(`
    SELECT
      stage,
      provider,
      COUNT(*) AS count,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms
    FROM (
      SELECT
        json_extract(details_json, '$.stage') AS stage,
        CASE json_extract(details_json, '$.provider')
          WHEN 'assemblyai' THEN 'assemblyai'
          WHEN 'inworld' THEN 'inworld'
          WHEN 'openai' THEN 'openai'
          ELSE 'other'
        END AS provider,
        json_extract(details_json, '$.durationMs') AS duration_ms
      FROM evidence_events
      WHERE kind = 'telephone.provider.timing'
    ) AS sanitized_speech_timing
    GROUP BY stage, provider
  `);
  const readTelephoneConversationMetrics = database.prepare<
    [],
    { readonly interruptions: number; readonly turns: number }
  >(`
    SELECT
      SUM(CASE WHEN kind = 'telephone.response.interrupted' THEN 1 ELSE 0 END) AS interruptions,
      SUM(CASE WHEN kind = 'telephone.turn.finalized' THEN 1 ELSE 0 END) AS turns
    FROM evidence_events
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
    WHERE occurred_at < ?
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
      if (operationId !== undefined) {
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
      }
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
      const task = requireTask(findTaskById.get(input.taskId));
      const cancellationRequested = task.cancellation_requested_at !== null;
      const taskResult = cancellationRequested
        ? cancelTask.run(input.observedAt, input.observedAt, input.taskId)
        : completeTask.run(
            input.conclusion,
            input.observedAt,
            input.taskId,
          );
      if (operationResult.changes !== 1 || taskResult.changes !== 1) {
        throw new Error("Claimed Bountywell Operation changed concurrently");
      }
      insertEvidence(
        input.taskId,
        cancellationRequested
          ? input.evidence.map((event) =>
              event.kind === "task.completed"
                ? {
                    ...event,
                    kind: "task.cancelled" as const,
                    summary: "The Durable Task stopped at a safe boundary.",
                  }
                : event,
            )
          : input.evidence,
      );
      return loadRecord(requireTask(findTaskById.get(input.taskId)));
    },
  );

  const appendEvidenceTransaction = database.transaction(
    (input: AppendedEvidencePersistence): EvidenceRecordProjection => {
      const task = findTaskById.get(input.taskId);
      if (task === undefined) {
        throw new Error("Durable Task is unavailable");
      }
      const existing = findEventById.get(input.event.id);
      if (existing !== undefined) {
        if (existing.task_id !== input.taskId) {
          throw new Error("Evidence Event identity belongs to another Durable Task");
        }
        return loadRecord(task);
      }
      const previous = findEventsByTask.all(input.taskId).at(-1);
      insertEvidence(input.taskId, [
        {
          ...input.event,
          sequence: (previous?.sequence ?? 0) + 1,
        } as EvidenceEventProjection,
      ]);
      updateTaskTimestamp.run(input.updatedAt, input.updatedAt, input.taskId);
      return loadRecord(requireTask(findTaskById.get(input.taskId)));
    },
  );

  const cancellationTransaction = database.transaction(
    (input: CancellationRequestPersistence): EvidenceRecordProjection => {
      const duplicate = findCancellationRequest.get(input.requestId);
      if (duplicate !== undefined) {
        return loadRecord(requireTask(findTaskById.get(duplicate.task_id)));
      }
      const task = requireTask(findTaskById.get(input.taskId));
      insertCancellationRequest.run(
        input.requestId,
        input.taskId,
        input.operationId,
      );
      if (task.status !== "pending" || task.cancellation_requested_at !== null) {
        return loadRecord(task);
      }
      insertOperation.run(
        input.operationId,
        input.taskId,
        `task-cancellation:${input.requestId}`,
        "task.cancel",
        "completed",
        JSON.stringify({ requested: true }),
        input.requestedAt,
        input.requestedAt,
      );
      const previousSequence = findEventsByTask.all(input.taskId).at(-1)?.sequence ?? 0;
      const evidence: EvidenceEventProjection[] = [
        {
          details: { operationId: input.operationId },
          id: input.requestedEventId,
          kind: "task.cancellation.requested",
          occurredAt: input.requestedAt,
          sequence: previousSequence + 1,
          summary: "A stop request was accepted for this Durable Task.",
        },
        {
          details: { operationId: input.operationId },
          id: input.acceptedEventId,
          kind: "operation.accepted",
          occurredAt: input.requestedAt,
          sequence: previousSequence + 2,
          summary: "The cancellation Operation was accepted.",
        },
        {
          details: { operationId: input.operationId },
          id: input.completedEventId,
          kind: "operation.completed",
          occurredAt: input.requestedAt,
          sequence: previousSequence + 3,
          summary: "The cancellation Operation completed.",
        },
      ];
      const running = findRunningTaskOperation.get(input.taskId) !== undefined;
      requestCancellation.run(
        input.requestedAt,
        input.requestedAt,
        input.taskId,
      );
      if (!running) {
        cancelTask.run(input.requestedAt, input.requestedAt, input.taskId);
        evidence.push({
          details: {},
          id: input.cancelledEventId,
          kind: "task.cancelled",
          occurredAt: input.requestedAt,
          sequence: previousSequence + 4,
          summary: "The Durable Task stopped before future work began.",
        });
      }
      insertEvidence(input.taskId, evidence);
      return loadRecord(requireTask(findTaskById.get(input.taskId)));
    },
  );

  const persistAcceptedOperationTransaction = database.transaction(
    (input: AcceptedOperationPersistence): EvidenceRecordProjection => {
      const existing =
        findOperation.get(input.operationId) ??
        findOperationByIdempotencyKey.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.task_id !== input.taskId) {
          throw new Error("Operation identity belongs to another Durable Task");
        }
        return loadRecord(requireTask(findTaskById.get(input.taskId)));
      }
      insertOperation.run(
        input.operationId,
        input.taskId,
        input.idempotencyKey,
        input.kind,
        "accepted",
        "{}",
        input.acceptedAt,
        input.acceptedAt,
      );
      insertEvidence(input.taskId, input.evidence);
      updateTaskTimestamp.run(input.acceptedAt, input.acceptedAt, input.taskId);
      return loadRecord(requireTask(findTaskById.get(input.taskId)));
    },
  );

  const completeOperationTransaction = database.transaction(
    (input: CompletedOperationPersistence): EvidenceRecordProjection => {
      const operation = findOperation.get(input.operationId);
      if (operation === undefined || operation.task_id !== input.taskId) {
        throw new Error("Bountywell Operation is unavailable");
      }
      if (operation.status === "completed") {
        return loadRecord(requireTask(findTaskById.get(input.taskId)));
      }
      const result = completeAcceptedOrRunningOperation.run(
        JSON.stringify({ completedAt: input.observedAt }),
        input.observedAt,
        input.operationId,
        input.taskId,
      );
      if (result.changes !== 1) {
        throw new Error("Bountywell Operation changed concurrently");
      }
      insertEvidence(input.taskId, input.evidence);
      if (input.task !== undefined) {
        const taskResult =
          input.task.status === "pending"
            ? updatePendingTaskSummary.run(
                input.task.conclusion,
                input.task.question ?? null,
                input.observedAt,
                input.taskId,
              )
            : input.task.status === "cancelled"
              ? cancelTask.run(
                  input.observedAt,
                  input.observedAt,
                  input.taskId,
                )
              : completeTask.run(
                  input.task.conclusion,
                  input.observedAt,
                  input.taskId,
                );
        if (taskResult.changes !== 1) {
          throw new Error("Bountywell Durable Task changed concurrently");
        }
      } else {
        updateTaskTimestamp.run(
          input.observedAt,
          input.observedAt,
          input.taskId,
        );
      }
      return loadRecord(requireTask(findTaskById.get(input.taskId)));
    },
  );

  const completeTaskTransaction = database.transaction(
    (input: {
      readonly conclusion: EvidenceRecordProjection["task"]["conclusion"];
      readonly evidence: readonly EvidenceEventProjection[];
      readonly observedAt: string;
      readonly taskId: string;
    }): EvidenceRecordProjection => {
      const task = requireTask(findTaskById.get(input.taskId));
      if (task.status !== "pending") return loadRecord(task);
      const result = completeTask.run(
        input.conclusion,
        input.observedAt,
        input.taskId,
      );
      if (result.changes !== 1) {
        throw new Error("Bountywell Durable Task changed concurrently");
      }
      insertEvidence(input.taskId, input.evidence);
      return loadRecord(requireTask(findTaskById.get(input.taskId)));
    },
  );

  const expireTransaction = database.transaction((cutoff: string) => {
    tombstoneExpiredRequests.run(cutoff, cutoff);
    deleteExpiredEvents.run(cutoff);
  });

  return {
    async applyEvidenceRetention(input) {
      expireTransaction.immediate(input.cutoff);
    },
    async appendEvidence(input) {
      return appendEvidenceTransaction.immediate(input);
    },
    async claimBountywellOperation(input) {
      return claimTransaction.immediate(input);
    },
    async close() {
      database.close();
    },
    async completeBountywellInquiry(input) {
      return completeTransaction.immediate(input);
    },
    async findByOperationId(operationId) {
      const task = findTaskByOperation.get(operationId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async findByRequestId(requestId) {
      const liveTask = findLiveTaskByRequest.get(requestId);
      if (liveTask !== undefined) return loadRecord(liveTask);
      return findExpiredRequest.get(requestId) === undefined
        ? undefined
        : { expired: true };
    },
    async findByTaskId(taskId) {
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
      return listTasks.all().map((task) =>
        evidenceRecordSummarySchema.parse({
          conclusion: task.conclusion,
          createdAt: task.created_at,
          id: task.id,
          kind: task.kind,
          question: task.question,
          status: task.status,
          updatedAt: task.updated_at,
        }),
      );
    },
    async readOperationalMetrics() {
      const taskMetrics = readTaskMetrics.get() ?? { completed: 0, pending: 0 };
      const operationMetrics = readOperationMetrics.get() ?? {
        accepted: 0,
        completed: 0,
        running: 0,
      };
      const latestObservation = readLatestObservation.get();
      const notificationMetrics = readNotificationMetrics.get() ?? {
        requested: 0,
        sent: 0,
      };
      const conversationMetrics = readTelephoneConversationMetrics.get() ?? {
        interruptions: 0,
        turns: 0,
      };
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
        notifications: {
          requested: notificationMetrics.requested ?? 0,
          sent: notificationMetrics.sent ?? 0,
        },
        policyDenials: readPolicyDenials.get()?.value ?? 0,
        speech: {
          interruptions: conversationMetrics.interruptions ?? 0,
          timings: readSpeechTimingMetrics
            .all()
            .flatMap((row) => {
              const stage = operationalSpeechStage(row.stage);
              if (stage === undefined) return [];
              return [{
                count: row.count,
                provider: operationalSpeechProvider(row.provider),
                stage,
                totalDurationMs: row.total_duration_ms,
              }];
            }),
          turns: conversationMetrics.turns ?? 0,
        },
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
    async requestCancellation(input) {
      return cancellationTransaction.immediate(input);
    },
    async persistAcceptedInquiry(input) {
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
    async persistAcceptedOperation(input) {
      return persistAcceptedOperationTransaction.immediate(input);
    },
    async completeBountywellOperation(input) {
      return completeOperationTransaction.immediate(input);
    },
    async completeBountywellTask(input) {
      return completeTaskTransaction.immediate(input);
    },
    async listOperations(taskId) {
      return listOperationsByTask.all(taskId).map((operation) => ({
        id: operation.id,
        kind: operation.kind,
        status: operation.status,
      }));
    },
    async grantBountywellRestart(registeredAt) {
      const row = findRegistration.get();
      if (row === undefined) {
        throw new Error("Bountywell is not registered");
      }
      const current = bountywellRegistrationSchema.parse(
        JSON.parse(row.definition_json),
      );
      if (
        current.capabilities.some(
          (capability) => capability === "bountywell.service.restart",
        )
      ) {
        return current;
      }
      const registration = createBountywellRestartRegistration(
        registeredAt,
        current.revision + 1,
      );
      insertRegistration.run(
        registration.applicationId,
        registration.revision,
        registration.registeredAt,
        JSON.stringify(registration),
      );
      return registration;
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

function operationalSpeechProvider(
  provider: string,
): "assemblyai" | "inworld" | "openai" | "other" {
  return provider === "assemblyai" || provider === "inworld" || provider === "openai"
    ? provider
    : "other";
}

function operationalSpeechStage(
  stage: string,
): "coordinator" | "stt" | "tts" | undefined {
  return stage === "coordinator" || stage === "stt" || stage === "tts"
    ? stage
    : undefined;
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

    CREATE TABLE IF NOT EXISTS task_cancellation_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES durable_tasks(id),
      operation_id TEXT NOT NULL UNIQUE
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
  ensureColumn(database, "durable_tasks", "cancellation_requested_at", "TEXT");
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
