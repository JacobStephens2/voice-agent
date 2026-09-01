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
  administrativePolicyRevisionSchema,
  administrativePolicyStatusSchema,
  administrativeTaskIdSchema,
  administrativeTaskSchema,
  administrativeTimestampSchema,
  administrativeUnavailableExecutionManifest,
  livePatchRollbackActivationRequestSchema,
  livePatchRollbackActivationResultSchema,
  livePatchRollbackWindowMilliseconds,
  sameAdministrativeAuthoritySnapshot,
  sameAdministrativeExecutionManifest,
  type AdministrativeAuthoritySnapshot,
  type AdministrativeExecutionManifest,
  type AdministrativeEvidenceEvent,
  type AdministrativeEvidenceRecord,
  type AdministrativePolicyStatus,
  type AdministrativeTask,
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
  readonly status: "accepted" | "completed" | "running";
  readonly task_id: string;
}

interface AdministrativeMutationLaneRow {
  readonly claim_id: string | null;
  readonly lease_expires_at: string | null;
  readonly operation_id: string | null;
}

interface LivePatchRollbackRow {
  readonly operation_id: string;
  readonly request_json: string;
  readonly result_json: string | null;
  readonly status: "activated" | "activation-pending" | "armed";
  readonly task_id: string;
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
    SELECT id, owner_id, capability_hash, capability_consumed_at,
      active_execution_deadline, outcome,
      publication_intent, execution_manifest_json, policy_revision,
      state_version, status, question, conclusion,
      intended_state, target_json, created_at, updated_at
    FROM administrative_tasks
    WHERE id = ?
  `);
  const readTaskByOperationId = database.prepare<
    [operationId: string],
    AdministrativeTaskRow
  >(`
    SELECT tasks.id, tasks.owner_id, tasks.capability_hash,
      tasks.capability_consumed_at, tasks.active_execution_deadline,
      tasks.outcome, tasks.publication_intent, tasks.execution_manifest_json,
      tasks.policy_revision, tasks.state_version, tasks.status,
      tasks.question, tasks.conclusion, tasks.intended_state, tasks.target_json,
      tasks.created_at, tasks.updated_at
    FROM administrative_tasks AS tasks
    JOIN administrative_operations AS operations ON operations.task_id = tasks.id
    WHERE operations.id = ?
  `);
  const readEvents = database.prepare<
    [taskId: string],
    AdministrativeEvidenceRow
  >(`
    SELECT id, sequence, kind, occurred_at, summary, details_json
    FROM administrative_evidence_events
    WHERE task_id = ?
    ORDER BY sequence
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
      initial_execution_started_at
    FROM administrative_operations
    WHERE id = ?
  `);
  const readNextOperation = database.prepare<
    [taskId: string],
    AdministrativeOperationRow
  >(`
    SELECT id, task_id, status, request_json, claim_id, lease_expires_at,
      initial_execution_started_at
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
    SELECT id, owner_id, capability_hash, capability_consumed_at,
      active_execution_deadline, outcome,
      publication_intent, execution_manifest_json, policy_revision,
      state_version, status, question, conclusion,
      intended_state, target_json, created_at, updated_at
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
    SELECT operation_id, task_id, status, request_json, result_json
    FROM administrative_live_patch_rollbacks
    WHERE operation_id = ?
  `);
  const insertLivePatchRollback = database.prepare(`
    INSERT INTO administrative_live_patch_rollbacks (
      operation_id, task_id, status, request_json, result_json, updated_at
    ) VALUES (?, ?, 'armed', ?, NULL, ?)
  `);
  const markArmedRollbacksPending = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET status = 'activation-pending', updated_at = ?
    WHERE status = 'armed'
  `);
  const activateLivePatchRollbackWindow = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET request_json = ?, updated_at = ?
    WHERE operation_id = ? AND status = 'armed'
  `);
  const listLivePatchRollbacks = database.prepare<[], LivePatchRollbackRow>(`
    SELECT operation_id, task_id, status, request_json, result_json
    FROM administrative_live_patch_rollbacks
    ORDER BY operation_id
  `);
  const listPendingLivePatchRollbacks = database.prepare<
    [],
    LivePatchRollbackRow
  >(`
    SELECT operation_id, task_id, status, request_json, result_json
    FROM administrative_live_patch_rollbacks
    WHERE status = 'activation-pending'
    ORDER BY operation_id
  `);
  const countPendingLivePatchRollbacks = database.prepare<
    [],
    { readonly count: number }
  >(`
    SELECT COUNT(*) AS count
    FROM administrative_live_patch_rollbacks
    WHERE status = 'activation-pending'
  `);
  const completeLivePatchRollbackActivation = database.prepare(`
    UPDATE administrative_live_patch_rollbacks
    SET status = 'activated', result_json = ?, updated_at = ?
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
      const rollbacks = listLivePatchRollbacks.all();
      return administrativePolicyStatusSchema.parse({
        executionManifest: requirePolicyRevision(row.active_revision)
          .executionManifest,
        rollbackActivations: {
          activatedOperationIds: rollbacks
            .filter((rollback) => rollback.status === "activated")
            .map((rollback) => rollback.operation_id),
          pendingOperationIds: rollbacks
            .filter((rollback) => rollback.status !== "activated")
            .map((rollback) => rollback.operation_id),
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

  function loadRecord(task: AdministrativeTaskRow): AdministrativeEvidenceRecord {
    return administrativeEvidenceRecordSchema.parse({
      evidence: readEvents.all(task.id).map((event) => ({
        details: JSON.parse(event.details_json) as unknown,
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurred_at,
        sequence: event.sequence,
        summary: event.summary,
      })),
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
      executionManifest: taskExecutionManifest(task),
      policyRevision: task.policy_revision,
      policyStateVersion: task.state_version,
      publicationIntent: task.publication_intent,
      question: task.question,
      status: task.status,
      target: JSON.parse(task.target_json) as unknown,
      updatedAt: task.updated_at,
    });
  }

  const activateTransaction = database.transaction(
    (input: Parameters<AdministrativeAutonomyStore["activatePolicy"]>[0]) => {
      const current = requirePolicyState();
      const activeRevision =
        current.status === "inactive" ? null : current.active_revision;
      if (
        activeRevision !== input.expectedActiveRevision ||
        current.state_version !== input.expectedStateVersion ||
        (countPendingLivePatchRollbacks.get()?.count ?? 0) > 0 ||
        administrativeExecutionManifestFingerprint(
          input.revision.executionManifest,
        ) !== input.expectedExecutionManifestFingerprint ||
        input.revision.revision !== (activeRevision ?? 0) + 1 ||
        input.stateVersion !== current.state_version + 1
      ) {
        return undefined;
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
      const current = requirePolicyState();
      if (
        current.status === "suspended" &&
        current.active_revision === input.expectedRevision &&
        current.state_version === input.expectedStateVersion + 1
      ) {
        markArmedRollbacksPending.run(input.suspendedAt);
        return policyStatus(current);
      }
      const result = suspendPolicyState.run(
        input.suspendedAt,
        input.suspendedAt,
        input.expectedRevision,
        input.expectedStateVersion,
      );
      if (result.changes !== 1) return undefined;
      markArmedRollbacksPending.run(input.suspendedAt);
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
        operationRequest.target.environment !== request.target.environment ||
        operationRequest.target.registeredCodebaseId !==
          request.target.registeredCodebaseId ||
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
      const rollback = readLivePatchRollback.get(result.operationId);
      if (rollback === undefined) return false;
      const request = livePatchRollbackActivationRequestSchema.parse(
        JSON.parse(rollback.request_json),
      );
      if (
        request.operationId !== result.operationId ||
        request.taskId !== result.taskId ||
        request.target.environment !== result.target.environment ||
        request.target.registeredCodebaseId !==
          result.target.registeredCodebaseId
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
          recorded.target.environment === request.target.environment &&
          recorded.target.registeredCodebaseId ===
            request.target.registeredCodebaseId
        );
      }
      if (
        rollback.status !== "activation-pending" ||
        requirePolicyState().status !== "suspended"
      ) {
        return false;
      }
      return (
        completeLivePatchRollbackActivation.run(
          JSON.stringify(result),
          result.activatedAt,
          result.operationId,
        ).changes === 1
      );
    },
  );

  const prepareTransaction = database.transaction(
    (input: AdministrativePreparedTaskPersistence) => {
      if (
        !matchesAuthoritySnapshot(
          administrativeAuthoritySnapshotSchema.parse({
            executionManifest: input.task.executionManifest,
            policyRevision: input.task.policyRevision,
            policyStateVersion: input.stateVersion,
          }),
        )
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
          JSON.stringify(input.task.executionManifest),
          input.task.policyRevision,
          input.stateVersion,
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
      if (operation.status === "completed") {
        return loadRecord(requireTask(input.taskId));
      }
      if (operation.claim_id !== input.claimId) {
        throw new Error("Administrative Operation claim changed concurrently");
      }
      const task = requireTask(input.taskId);
      const request = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      if (
        task.active_execution_deadline === null ||
        input.result.completedAt >= task.active_execution_deadline ||
        !matchesAuthoritySnapshot(request.authority)
      ) {
        throw new Error("Administrative Operation authority is no longer active");
      }
      if (request.kind === "live-patch.apply") {
        const rollback = readLivePatchRollback.get(input.operationId);
        const result =
          input.result.kind === "live-patch.apply" ? input.result : undefined;
        if (rollback?.status !== "armed" || result === undefined) {
          throw new Error("Live Patch rollback is not armed");
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
            result.mutationProof.independentRollback.rollbackDeadline
        ) {
          throw new Error("Live Patch rollback proof changed after arming");
        }
      }
      const result = completeOperation.run(
        JSON.stringify(input.result),
        input.result.completedAt,
        input.operationId,
        input.taskId,
        input.claimId,
      );
      if (result.changes !== 1) {
        throw new Error("Administrative Operation changed concurrently");
      }
      releaseMutationLane.run(input.operationId, input.claimId);
      appendEvents(input.taskId, [input.completedEvent]);
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
        if (task.status === "denied") return loadRecord(task);
        throw new Error("Administrative Task cannot be denied from its current state");
      }
      releaseTaskMutationLane.run(input.taskId);
      appendEvents(input.taskId, [input.deniedEvent]);
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
          livePatchRollbackActivationRequestSchema.parse(
            JSON.parse(row.request_json),
          ),
        );
    },
    async readPolicyStatus() {
      return policyStatus();
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
        status IN ('armed', 'activation-pending', 'activated')
      ),
      request_json TEXT NOT NULL,
      result_json TEXT,
      updated_at TEXT NOT NULL,
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

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}
