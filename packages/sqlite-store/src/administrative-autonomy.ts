import { createHash } from "node:crypto";

import Database from "better-sqlite3";

import {
  administrativeActiveExecutionMilliseconds,
  administrativeAuthoritySnapshotSchema,
  administrativeEvidenceEventSchema,
  administrativeEvidenceRecordSchema,
  administrativeExecutionManifestFingerprint,
  administrativeExecutionManifestSchema,
  administrativeMutationOperationKinds,
  administrativeOperationRequestSchema,
  administrativeOperationResultSchema,
  administrativePolicyRevisionSchema,
  administrativePolicyActivationExpectationSchema,
  administrativePolicyEvidenceEventInputSchema,
  administrativePolicyEvidenceEventSchema,
  administrativePolicyEvidencePageRequestSchema,
  administrativePolicyEvidencePageSchema,
  administrativePolicyEvidenceProjectionSchema,
  administrativePolicySuspensionExpectationSchema,
  administrativePolicyStatusSchema,
  administrativeTaskIdSchema,
  administrativeTaskAuthoritySnapshot,
  administrativeTaskTargetBinding,
  administrativeTaskSchema,
  administrativeTimestampSchema,
  administrativeUnavailableExecutionManifest,
  livePatchRollbackActivationRequestSchema,
  livePatchRollbackActivationFailureReasonSchema,
  livePatchRollbackActivationResultSchema,
  isLivePatchMutationProofBoundToRequest,
  pendingLivePatchRollbackActivationSchema,
  livePatchRollbackWindowMilliseconds,
  sameAdministrativeAuthoritySnapshot,
  sameAdministrativeExecutionManifest,
  sameAdministrativeTaskTargetBinding,
  validateAdministrativeDelegatedWorktreeResultBinding,
  type AdministrativeAuthoritySnapshot,
  type AdministrativeExecutionManifest,
  type AdministrativeEvidenceEvent,
  type AdministrativeEvidenceRecord,
  type AdministrativeOperationKind,
  type AdministrativeOperationRequest,
  type AdministrativeOperationResult,
  type AdministrativePolicyStatus,
  type AdministrativePolicyEvidenceEvent,
  type AdministrativeTask,
  type LivePatchRollbackActivationResult,
} from "@voice-agent/contracts";
import type {
  AdministrativeAutonomyStore,
  AdministrativeConfirmationClaim,
  AdministrativeOperationClaim,
  AdministrativePlannedOperation,
  AdministrativePreparedTaskPersistence,
} from "@voice-agent/durable-store";

interface PolicyStateRow {
  readonly active_revision: number | null;
  readonly state_version: number;
  readonly status: "active" | "inactive" | "suspended";
  readonly suspended_at: string | null;
  readonly updated_at: string;
}

interface PolicyRevisionRow {
  readonly definition_json: string;
}

interface AdministrativePolicyEvidenceRow {
  readonly details_json: string;
  readonly id: string;
  readonly kind: AdministrativePolicyEvidenceEvent["kind"];
  readonly occurred_at: string;
  readonly sequence: number;
  readonly summary: string;
}

interface AdministrativeTaskRow {
  readonly active_execution_deadline: string | null;
  readonly capability_consumed_at: string | null;
  readonly capability_hash: string;
  readonly conclusion: string;
  readonly created_at: string;
  readonly execution_manifest_json: string | null;
  readonly id: string;
  readonly intended_state: string;
  readonly outcome: AdministrativeTask["outcome"];
  readonly owner_id: string;
  readonly policy_revision: number;
  readonly publication_intent: AdministrativeTask["publicationIntent"];
  readonly question: string;
  readonly state_version: number;
  readonly status: AdministrativeTask["status"];
  readonly target_json: string;
  readonly updated_at: string;
}

const administrativeTaskProjectionColumns = [
  "id",
  "owner_id",
  "capability_hash",
  "capability_consumed_at",
  "active_execution_deadline",
  "outcome",
  "publication_intent",
  "execution_manifest_json",
  "policy_revision",
  "state_version",
  "status",
  "question",
  "conclusion",
  "intended_state",
  "target_json",
  "created_at",
  "updated_at",
] as const;

function administrativeTaskProjectionSql(table?: string): string {
  return administrativeTaskProjectionColumns
    .map((column) =>
      table === undefined ? column : `${table}.${column} AS ${column}`,
    )
    .join(", ");
}

interface AdministrativeEvidenceRow {
  readonly details_json: string;
  readonly id: string;
  readonly kind: AdministrativeEvidenceEvent["kind"];
  readonly occurred_at: string;
  readonly sequence: number;
  readonly summary: string;
}

interface AdministrativeOperationRow {
  readonly claim_id: string | null;
  readonly id: string;
  readonly initial_execution_started_at: string | null;
  readonly lease_expires_at: string | null;
  readonly request_json: string;
  readonly result_json: string | null;
  readonly status: "accepted" | "completed" | "failed" | "running" | "stopped";
  readonly task_id: string;
}

interface AdministrativeOutstandingOperationRow {
  readonly id: string;
  readonly kind: AdministrativeOperationKind;
}

interface AdministrativeMutationLaneRow {
  readonly claim_id: string | null;
  readonly lease_expires_at: string | null;
  readonly operation_id: string | null;
}

interface LivePatchRollbackRow {
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly next_attempt_at: string;
  readonly operation_id: string;
  readonly request_json: string;
  readonly result_json: string | null;
  readonly status:
    | "activated"
    | "activation-pending"
    | "armed"
    | "window-expired";
  readonly task_id: string;
}

interface MaturedLivePatchRollbackRow extends LivePatchRollbackRow {
  readonly operation_request_json: string;
  readonly operation_result_json: string;
}

interface LivePatchRollbackIdRow {
  readonly operation_id: string;
}

type AdministrativeConfirmationDenialReason = Extract<
  AdministrativeConfirmationClaim,
  { readonly decision: "denied" }
>["reason"];

function confirmationDenialReason(
  task: AdministrativeTaskRow | undefined,
  input: {
    readonly capabilityHash: string;
    readonly ownerId: string;
  },
): AdministrativeConfirmationDenialReason | undefined {
  if (task === undefined) return "task-unavailable";
  if (task.owner_id !== input.ownerId) return "identity-mismatch";
  if (task.capability_hash !== input.capabilityHash) return "invalid-capability";
  if (
    task.capability_consumed_at !== null ||
    task.status !== "awaiting-confirmation"
  ) {
    return "confirmation-replayed";
  }
  return undefined;
}

function assertAdministrativeOperationCompletionEvidence(
  request: AdministrativeOperationRequest,
  result: AdministrativeOperationResult,
  event: Parameters<
    AdministrativeAutonomyStore["completeOperation"]
  >[0]["completedEvent"],
): void {
  if (
    result.kind !== request.kind ||
    result.operationId !== request.operationId ||
    event.kind !== "administrative.operation.completed" ||
    event.occurredAt !== result.completedAt ||
    event.details.kind !== result.kind ||
    event.details.operationId !== result.operationId ||
    !sameAdministrativeResult(event.details.result, result)
  ) {
    throw new Error(
      "Administrative Operation completion Evidence Event is mismatched",
    );
  }
}

function validateLivePatchCompletion(
  request: AdministrativeOperationRequest,
  result: AdministrativeOperationResult,
): void {
  if (request.kind !== "live-patch.apply") return;
  if (
    result.kind !== request.kind ||
    !isLivePatchMutationProofBoundToRequest(request, result)
  ) {
    throw new Error("Live Patch completion changed its trusted target");
  }
}

function validateDelegatedWorktreeCompletion(
  request: AdministrativeOperationRequest,
  result: AdministrativeOperationResult,
): void {
  if (request.kind !== "delegated-worktree.change") return;
  if (result.kind !== request.kind) {
    throw new Error("Administrative Delegation completion kind changed");
  }
  const effectStarted = new Date(
    result.effect.kind === "effect-performed"
      ? result.effect.startedAt
      : result.effect.originallyStartedAt,
  ).getTime();
  validateAdministrativeDelegatedWorktreeResultBinding(request, result, {
    completed: new Date(result.completedAt).getTime(),
    effectStarted,
    reportedCompletedAt: administrativeTimestampSchema.parse(
      result.delegation.completedAt,
    ),
  });
}

function sameAdministrativeResult(
  left: AdministrativeOperationResult,
  right: AdministrativeOperationResult,
): boolean;
function sameAdministrativeResult(
  left: LivePatchRollbackActivationResult,
  right: LivePatchRollbackActivationResult,
): boolean;
function sameAdministrativeResult(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createSqliteAdministrativeAutonomyStore(
  databasePath: string,
): AdministrativeAutonomyStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const readPolicyState = database.prepare<[], PolicyStateRow>(`
    SELECT status, active_revision, state_version, updated_at, suspended_at
    FROM administrative_policy_state
    WHERE singleton = 1
  `);
  const readPolicyRevision = database.prepare<
    [revision: number],
    PolicyRevisionRow
  >(`
    SELECT definition_json
    FROM administrative_policy_revisions
    WHERE revision = ?
  `);
  const insertPolicyRevision = database.prepare(`
    INSERT INTO administrative_policy_revisions (
      revision, activated_at, activated_by, definition_json
    ) VALUES (?, ?, ?, ?)
  `);
  const insertPolicyEvidenceEvent = database.prepare(`
    INSERT INTO administrative_policy_evidence_events (
      id, kind, occurred_at, summary, details_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const readPolicyEvidenceEvents = database.prepare<
    [],
    AdministrativePolicyEvidenceRow
  >(`
    SELECT id, sequence, kind, occurred_at, summary, details_json
    FROM (
      SELECT id, sequence, kind, occurred_at, summary, details_json
      FROM administrative_policy_evidence_events
      ORDER BY sequence DESC
      LIMIT 100
    )
    ORDER BY sequence
  `);
  const readPolicyEvidencePageEvents = database.prepare<
    [beforeSequence: number | null, beforeSequence: number | null, limit: number],
    AdministrativePolicyEvidenceRow
  >(`
    SELECT id, sequence, kind, occurred_at, summary, details_json
    FROM administrative_policy_evidence_events
    WHERE (? IS NULL OR sequence < ?)
    ORDER BY sequence DESC
    LIMIT ?
  `);
  const countPolicyEvidenceEvents = database.prepare<
    [],
    { readonly count: number }
  >(`
    SELECT COUNT(*) AS count
    FROM administrative_policy_evidence_events
  `);
  const activatePolicyState = database.prepare(`
    UPDATE administrative_policy_state
    SET status = 'active', active_revision = ?, state_version = ?,
      updated_at = ?, suspended_at = NULL
    WHERE singleton = 1 AND state_version = ?
  `);
  const suspendPolicyState = database.prepare(`
    UPDATE administrative_policy_state
    SET status = 'suspended', state_version = state_version + 1,
      updated_at = ?, suspended_at = ?
    WHERE singleton = 1 AND status = 'active' AND active_revision = ?
      AND state_version = ?
  `);
  const insertTask = database.prepare(`
    INSERT INTO administrative_tasks (
      id, request_id, owner_id, capability_hash, capability_consumed_at,
      outcome, publication_intent, execution_manifest_json, policy_revision,
      state_version, status, question, intended_state, conclusion,
      target_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const readTask = database.prepare<[taskId: string], AdministrativeTaskRow>(`
    SELECT ${administrativeTaskProjectionSql()}
    FROM administrative_tasks
    WHERE id = ?
  `);
  const readTaskByOperationId = database.prepare<
    [operationId: string],
    AdministrativeTaskRow
  >(`
    SELECT ${administrativeTaskProjectionSql("tasks")}
    FROM administrative_tasks AS tasks
    JOIN administrative_operations AS operations ON operations.task_id = tasks.id
    WHERE operations.id = ?
  `);
  const readEvents = database.prepare<
    [taskId: string],
    AdministrativeEvidenceRow
  >(`
    SELECT id, sequence, kind, occurred_at, summary, details_json
    FROM (
      SELECT id, sequence, kind, occurred_at, summary, details_json
      FROM administrative_evidence_events
      WHERE task_id = ?
      ORDER BY sequence DESC
      LIMIT 100
    )
    ORDER BY sequence
  `);
  const countEvents = database.prepare<
    [taskId: string],
    { readonly count: number }
  >(`
    SELECT COUNT(*) AS count
    FROM administrative_evidence_events
    WHERE task_id = ?
  `);
  const readLastEventSequence = database.prepare<
    [taskId: string],
    { readonly sequence: number }
  >(`
    SELECT sequence
    FROM administrative_evidence_events
    WHERE task_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `);
  const insertEvent = database.prepare(`
    INSERT INTO administrative_evidence_events (
      id, task_id, sequence, kind, occurred_at, summary, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const consumeConfirmation = database.prepare(`
    UPDATE administrative_tasks
    SET capability_consumed_at = ?, active_execution_deadline = ?,
      status = 'planning', updated_at = ?
    WHERE id = ? AND capability_consumed_at IS NULL
      AND status = 'awaiting-confirmation'
  `);
  const declineConfirmation = database.prepare(`
    UPDATE administrative_tasks
    SET capability_consumed_at = ?, status = 'denied',
      conclusion = 'Task Confirmation was declined.', updated_at = ?
    WHERE id = ? AND capability_consumed_at IS NULL
      AND status = 'awaiting-confirmation'
  `);
  const insertOperation = database.prepare(`
    INSERT INTO administrative_operations (
      id, task_id, ordinal, kind, policy_revision, status, request_json,
      result_json, created_at, updated_at, claim_id, lease_expires_at
    ) VALUES (?, ?, ?, ?, ?, 'accepted', ?, NULL, ?, ?, NULL, NULL)
  `);
  const startTask = database.prepare(`
    UPDATE administrative_tasks
    SET status = 'running', updated_at = ?
    WHERE id = ? AND status = 'planning'
  `);
  const readOperation = database.prepare<
    [operationId: string],
    AdministrativeOperationRow
  >(`
    SELECT id, task_id, status, request_json, claim_id, lease_expires_at,
      initial_execution_started_at, result_json
    FROM administrative_operations
    WHERE id = ?
  `);
  const readNextOperation = database.prepare<
    [taskId: string],
    AdministrativeOperationRow
  >(`
    SELECT id, task_id, status, request_json, claim_id, lease_expires_at,
      initial_execution_started_at, result_json
    FROM administrative_operations
    WHERE task_id = ? AND status != 'completed'
    ORDER BY ordinal
    LIMIT 1
  `);
  const claimOperation = database.prepare(`
    UPDATE administrative_operations
    SET status = 'running', claim_id = ?, lease_expires_at = ?, updated_at = ?,
      initial_execution_started_at = COALESCE(initial_execution_started_at, ?)
    WHERE id = ? AND task_id = ?
      AND (
        status = 'accepted'
        OR (
          status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        )
      )
  `);
  const readMutationLane = database.prepare<[], AdministrativeMutationLaneRow>(`
    SELECT operation_id, claim_id, lease_expires_at
    FROM administrative_mutation_lane
    WHERE singleton = 1
  `);
  const claimMutationLane = database.prepare(`
    UPDATE administrative_mutation_lane
    SET operation_id = ?, claim_id = ?, lease_expires_at = ?
    WHERE singleton = 1 AND (
      operation_id IS NULL OR lease_expires_at <= ? OR operation_id = ?
    )
  `);
  const releaseMutationLane = database.prepare(`
    UPDATE administrative_mutation_lane
    SET operation_id = NULL, claim_id = NULL, lease_expires_at = NULL
    WHERE singleton = 1 AND operation_id = ? AND claim_id = ?
  `);
  const renewOperationClaim = database.prepare(`
    UPDATE administrative_operations
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND claim_id = ?
  `);
  const renewMutationLane = database.prepare(`
    UPDATE administrative_mutation_lane
    SET lease_expires_at = ?
    WHERE singleton = 1 AND operation_id = ? AND claim_id = ?
  `);
  const completeOperation = database.prepare(`
    UPDATE administrative_operations
    SET status = 'completed', result_json = ?, updated_at = ?,
      claim_id = NULL, lease_expires_at = NULL
    WHERE id = ? AND task_id = ? AND status = 'running' AND claim_id = ?
      AND lease_expires_at > ?
  `);
  const settleClaimedOperationAndDenyTask = database.prepare(`
    UPDATE administrative_operations
    SET status = ?, result_json = ?, updated_at = ?,
      claim_id = NULL, lease_expires_at = NULL
    WHERE id = ? AND task_id = ? AND status = 'running' AND claim_id = ?
  `);
  const listOutstandingOperations = database.prepare<
    [taskId: string],
    AdministrativeOutstandingOperationRow
  >(`
    SELECT id, kind
    FROM administrative_operations
    WHERE task_id = ? AND status IN ('accepted', 'running')
    ORDER BY ordinal
  `);
  const settleOutstandingOperations = database.prepare(`
    UPDATE administrative_operations
    SET status = 'failed', updated_at = ?, claim_id = NULL,
      lease_expires_at = NULL
    WHERE task_id = ? AND status IN ('accepted', 'running')
  `);
  const countIncompleteOperations = database.prepare<
    [taskId: string],
    { readonly count: number }
  >(`
    SELECT COUNT(*) AS count
    FROM administrative_operations
    WHERE task_id = ? AND status != 'completed'
  `);
  const completeTask = database.prepare(`
    UPDATE administrative_tasks
    SET status = 'completed',
      conclusion = 'The confirmed administrative plan completed.',
      updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const denyTask = database.prepare(`
    UPDATE administrative_tasks
    SET status = 'denied', conclusion = ?, updated_at = ?
    WHERE id = ? AND status IN ('awaiting-confirmation', 'planning', 'running')
  `);
  const releaseTaskMutationLane = database.prepare(`
    UPDATE administrative_mutation_lane
    SET operation_id = NULL, claim_id = NULL, lease_expires_at = NULL
    WHERE singleton = 1 AND operation_id IN (
      SELECT id FROM administrative_operations WHERE task_id = ?
    )
  `);
  const listTasks = database.prepare<[], AdministrativeTaskRow>(`
    SELECT ${administrativeTaskProjectionSql()}
    FROM administrative_tasks
    ORDER BY updated_at DESC, id DESC
    LIMIT 100
  `);
  const listRecoverableTaskIds = database.prepare<[], { readonly task_id: string }>(`
    SELECT id AS task_id
    FROM administrative_tasks
    WHERE status IN ('planning', 'running')
    ORDER BY id
  `);
  const tombstoneExpiredRequests = database.prepare(`
    INSERT OR IGNORE INTO administrative_expired_request_ids (
      request_id, expired_at
    )
    SELECT request_id, ?
    FROM administrative_tasks
    WHERE created_at < ?
  `);
  const deleteExpiredEvidence = database.prepare(`
    DELETE FROM administrative_evidence_events
    WHERE occurred_at < ?
  `);
  const readLivePatchRollback = database.prepare<
    [operationId: string],
    LivePatchRollbackRow
  >(`
    SELECT operation_id, task_id, status, request_json, result_json,
      attempt_count, last_error, next_attempt_at
    FROM administrative_live_patch_rollbacks
    WHERE operation_id = ?
  `);
  const insertLivePatchRollback = database.prepare(`
    INSERT INTO administrative_live_patch_rollbacks (
      operation_id, task_id, status, request_json, result_json, updated_at,
      attempt_count, last_error, next_attempt_at
    ) VALUES (?, ?, 'armed', ?, NULL, ?, 0, NULL, ?)
  `);
  const markArmedRollbacksPending = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET status = 'activation-pending', updated_at = ?, next_attempt_at = ?
    WHERE status = 'armed'
  `);
  const expireMaturedLivePatchRollbacks = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET status = 'window-expired', updated_at = ?
    WHERE status = 'armed'
      AND json_extract(request_json, '$.rollbackDeadline') <= ?
      AND EXISTS (
        SELECT 1
        FROM administrative_operations
        WHERE administrative_operations.id =
          administrative_live_patch_rollbacks.operation_id
          AND administrative_operations.status = 'completed'
          AND administrative_operations.result_json IS NOT NULL
      )
  `);
  const listMaturedLivePatchRollbacks = database.prepare<
    [expiresAt: string],
    MaturedLivePatchRollbackRow
  >(`
    SELECT rollbacks.operation_id, rollbacks.task_id, rollbacks.status,
      rollbacks.request_json, rollbacks.result_json, rollbacks.attempt_count,
      rollbacks.last_error, rollbacks.next_attempt_at,
      operations.request_json AS operation_request_json,
      operations.result_json AS operation_result_json
    FROM administrative_live_patch_rollbacks AS rollbacks
    JOIN administrative_operations AS operations
      ON operations.id = rollbacks.operation_id
    WHERE rollbacks.status = 'armed'
      AND json_extract(rollbacks.request_json, '$.rollbackDeadline') <= ?
      AND operations.status = 'completed'
      AND operations.result_json IS NOT NULL
    ORDER BY rollbacks.operation_id
  `);
  const activateLivePatchRollbackWindow = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET request_json = ?, updated_at = ?
    WHERE operation_id = ? AND status = 'armed'
  `);
  const listActivatedLivePatchRollbackIds = database.prepare<
    [],
    LivePatchRollbackIdRow
  >(`
    SELECT operation_id
    FROM administrative_live_patch_rollbacks
    WHERE status = 'activated'
    ORDER BY operation_id
    LIMIT 100
  `);
  const listUnresolvedLivePatchRollbackIds = database.prepare<
    [],
    LivePatchRollbackIdRow
  >(`
    SELECT operation_id
    FROM administrative_live_patch_rollbacks
    WHERE status IN ('armed', 'activation-pending')
    ORDER BY operation_id
    LIMIT 100
  `);
  const listPendingLivePatchRollbacks = database.prepare<
    [],
    LivePatchRollbackRow
  >(`
    SELECT operation_id, task_id, status, request_json, result_json,
      attempt_count, last_error, next_attempt_at
    FROM administrative_live_patch_rollbacks
    WHERE status = 'activation-pending'
    ORDER BY operation_id
  `);
  const countUnresolvedLivePatchRollbacks = database.prepare<
    [],
    { readonly count: number }
  >(`
    SELECT COUNT(*) AS count
    FROM administrative_live_patch_rollbacks
    WHERE status IN ('armed', 'activation-pending')
  `);
  const countActivatedLivePatchRollbacks = database.prepare<
    [],
    { readonly count: number }
  >(`
    SELECT COUNT(*) AS count
    FROM administrative_live_patch_rollbacks
    WHERE status = 'activated'
  `);
  const completeLivePatchRollbackActivation = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET status = 'activated', result_json = ?, updated_at = ?
    WHERE operation_id = ? AND status = 'activation-pending'
  `);
  const recordLivePatchRollbackActivationFailure = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET attempt_count = attempt_count + 1, last_error = ?,
      next_attempt_at = ?, updated_at = ?
    WHERE operation_id = ? AND status = 'activation-pending'
  `);

  function policyStatus(row = requirePolicyState()): AdministrativePolicyStatus {
    if (row.status === "inactive") {
      return administrativePolicyStatusSchema.parse({
        activeRevision: null,
        stateVersion: row.state_version,
        status: "inactive",
      });
    }
    if (row.active_revision === null) {
      throw new Error("Administrative policy state has no revision");
    }
    if (row.status === "suspended") {
      if (row.suspended_at === null) {
        throw new Error("Administrative Suspension has no timestamp");
      }
      const activatedOperationIds = listActivatedLivePatchRollbackIds
        .all()
        .map((rollback) => rollback.operation_id);
      const pendingOperationIds = listUnresolvedLivePatchRollbackIds
        .all()
        .map((rollback) => rollback.operation_id);
      const pendingActivations = listPendingLivePatchRollbacks
        .all()
        .slice(0, 100)
        .map((rollback) => ({
          attemptCount: rollback.attempt_count,
          lastFailureReason:
            rollback.last_error === null
              ? null
              : livePatchRollbackActivationFailureReasonSchema.parse(
                  rollback.last_error,
                ),
          nextAttemptAt: administrativeTimestampSchema.parse(
            rollback.next_attempt_at,
          ),
          operationId: rollback.operation_id,
        }));
      const activatedOperationCount =
        countActivatedLivePatchRollbacks.get()?.count ?? 0;
      const pendingOperationCount =
        countUnresolvedLivePatchRollbacks.get()?.count ?? 0;
      return administrativePolicyStatusSchema.parse({
        executionManifest: requirePolicyRevision(row.active_revision)
          .executionManifest,
        rollbackActivations: {
          activatedOperationCount,
          activatedOperationIds,
          activatedOperationIdsTruncated:
            activatedOperationCount > activatedOperationIds.length,
          pendingOperationCount,
          pendingOperationIds,
          pendingOperationIdsTruncated:
            pendingOperationCount > pendingOperationIds.length,
          pendingActivations,
        },
        revision: row.active_revision,
        stateVersion: row.state_version,
        status: "suspended",
        suspendedAt: row.suspended_at,
      });
    }
    const revision = requirePolicyRevision(row.active_revision);
    return administrativePolicyStatusSchema.parse({
      activatedAt: revision.activatedAt,
      activatedBy: revision.activatedBy,
      executionManifest: revision.executionManifest,
      revision: revision.revision,
      stateVersion: row.state_version,
      status: "active",
    });
  }

  function requirePolicyState(): PolicyStateRow {
    const row = readPolicyState.get();
    if (row === undefined) {
      throw new Error("Administrative policy state is unavailable");
    }
    return row;
  }

  function requirePolicyRevision(revision: number) {
    const row = readPolicyRevision.get(revision);
    if (row === undefined) {
      throw new Error("Administrative policy revision is unavailable");
    }
    return administrativePolicyRevisionSchema.parse(
      JSON.parse(row.definition_json),
    );
  }

  function policyEvidenceEvent(row: AdministrativePolicyEvidenceRow) {
    return administrativePolicyEvidenceEventSchema.parse({
      details: JSON.parse(row.details_json) as unknown,
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      sequence: row.sequence,
      summary: row.summary,
    });
  }

  function policyEvidenceProjection() {
    const totalCount = countPolicyEvidenceEvents.get()?.count ?? 0;
    const events = readPolicyEvidenceEvents.all().map(policyEvidenceEvent);
    return administrativePolicyEvidenceProjectionSchema.parse({
      events,
      totalCount,
      truncated: totalCount > events.length,
    });
  }

  function policyEvidencePage(
    input: Parameters<AdministrativeAutonomyStore["readPolicyEvidencePage"]>[0],
  ) {
    const request = administrativePolicyEvidencePageRequestSchema.parse(input);
    const rows = readPolicyEvidencePageEvents.all(
      request.beforeSequence,
      request.beforeSequence,
      request.limit + 1,
    );
    const hasMore = rows.length > request.limit;
    const events = rows
      .slice(0, request.limit)
      .reverse()
      .map(policyEvidenceEvent);
    return administrativePolicyEvidencePageSchema.parse({
      events,
      hasMore,
      nextBeforeSequence: hasMore ? events[0]?.sequence : null,
      totalCount: countPolicyEvidenceEvents.get()?.count ?? 0,
    });
  }

  function taskExecutionManifest(
    task: AdministrativeTaskRow,
  ): AdministrativeExecutionManifest {
    return task.execution_manifest_json === null
      ? administrativeUnavailableExecutionManifest
      : administrativeExecutionManifestSchema.parse(
          JSON.parse(task.execution_manifest_json),
        );
  }

  function taskAuthoritySnapshot(
    task: AdministrativeTaskRow,
  ): AdministrativeAuthoritySnapshot {
    return administrativeAuthoritySnapshotSchema.parse({
      executionManifest: taskExecutionManifest(task),
      policyRevision: task.policy_revision,
      policyStateVersion: task.state_version,
    });
  }

  function matchesAuthoritySnapshot(
    untrusted: AdministrativeAuthoritySnapshot,
  ): boolean {
    const input = administrativeAuthoritySnapshotSchema.parse(untrusted);
    const policy = requirePolicyState();
    if (
      policy.status !== "active" ||
      policy.active_revision !== input.policyRevision ||
      policy.state_version !== input.policyStateVersion
    ) {
      return false;
    }
    const active = requirePolicyRevision(input.policyRevision);
    return sameAdministrativeExecutionManifest(
      active.executionManifest,
      input.executionManifest,
    );
  }

  function appendEvents(
    taskId: string,
    events: readonly Omit<AdministrativeEvidenceEvent, "sequence">[],
  ): void {
    let sequence = readLastEventSequence.get(taskId)?.sequence ?? 0;
    for (const unsequenced of events) {
      const event = administrativeEvidenceEventSchema.parse({
        ...unsequenced,
        sequence: (sequence += 1),
      });
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

  function expireVerifiedMaturedLivePatchRollbackWindows(
    untrustedExpiredAt: string,
  ): void {
    const expiredAt = administrativeTimestampSchema.parse(untrustedExpiredAt);
    const maturedRollbacks = listMaturedLivePatchRollbacks.all(expiredAt);
    const expired = expireMaturedLivePatchRollbacks.run(expiredAt, expiredAt);
    if (expired.changes !== maturedRollbacks.length) {
      throw new Error("Live Patch rollback expiry projection changed concurrently");
    }
    for (const rollback of maturedRollbacks) {
      const rollbackRequest = livePatchRollbackActivationRequestSchema.parse(
        JSON.parse(rollback.request_json),
      );
      const operationRequest = administrativeOperationRequestSchema.parse(
        JSON.parse(rollback.operation_request_json),
      );
      const completedOperation = administrativeOperationResultSchema.parse(
        JSON.parse(rollback.operation_result_json),
      );
      if (
        operationRequest.kind !== "live-patch.apply" ||
        completedOperation.kind !== "live-patch.apply" ||
        completedOperation.operationId !== rollbackRequest.operationId ||
        !isLivePatchMutationProofBoundToRequest(
          operationRequest,
          completedOperation,
        ) ||
        !sameAdministrativeTaskTargetBinding(
          rollbackRequest,
          administrativeTaskTargetBinding(operationRequest.target),
        )
      ) {
        throw new Error(
          "A Live Patch rollback can expire only after its verified Operation completed",
        );
      }
      appendEvents(rollbackRequest.taskId, [
        {
          details: {
            operationId: rollbackRequest.operationId,
            reconciledAt: expiredAt,
            rollbackDeadline: rollbackRequest.rollbackDeadline,
          },
          id: rollbackWindowExpiryEventId(rollbackRequest.operationId),
          kind: "administrative.live-patch.rollback-window-expired",
          occurredAt: expiredAt,
          summary: "The armed Live Patch rollback window expired normally.",
        },
      ]);
    }
  }

  function settleOutstandingTaskOperations(
    taskId: string,
    reason: string,
    failedAt: string,
  ): readonly Omit<AdministrativeEvidenceEvent, "sequence">[] {
    const occurredAt = administrativeTimestampSchema.parse(failedAt);
    const outstanding = listOutstandingOperations.all(taskId);
    if (outstanding.length === 0) return [];
    if (
      settleOutstandingOperations.run(failedAt, taskId).changes !==
      outstanding.length
    ) {
      throw new Error("Outstanding Administrative Operations changed concurrently");
    }
    return outstanding.map((operation) => ({
      details: {
        kind: operation.kind,
        operationId: operation.id,
        reason,
      },
      id: operationFailureEventId(operation.id),
      kind: "administrative.operation.failed" as const,
      occurredAt,
      summary: `The outstanding ${operation.kind} Operation failed closed with its Task.`,
    }));
  }

  function loadRecord(task: AdministrativeTaskRow): AdministrativeEvidenceRecord {
    const evidenceTotalCount = countEvents.get(task.id)?.count ?? 0;
    return administrativeEvidenceRecordSchema.parse({
      evidence: readEvents.all(task.id).map((event) => ({
        details: JSON.parse(event.details_json) as unknown,
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurred_at,
        sequence: event.sequence,
        summary: event.summary,
      })),
      evidenceTotalCount,
      evidenceTruncated: evidenceTotalCount > 100,
      task: taskProjection(task),
    });
  }

  function taskProjection(task: AdministrativeTaskRow): AdministrativeTask {
    return administrativeTaskSchema.parse({
      activeExecutionDeadline: task.active_execution_deadline,
      conclusion: task.conclusion,
      createdAt: task.created_at,
      id: task.id,
      intendedState: task.intended_state,
      kind: "administrative.work",
      outcome: task.outcome,
      authority: {
        executionManifest: taskExecutionManifest(task),
        policyRevision: task.policy_revision,
        policyStateVersion: task.state_version,
      },
      publicationIntent: task.publication_intent,
      question: task.question,
      status: task.status,
      target: JSON.parse(task.target_json) as unknown,
      updatedAt: task.updated_at,
    });
  }

  const activateTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["activatePolicy"]>[0]) => {
      const expectation = administrativePolicyActivationExpectationSchema.parse(
        input.expectation,
      );
      const current = requirePolicyState();
      expireVerifiedMaturedLivePatchRollbackWindows(input.revision.activatedAt);
      const activeRevision =
        current.status === "inactive" ? null : current.active_revision;
      if (
        activeRevision !== expectation.expectedActiveRevision ||
        current.state_version !== expectation.expectedStateVersion ||
        administrativeExecutionManifestFingerprint(
          input.revision.executionManifest,
        ) !== expectation.expectedExecutionManifestFingerprint ||
        input.revision.revision !== (activeRevision ?? 0) + 1 ||
        input.stateVersion !== current.state_version + 1
      ) {
        return undefined;
      }
      if ((countUnresolvedLivePatchRollbacks.get()?.count ?? 0) > 0) {
        return {
          decision: "blocked",
          reason: "unresolved-live-patch-rollback-windows",
        } as const;
      }
      const revision = administrativePolicyRevisionSchema.parse(input.revision);
      insertPolicyRevision.run(
        revision.revision,
        revision.activatedAt,
        revision.activatedBy,
        JSON.stringify(revision),
      );
      const result = activatePolicyState.run(
        revision.revision,
        input.stateVersion,
        revision.activatedAt,
        current.state_version,
      );
      if (result.changes !== 1) return undefined;
      return policyStatus();
    },
  );

  const suspendTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["suspendPolicy"]>[0]) => {
      const expectation = administrativePolicySuspensionExpectationSchema.parse(
        input.expectation,
      );
      const suspensionEvent =
        administrativePolicyEvidenceEventInputSchema.parse(
          input.suspensionEvent,
        );
      const current = requirePolicyState();
      if (
        current.status === "suspended" &&
        current.active_revision === expectation.expectedRevision &&
        current.state_version === expectation.expectedStateVersion + 1
      ) {
        expireVerifiedMaturedLivePatchRollbackWindows(input.suspendedAt);
        markArmedRollbacksPending.run(input.suspendedAt, input.suspendedAt);
        return policyStatus(current);
      }
      const result = suspendPolicyState.run(
        input.suspendedAt,
        input.suspendedAt,
        expectation.expectedRevision,
        expectation.expectedStateVersion,
      );
      if (result.changes !== 1) return undefined;
      if (
        suspensionEvent.occurredAt !== input.suspendedAt ||
        suspensionEvent.details.policyRevision !==
          expectation.expectedRevision ||
        suspensionEvent.details.resultingStateVersion !==
          expectation.expectedStateVersion + 1
      ) {
        throw new Error(
          "Administrative Suspension evidence does not match its transition",
        );
      }
      insertPolicyEvidenceEvent.run(
        suspensionEvent.id,
        suspensionEvent.kind,
        suspensionEvent.occurredAt,
        suspensionEvent.summary,
        JSON.stringify(suspensionEvent.details),
      );
      expireVerifiedMaturedLivePatchRollbackWindows(input.suspendedAt);
      markArmedRollbacksPending.run(input.suspendedAt, input.suspendedAt);
      return policyStatus();
    },
  );

  const armLivePatchRollbackTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["armLivePatchRollback"]>[0]) => {
      const request = livePatchRollbackActivationRequestSchema.parse(
        input.request,
      );
      const operation = readOperation.get(request.operationId);
      if (
        operation === undefined ||
        operation.task_id !== request.taskId ||
        operation.status !== "running" ||
        operation.claim_id !== input.claimId ||
        operation.lease_expires_at === null ||
        operation.lease_expires_at <= request.armedAt
      ) {
        return false;
      }
      const operationRequest = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      const task = requireTask(request.taskId);
      if (
        operationRequest.kind !== "live-patch.apply" ||
        operationRequest.operationId !== request.operationId ||
        operationRequest.taskId !== request.taskId ||
        !sameAdministrativeTaskTargetBinding(
          administrativeTaskTargetBinding(operationRequest.target),
          request,
        ) ||
        !sameAdministrativeAuthoritySnapshot(
          operationRequest.authority,
          request.authority,
        ) ||
        task.active_execution_deadline === null ||
        request.armedAt >= task.active_execution_deadline ||
        request.mutationAuthorizedAt !== null ||
        request.armedRollbackDeadline !== request.rollbackDeadline ||
        request.rollbackDeadline > task.active_execution_deadline ||
        new Date(request.armedRollbackDeadline).getTime() -
          new Date(request.armedAt).getTime() !==
          livePatchRollbackWindowMilliseconds ||
        !matchesAuthoritySnapshot(operationRequest.authority)
      ) {
        return false;
      }
      const lane = readMutationLane.get();
      if (
        lane?.operation_id !== request.operationId ||
        lane.claim_id !== input.claimId ||
        lane.lease_expires_at === null ||
        lane.lease_expires_at <= request.armedAt
      ) {
        return false;
      }
      const existing = readLivePatchRollback.get(request.operationId);
      if (existing !== undefined) {
        return (
          existing.status === "armed" &&
          JSON.stringify(
            livePatchRollbackActivationRequestSchema.parse(
              JSON.parse(existing.request_json),
            ),
          ) === JSON.stringify(request)
        );
      }
      insertLivePatchRollback.run(
        request.operationId,
        request.taskId,
        JSON.stringify(request),
        request.armedAt,
        request.armedAt,
      );
      return true;
    },
  );

  const recheckOperationEffectTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["recheckOperationEffect"]>[0]) => {
      const operation = readOperation.get(input.operationId);
      if (
        operation === undefined ||
        operation.task_id !== input.taskId ||
        operation.status !== "running" ||
        operation.claim_id !== input.claimId ||
        operation.lease_expires_at === null
      ) {
        return { decision: "denied", reason: "claim-lost" } as const;
      }
      const request = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      const task = requireTask(input.taskId);
      if (
        task.active_execution_deadline === null ||
        input.effectAt >= task.active_execution_deadline
      ) {
        return {
          decision: "denied",
          reason: "active-execution-deadline",
        } as const;
      }
      if (operation.lease_expires_at <= input.effectAt) {
        return { decision: "denied", reason: "claim-lost" } as const;
      }
      if (request.operationId !== input.operationId) {
        return { decision: "denied", reason: "claim-lost" } as const;
      }
      if (
        !sameAdministrativeAuthoritySnapshot(request.authority, input.authority)
      ) {
        return { decision: "denied", reason: "execution-manifest" } as const;
      }
      if (
        !matchesAuthoritySnapshot(request.authority)
      ) {
        return { decision: "denied", reason: "stale-policy" } as const;
      }
      const mutation = administrativeMutationOperationKinds.some(
        (kind) => kind === request.kind,
      );
      if (mutation) {
        const lane = readMutationLane.get();
        if (
          lane?.operation_id !== input.operationId ||
          lane.claim_id !== input.claimId ||
          lane.lease_expires_at === null ||
          lane.lease_expires_at <= input.effectAt
        ) {
          return { decision: "denied", reason: "claim-lost" } as const;
        }
      }
      if (request.kind === "live-patch.apply") {
        const rollback = readLivePatchRollback.get(input.operationId);
        if (rollback?.status !== "armed") {
          return {
            decision: "denied",
            reason: "live-patch-rollback",
          } as const;
        }
        const activationRequest =
          livePatchRollbackActivationRequestSchema.parse(
            JSON.parse(rollback.request_json),
          );
        const window = input.livePatchRollbackWindow;
        if (
          window === undefined ||
          activationRequest.taskId !== input.taskId ||
          !sameAdministrativeTaskTargetBinding(
            activationRequest,
            administrativeTaskTargetBinding(request.target),
          ) ||
          window.armedAt !== activationRequest.armedAt ||
          window.mutationStartedAt !== input.effectAt ||
          activationRequest.armedAt > window.mutationStartedAt ||
          activationRequest.armedRollbackDeadline <=
            window.mutationStartedAt ||
          window.rollbackDeadline > task.active_execution_deadline ||
          new Date(window.rollbackDeadline).getTime() -
            new Date(window.mutationStartedAt).getTime() !==
            livePatchRollbackWindowMilliseconds ||
          (activationRequest.mutationAuthorizedAt !== null &&
            (activationRequest.mutationAuthorizedAt !==
              window.mutationStartedAt ||
              activationRequest.rollbackDeadline !== window.rollbackDeadline))
        ) {
          return {
            decision: "denied",
            reason: "live-patch-rollback",
          } as const;
        }
        if (activationRequest.mutationAuthorizedAt === null) {
          const activatedRequest = livePatchRollbackActivationRequestSchema.parse({
            ...activationRequest,
            mutationAuthorizedAt: window.mutationStartedAt,
            rollbackDeadline: window.rollbackDeadline,
          });
          if (
            activateLivePatchRollbackWindow.run(
              JSON.stringify(activatedRequest),
              window.mutationStartedAt,
              input.operationId,
            ).changes !== 1
          ) {
            return {
              decision: "denied",
              reason: "live-patch-rollback",
            } as const;
          }
        }
      } else if (input.livePatchRollbackWindow !== undefined) {
        return {
          decision: "denied",
          reason: "live-patch-rollback",
        } as const;
      }
      return { decision: "authorized" } as const;
    },
  );

  const completeLivePatchRollbackActivationTransaction = database.transaction(
    (
      input: Parameters<
        AdministrativeAutonomyStore["completeLivePatchRollbackActivation"]
      >[0],
    ) => {
      const result = livePatchRollbackActivationResultSchema.parse(input.result);
      const completedEvent = input.completedEvent;
      const rollback = readLivePatchRollback.get(result.operationId);
      if (rollback === undefined) return false;
      const request = livePatchRollbackActivationRequestSchema.parse(
        JSON.parse(rollback.request_json),
      );
      if (
        request.operationId !== result.operationId ||
        request.taskId !== result.taskId ||
        !sameAdministrativeTaskTargetBinding(request, result)
      ) {
        return false;
      }
      if (rollback.status === "activated") {
        if (rollback.result_json === null) return false;
        const recorded = livePatchRollbackActivationResultSchema.parse(
          JSON.parse(rollback.result_json),
        );
        return (
          recorded.operationId === request.operationId &&
          recorded.taskId === request.taskId &&
          sameAdministrativeTaskTargetBinding(recorded, request)
        );
      }
      if (
        rollback.status !== "activation-pending" ||
        requirePolicyState().status !== "suspended"
      ) {
        return false;
      }
      if (
        completedEvent.kind !==
          "administrative.live-patch.rollback-activated" ||
        completedEvent.occurredAt !== result.activatedAt ||
        completedEvent.details.operationId !== result.operationId ||
        !sameAdministrativeResult(completedEvent.details.result, result)
      ) {
        throw new Error(
          "Live Patch rollback Evidence Event does not match its result",
        );
      }
      if (
        completeLivePatchRollbackActivation.run(
          JSON.stringify(result),
          result.activatedAt,
          result.operationId,
        ).changes !== 1
      ) {
        return false;
      }
      appendEvents(request.taskId, [completedEvent]);
      return true;
    },
  );

  const recordLivePatchRollbackActivationFailureTransaction =
    database.transaction(
      (
        input: Parameters<
          AdministrativeAutonomyStore["recordLivePatchRollbackActivationFailure"]
        >[0],
      ) => {
        const rollback = readLivePatchRollback.get(input.operationId);
        if (
          rollback === undefined ||
          rollback.status !== "activation-pending" ||
          requirePolicyState().status !== "suspended"
        ) {
          return false;
        }
        const reason = livePatchRollbackActivationFailureReasonSchema.parse(
          input.reason,
        );
        const failedAt = administrativeTimestampSchema.parse(input.failedAt);
        const nextAttemptAt = administrativeTimestampSchema.parse(
          input.nextAttemptAt,
        );
        const attemptCount = rollback.attempt_count + 1;
        if (
          input.failureEvent.kind !==
            "administrative.live-patch.rollback-activation-failed" ||
          input.failureEvent.occurredAt !== failedAt ||
          input.failureEvent.details.operationId !== input.operationId ||
          input.failureEvent.details.reason !== reason ||
          input.failureEvent.details.attemptCount !== attemptCount ||
          input.failureEvent.details.nextAttemptAt !== nextAttemptAt
        ) {
          throw new Error(
            "Live Patch rollback failure Evidence Event does not match its attempt",
          );
        }
        if (
          recordLivePatchRollbackActivationFailure.run(
            reason,
            nextAttemptAt,
            failedAt,
            input.operationId,
          ).changes !== 1
        ) {
          return false;
        }
        const request = livePatchRollbackActivationRequestSchema.parse(
          JSON.parse(rollback.request_json),
        );
        appendEvents(request.taskId, [input.failureEvent]);
        return true;
      },
    );

  const prepareTransaction = database.transaction(
    (input: AdministrativePreparedTaskPersistence) => {
      if (
        !matchesAuthoritySnapshot(administrativeTaskAuthoritySnapshot(input.task))
      ) {
        return undefined;
      }
      try {
        insertTask.run(
          input.task.id,
          input.requestId,
          input.ownerId,
          input.capabilityHash,
          input.task.outcome,
          input.task.publicationIntent,
          JSON.stringify(input.task.authority.executionManifest),
          input.task.authority.policyRevision,
          input.task.authority.policyStateVersion,
          input.task.status,
          input.task.question,
          input.task.intendedState,
          input.task.conclusion,
          JSON.stringify(input.task.target),
          input.task.createdAt,
          input.task.updatedAt,
        );
      } catch (error) {
        if (isSqliteConstraint(error)) return undefined;
        throw error;
      }
      appendEvents(input.task.id, [input.event]);
      return loadRecord(requireTask(input.task.id));
    },
  );

  const claimTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["claimConfirmation"]>[0]): AdministrativeConfirmationClaim => {
      const task = readTask.get(input.taskId);
      const denial = confirmationDenialReason(task, input);
      if (denial !== undefined) return { decision: "denied", reason: denial };
      if (task === undefined) throw new Error("Administrative Task is unavailable");
      const activeExecutionDeadline = new Date(
        new Date(input.acceptedAt).getTime() +
          administrativeActiveExecutionMilliseconds,
      ).toISOString();
      if (
        input.acceptedEvent.kind !== "administrative.confirmation.accepted" ||
        input.acceptedEvent.details.activeExecutionDeadline !==
          activeExecutionDeadline
      ) {
        throw new Error(
          "Task Confirmation evidence has an invalid active-execution deadline",
        );
      }
      if (!matchesAuthoritySnapshot(taskAuthoritySnapshot(task))) {
        return { decision: "denied", reason: "stale-policy" };
      }
      const result = consumeConfirmation.run(
        input.acceptedAt,
        activeExecutionDeadline,
        input.acceptedAt,
        input.taskId,
      );
      if (result.changes !== 1) {
        return { decision: "denied", reason: "confirmation-replayed" };
      }
      appendEvents(input.taskId, [input.acceptedEvent]);
      return {
        decision: "claimed",
        record: loadRecord(requireTask(input.taskId)),
      };
    },
  );

  const declineTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["declineConfirmation"]>[0]): AdministrativeConfirmationClaim => {
      const task = readTask.get(input.taskId);
      const denial = confirmationDenialReason(task, input);
      if (denial !== undefined) return { decision: "denied", reason: denial };
      const result = declineConfirmation.run(
        input.declinedAt,
        input.declinedAt,
        input.taskId,
      );
      if (result.changes !== 1) {
        return { decision: "denied", reason: "confirmation-replayed" };
      }
      appendEvents(input.taskId, [input.declinedEvent]);
      return {
        decision: "claimed",
        record: loadRecord(requireTask(input.taskId)),
      };
    },
  );

  const planTransaction = database.transaction(
    (input: {
      readonly operations: readonly AdministrativePlannedOperation[];
      readonly planEvent: Omit<AdministrativeEvidenceEvent, "sequence">;
      readonly taskId: string;
    }) => {
      const task = requireTask(input.taskId);
      if (task.status !== "planning") {
        return task.status === "running" || task.status === "completed"
          ? loadRecord(task)
          : undefined;
      }
      if (!matchesAuthoritySnapshot(taskAuthoritySnapshot(task))) {
        return undefined;
      }
      if (
        task.active_execution_deadline === null ||
        input.planEvent.occurredAt >= task.active_execution_deadline
      ) {
        return undefined;
      }
      appendEvents(input.taskId, [input.planEvent]);
      input.operations.forEach((operation, ordinal) => {
        const request = administrativeOperationRequestSchema.parse(
          operation.request,
        );
        if (
          request.taskId !== input.taskId ||
          !sameAdministrativeAuthoritySnapshot(
            request.authority,
            taskAuthoritySnapshot(task),
          )
        ) {
          throw new Error(
            "Administrative Operation authority does not match its Durable Task",
          );
        }
        insertOperation.run(
          request.operationId,
          request.taskId,
          ordinal,
          request.kind,
          request.authority.policyRevision,
          JSON.stringify(request),
          input.planEvent.occurredAt,
          input.planEvent.occurredAt,
        );
        appendEvents(input.taskId, [operation.acceptedEvent]);
      });
      const result = startTask.run(input.planEvent.occurredAt, input.taskId);
      if (result.changes !== 1) {
        throw new Error("Administrative Task plan changed concurrently");
      }
      return loadRecord(requireTask(input.taskId));
    },
  );

  const claimOperationTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["claimNextOperation"]>[0]): AdministrativeOperationClaim => {
      const task = readTask.get(input.taskId);
      if (task === undefined || task.status !== "running") {
        return { decision: "empty" };
      }
      const operation = readNextOperation.get(input.taskId);
      if (operation === undefined) return { decision: "empty" };
      if (
        task.active_execution_deadline === null ||
        input.claimedAt >= task.active_execution_deadline ||
        input.leaseExpiresAt > task.active_execution_deadline ||
        input.leaseExpiresAt <= input.claimedAt
      ) {
        return { decision: "denied", reason: "active-execution-deadline" };
      }
      const request = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      if (
        !sameAdministrativeAuthoritySnapshot(request.authority, input.authority)
      ) {
        return { decision: "denied", reason: "execution-manifest" };
      }
      if (!matchesAuthoritySnapshot(request.authority)) {
        return { decision: "denied", reason: "stale-policy" };
      }
      if (
        operation.status === "running" &&
        operation.lease_expires_at !== null &&
        operation.lease_expires_at > input.claimedAt
      ) {
        return {
          decision: "deferred",
          retryAt: administrativeTimestampSchema.parse(
            operation.lease_expires_at,
          ),
        };
      }
      const mutation = administrativeMutationOperationKinds.some(
        (kind) => kind === request.kind,
      );
      if (mutation) {
        const lane = readMutationLane.get();
        if (lane === undefined) {
          throw new Error("Administrative mutation lane is unavailable");
        }
        if (
          lane.operation_id !== null &&
          lane.operation_id !== operation.id &&
          lane.lease_expires_at !== null &&
          lane.lease_expires_at > input.claimedAt
        ) {
          return {
            decision: "deferred",
            retryAt: administrativeTimestampSchema.parse(lane.lease_expires_at),
          };
        }
        const laneResult = claimMutationLane.run(
          operation.id,
          input.claimId,
          input.leaseExpiresAt,
          input.claimedAt,
          operation.id,
        );
        if (laneResult.changes !== 1) {
          return { decision: "deferred", retryAt: input.leaseExpiresAt };
        }
      }
      const result = claimOperation.run(
        input.claimId,
        input.leaseExpiresAt,
        input.claimedAt,
        input.claimedAt,
        operation.id,
        input.taskId,
        input.claimedAt,
      );
      if (result.changes !== 1) {
        throw new Error("Administrative Operation changed concurrently");
      }
      return {
        activeExecutionDeadline: administrativeTimestampSchema.parse(
          task.active_execution_deadline,
        ),
        claimId: input.claimId,
        decision: "claimed",
        initialExecutionStartedAt: administrativeTimestampSchema.parse(
          operation.initial_execution_started_at ?? input.claimedAt,
        ),
        recovered: operation.status === "running",
        request,
      };
    },
  );

  const completeOperationTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["completeOperation"]>[0]) => {
      const operation = readOperation.get(input.operationId);
      if (operation === undefined || operation.task_id !== input.taskId) {
        throw new Error("Administrative Operation is unavailable");
      }
      const request = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      const submittedResult = administrativeOperationResultSchema.parse(
        input.result,
      );
      assertAdministrativeOperationCompletionEvidence(
        request,
        submittedResult,
        input.completedEvent,
      );
      validateDelegatedWorktreeCompletion(request, submittedResult);
      validateLivePatchCompletion(request, submittedResult);
      if (operation.status === "completed") {
        if (operation.result_json === null) {
          throw new Error("Completed Administrative Operation has no result");
        }
        const durableResult = administrativeOperationResultSchema.parse(
          JSON.parse(operation.result_json),
        );
        if (!sameAdministrativeResult(durableResult, submittedResult)) {
          throw new Error(
            "Administrative Operation replay does not match its durable result",
          );
        }
        return loadRecord(requireTask(input.taskId));
      }
      if (operation.claim_id !== input.claimId) {
        throw new Error("Administrative Operation claim changed concurrently");
      }
      if (
        operation.lease_expires_at === null ||
        operation.lease_expires_at <= submittedResult.completedAt
      ) {
        throw new Error("Administrative Operation claim is no longer leased");
      }
      const mutation = administrativeMutationOperationKinds.some(
        (kind) => kind === request.kind,
      );
      if (mutation) {
        const lane = readMutationLane.get();
        if (
          lane?.operation_id !== input.operationId ||
          lane.claim_id !== input.claimId ||
          lane.lease_expires_at === null ||
          lane.lease_expires_at <= submittedResult.completedAt
        ) {
          throw new Error("Administrative mutation lane is no longer leased");
        }
      }
      const task = requireTask(input.taskId);
      // Authority is fenced immediately before the external effect. Once the
      // typed result exists, a later policy transition must not rewrite that
      // historical fact as failure. Settlement still requires the exact live
      // claim, mutation lane, task deadline, request correlation, and rollback
      // obligation above and below this point.
      if (
        task.active_execution_deadline === null ||
        submittedResult.completedAt >= task.active_execution_deadline
      ) {
        throw new Error("Administrative Operation execution deadline elapsed");
      }
      if (request.kind === "live-patch.apply") {
        const rollback = readLivePatchRollback.get(input.operationId);
        const result =
          submittedResult.kind === "live-patch.apply"
            ? submittedResult
            : undefined;
        if (
          rollback === undefined ||
          !["activation-pending", "activated", "armed"].includes(
            rollback.status,
          ) ||
          result === undefined
        ) {
          throw new Error("Live Patch rollback obligation is unavailable");
        }
        const activationRequest =
          livePatchRollbackActivationRequestSchema.parse(
            JSON.parse(rollback.request_json),
          );
        if (
          activationRequest.armedAt !==
            result.mutationProof.independentRollback.armedAt ||
          activationRequest.mutationAuthorizedAt !==
            result.mutationProof.mutationStartedAt ||
          activationRequest.rollbackDeadline !==
            result.mutationProof.independentRollback.rollbackDeadline ||
          !sameAdministrativeTaskTargetBinding(
            activationRequest,
            administrativeTaskTargetBinding(request.target),
          )
        ) {
          throw new Error("Live Patch rollback proof changed after arming");
        }
      }
      const result = completeOperation.run(
        JSON.stringify(submittedResult),
        submittedResult.completedAt,
        input.operationId,
        input.taskId,
        input.claimId,
        submittedResult.completedAt,
      );
      if (result.changes !== 1) {
        throw new Error("Administrative Operation changed concurrently");
      }
      releaseMutationLane.run(input.operationId, input.claimId);
      appendEvents(input.taskId, [input.completedEvent]);
      return loadRecord(requireTask(input.taskId));
    },
  );

  const settleClaimedOperationAndDenyTaskTransaction = database.transaction(
    (
      input: Parameters<
        AdministrativeAutonomyStore["settleClaimedOperationAndDenyTask"]
      >[0],
    ) => {
      const operation = readOperation.get(input.operationId);
      const task = requireTask(input.taskId);
      const encodedResult =
        input.result === undefined ? null : JSON.stringify(input.result);
      if (
        operation !== undefined &&
        operation.task_id === input.taskId &&
        operation.status === input.operationStatus &&
        operation.result_json === encodedResult &&
        task.status === "denied"
      ) {
        const outstandingEvents = settleOutstandingTaskOperations(
          input.taskId,
          input.deniedEvent.kind === "administrative.task.denied"
            ? input.deniedEvent.details.reason
            : "Administrative Task denied.",
          input.deniedAt,
        );
        appendEvents(input.taskId, outstandingEvents);
        return loadRecord(task);
      }
      if (
        operation === undefined ||
        operation.task_id !== input.taskId ||
        operation.status !== "running" ||
        operation.claim_id !== input.claimId
      ) {
        throw new Error("Administrative Operation claim changed concurrently");
      }
      const request = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      const result =
        input.result === undefined
          ? undefined
          : administrativeOperationResultSchema.parse(input.result);
      if (
        input.deniedEvent.kind !== "administrative.task.denied" ||
        input.deniedEvent.occurredAt !== input.deniedAt
      ) {
        throw new Error("Task denial Evidence Event is mismatched");
      }
      if (result === undefined) {
        if (
          input.operationStatus !== "failed" ||
          input.operationEvent.kind !== "administrative.operation.failed" ||
          input.operationEvent.occurredAt !== input.deniedAt ||
          input.operationEvent.details.operationId !== request.operationId ||
          input.operationEvent.details.kind !== request.kind ||
          input.operationEvent.details.reason !==
            input.deniedEvent.details.reason
        ) {
          throw new Error("Operation failure Evidence Event is mismatched");
        }
      } else if (
        request.kind !== "delegated-worktree.change" ||
        result.kind !== request.kind ||
        result.operationId !== request.operationId ||
        result.delegation.status === "completed" ||
        result.delegation.status !== input.operationStatus ||
        result.completedAt > input.deniedAt ||
        input.operationEvent.kind !== "administrative.operation.terminated" ||
        input.operationEvent.occurredAt !== result.completedAt ||
        input.operationEvent.details.operationId !== result.operationId ||
        input.operationEvent.details.kind !== result.kind ||
        input.operationEvent.details.terminalStatus !==
          result.delegation.status ||
        !sameAdministrativeResult(input.operationEvent.details.result, result)
      ) {
        throw new Error("Terminal Delegation Evidence Event is mismatched");
      }
      if (
        settleClaimedOperationAndDenyTask.run(
          input.operationStatus,
          encodedResult,
          input.deniedAt,
          input.operationId,
          input.taskId,
          input.claimId,
        ).changes !== 1
      ) {
        throw new Error("Administrative Operation changed concurrently");
      }
      const reason = input.deniedEvent.details.reason;
      if (denyTask.run(reason, input.deniedAt, input.taskId).changes !== 1) {
        throw new Error("Administrative Task changed concurrently");
      }
      const outstandingEvents = settleOutstandingTaskOperations(
        input.taskId,
        reason,
        input.deniedAt,
      );
      releaseMutationLane.run(input.operationId, input.claimId);
      appendEvents(input.taskId, [
        input.operationEvent,
        ...outstandingEvents,
        input.deniedEvent,
      ]);
      return loadRecord(requireTask(input.taskId));
    },
  );

  const renewOperationTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["renewOperationClaim"]>[0]) => {
      const operation = readOperation.get(input.operationId);
      if (
        operation === undefined ||
        operation.status !== "running" ||
        operation.claim_id !== input.claimId
      ) {
        return false;
      }
      const request = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      const task = requireTask(operation.task_id);
      if (
        task.active_execution_deadline === null ||
        operation.lease_expires_at === null ||
        operation.lease_expires_at <= input.renewedAt ||
        input.renewedAt >= task.active_execution_deadline ||
        input.leaseExpiresAt <= input.renewedAt ||
        input.leaseExpiresAt > task.active_execution_deadline ||
        !matchesAuthoritySnapshot(request.authority)
      ) {
        return false;
      }
      const mutation = administrativeMutationOperationKinds.some(
        (kind) => kind === request.kind,
      );
      if (mutation) {
        const lane = readMutationLane.get();
        if (
          lane?.operation_id !== input.operationId ||
          lane.claim_id !== input.claimId
        ) {
          return false;
        }
        const laneResult = renewMutationLane.run(
          input.leaseExpiresAt,
          input.operationId,
          input.claimId,
        );
        if (laneResult.changes !== 1) return false;
      }
      return (
        renewOperationClaim.run(
          input.leaseExpiresAt,
          input.renewedAt,
          input.operationId,
          input.claimId,
        ).changes === 1
      );
    },
  );

  const completeTaskTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["completeTask"]>[0]) => {
      const incomplete = countIncompleteOperations.get(input.taskId)?.count ?? 0;
      if (incomplete > 0) {
        throw new Error("Administrative Task still has incomplete Operations");
      }
      const task = requireTask(input.taskId);
      if (task.status === "completed") return loadRecord(task);
      const result = completeTask.run(input.completedAt, input.taskId);
      if (result.changes !== 1) {
        throw new Error("Administrative Task cannot complete from its current state");
      }
      appendEvents(input.taskId, [input.completedEvent]);
      return loadRecord(requireTask(input.taskId));
    },
  );

  const denyTaskTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["denyTask"]>[0]) => {
      const reason =
        input.deniedEvent.kind === "administrative.task.denied"
          ? input.deniedEvent.details.reason
          : "Administrative Task denied.";
      const result = denyTask.run(reason, input.deniedAt, input.taskId);
      if (result.changes !== 1) {
        const task = requireTask(input.taskId);
        if (task.status === "denied") {
          appendEvents(
            input.taskId,
            settleOutstandingTaskOperations(
              input.taskId,
              reason,
              input.deniedAt,
            ),
          );
          return loadRecord(task);
        }
        throw new Error("Administrative Task cannot be denied from its current state");
      }
      const outstandingEvents = settleOutstandingTaskOperations(
        input.taskId,
        reason,
        input.deniedAt,
      );
      releaseTaskMutationLane.run(input.taskId);
      appendEvents(input.taskId, [...outstandingEvents, input.deniedEvent]);
      return loadRecord(requireTask(input.taskId));
    },
  );

  const expireEvidenceTransaction = database.transaction((cutoff: string) => {
    tombstoneExpiredRequests.run(cutoff, cutoff);
    deleteExpiredEvidence.run(cutoff);
  });

  function requireTask(taskId: string): AdministrativeTaskRow {
    const task = readTask.get(taskId);
    if (task === undefined) throw new Error("Administrative Task is unavailable");
    return task;
  }

  return {
    async applyEvidenceRetention(input) {
      expireEvidenceTransaction.immediate(input.cutoff);
    },
    async armLivePatchRollback(input) {
      return armLivePatchRollbackTransaction.immediate(input);
    },
    async activatePolicy(input) {
      return activateTransaction.immediate(input);
    },
    async claimConfirmation(input) {
      return claimTransaction.immediate(input);
    },
    async claimNextOperation(input) {
      return claimOperationTransaction.immediate(input);
    },
    async close() {
      database.close();
    },
    async completeOperation(input) {
      return completeOperationTransaction.immediate(input);
    },
    async settleClaimedOperationAndDenyTask(input) {
      return settleClaimedOperationAndDenyTaskTransaction.immediate(input);
    },
    async completeLivePatchRollbackActivation(input) {
      return completeLivePatchRollbackActivationTransaction.immediate(input);
    },
    async completeTask(input) {
      return completeTaskTransaction.immediate(input);
    },
    async denyTask(input) {
      return denyTaskTransaction.immediate(input);
    },
    async declineConfirmation(input) {
      return declineTransaction.immediate(input);
    },
    async findActivePolicy() {
      const state = requirePolicyState();
      return state.status !== "active" || state.active_revision === null
        ? undefined
        : requirePolicyRevision(state.active_revision);
    },
    async findTaskByOperationId(operationId) {
      const task = readTaskByOperationId.get(operationId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async findTask(taskId) {
      const task = readTask.get(taskId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async listTasks() {
      return listTasks.all().map(taskProjection);
    },
    async listRecoverableTaskIds() {
      return listRecoverableTaskIds
        .all()
        .map((row) => administrativeTaskIdSchema.parse(row.task_id));
    },
    async listPendingLivePatchRollbackActivations() {
      return listPendingLivePatchRollbacks
        .all()
        .map((row) =>
          pendingLivePatchRollbackActivationSchema.parse({
            attemptCount: row.attempt_count,
            lastFailureReason: row.last_error,
            nextAttemptAt: row.next_attempt_at,
            request: JSON.parse(row.request_json) as unknown,
          }),
        );
    },
    async readPolicyStatus() {
      return policyStatus();
    },
    async recordLivePatchRollbackActivationFailure(input) {
      return recordLivePatchRollbackActivationFailureTransaction.immediate(
        input,
      );
    },
    async readPolicyEvidence() {
      return policyEvidenceProjection();
    },
    async readPolicyEvidencePage(input) {
      return policyEvidencePage(input);
    },
    async recheckOperationEffect(input) {
      return recheckOperationEffectTransaction.immediate(input);
    },
    async renewOperationClaim(input) {
      return renewOperationTransaction.immediate(input);
    },
    async savePlan(input) {
      return planTransaction.immediate(input);
    },
    async savePreparedTask(input) {
      return prepareTransaction.immediate(input);
    },
    async suspendPolicy(input) {
      return suspendTransaction.immediate(input);
    },
  };
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS administrative_policy_revisions (
      revision INTEGER PRIMARY KEY,
      activated_at TEXT NOT NULL,
      activated_by TEXT NOT NULL CHECK (activated_by = 'fresh-passkey-action'),
      definition_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS administrative_policy_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL CHECK (status IN ('inactive', 'active', 'suspended')),
      active_revision INTEGER,
      state_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      suspended_at TEXT,
      FOREIGN KEY (active_revision)
        REFERENCES administrative_policy_revisions(revision)
    );

    CREATE TABLE IF NOT EXISTS administrative_policy_evidence_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind = 'administrative.policy.suspended'),
      occurred_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    INSERT OR IGNORE INTO administrative_policy_state (
      singleton, status, active_revision, state_version, updated_at, suspended_at
    ) VALUES (1, 'inactive', NULL, 0, '1970-01-01T00:00:00.000Z', NULL);

    CREATE TABLE IF NOT EXISTS administrative_tasks (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      capability_hash TEXT NOT NULL UNIQUE,
      capability_consumed_at TEXT,
      active_execution_deadline TEXT,
      outcome TEXT NOT NULL,
      publication_intent TEXT NOT NULL DEFAULT 'branch-only',
      execution_manifest_json TEXT,
      policy_revision INTEGER NOT NULL,
      state_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      intended_state TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      target_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (policy_revision)
        REFERENCES administrative_policy_revisions(revision)
    );

    CREATE TABLE IF NOT EXISTS administrative_operations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      policy_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claim_id TEXT,
      lease_expires_at TEXT,
      initial_execution_started_at TEXT,
      UNIQUE (task_id, ordinal),
      FOREIGN KEY (task_id) REFERENCES administrative_tasks(id),
      FOREIGN KEY (policy_revision)
        REFERENCES administrative_policy_revisions(revision)
    );

    CREATE TABLE IF NOT EXISTS administrative_live_patch_rollbacks (
      operation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'armed', 'activation-pending', 'activated', 'window-expired'
        )
      ),
      request_json TEXT NOT NULL,
      result_json TEXT,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      FOREIGN KEY (operation_id) REFERENCES administrative_operations(id),
      FOREIGN KEY (task_id) REFERENCES administrative_tasks(id)
    );

    CREATE TABLE IF NOT EXISTS administrative_mutation_lane (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      operation_id TEXT,
      claim_id TEXT,
      lease_expires_at TEXT,
      FOREIGN KEY (operation_id) REFERENCES administrative_operations(id)
    );

    INSERT OR IGNORE INTO administrative_mutation_lane (
      singleton, operation_id, claim_id, lease_expires_at
    ) VALUES (1, NULL, NULL, NULL);

    CREATE TABLE IF NOT EXISTS administrative_evidence_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      UNIQUE (task_id, sequence),
      FOREIGN KEY (task_id) REFERENCES administrative_tasks(id)
    );

    CREATE TABLE IF NOT EXISTS administrative_expired_request_ids (
      request_id TEXT PRIMARY KEY,
      expired_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS administrative_policy_revisions_no_update
    BEFORE UPDATE ON administrative_policy_revisions
    BEGIN
      SELECT RAISE(ABORT, 'Administrative policy revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_policy_revisions_no_delete
    BEFORE DELETE ON administrative_policy_revisions
    BEGIN
      SELECT RAISE(ABORT, 'Administrative policy revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_policy_evidence_no_update
    BEFORE UPDATE ON administrative_policy_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Administrative policy evidence is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_policy_evidence_no_delete
    BEFORE DELETE ON administrative_policy_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Administrative policy evidence is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_evidence_no_update
    BEFORE UPDATE ON administrative_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Administrative Evidence Events are immutable');
    END;

    DROP TRIGGER IF EXISTS administrative_evidence_no_delete;

    CREATE TRIGGER IF NOT EXISTS administrative_evidence_retention_delete_only
    BEFORE DELETE ON administrative_evidence_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM administrative_tasks
      JOIN administrative_expired_request_ids
        ON administrative_expired_request_ids.request_id =
          administrative_tasks.request_id
      WHERE administrative_tasks.id = OLD.task_id
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'Administrative Evidence Events are append-only until retention expiry'
      );
    END;
  `);
  ensureColumn(
    database,
    "administrative_tasks",
    "intended_state",
    "TEXT NOT NULL DEFAULT 'The intended state was not recorded by the legacy schema.'",
  );
  ensureColumn(
    database,
    "administrative_tasks",
    "active_execution_deadline",
    "TEXT",
  );
  ensureColumn(
    database,
    "administrative_tasks",
    "publication_intent",
    "TEXT NOT NULL DEFAULT 'branch-only'",
  );
  ensureColumn(
    database,
    "administrative_tasks",
    "execution_manifest_json",
    "TEXT",
  );
  ensureColumn(database, "administrative_operations", "claim_id", "TEXT");
  ensureColumn(
    database,
    "administrative_operations",
    "lease_expires_at",
    "TEXT",
  );
  ensureColumn(
    database,
    "administrative_operations",
    "initial_execution_started_at",
    "TEXT",
  );
  migrateAdministrativeLivePatchRollbacks(database);
}

function migrateAdministrativeLivePatchRollbacks(
  database: Database.Database,
): void {
  const table = database
    .prepare<[], { readonly sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'administrative_live_patch_rollbacks'",
    )
    .get();
  if (table?.sql.includes("window-expired")) return;
  database.pragma("foreign_keys = OFF");
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE administrative_live_patch_rollbacks
        RENAME TO administrative_live_patch_rollbacks_legacy;
      CREATE TABLE administrative_live_patch_rollbacks (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'armed', 'activation-pending', 'activated', 'window-expired'
          )
        ),
        request_json TEXT NOT NULL,
        result_json TEXT,
        updated_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES administrative_operations(id),
        FOREIGN KEY (task_id) REFERENCES administrative_tasks(id)
      );
      INSERT INTO administrative_live_patch_rollbacks (
        operation_id, task_id, status, request_json, result_json, updated_at,
        attempt_count, last_error, next_attempt_at
      )
      SELECT operation_id, task_id, status, request_json, result_json,
        updated_at, 0, NULL, updated_at
      FROM administrative_live_patch_rollbacks_legacy;
      DROP TABLE administrative_live_patch_rollbacks_legacy;
      COMMIT;
    `);
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.pragma(`table_info(${table})`) as Array<{
    readonly name: string;
  }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function rollbackWindowExpiryEventId(operationId: string): string {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return `administrative-rollback-window-expired-${digest}`;
}

function operationFailureEventId(operationId: string): string {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return `administrative-operation-failed-${digest}`;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}
