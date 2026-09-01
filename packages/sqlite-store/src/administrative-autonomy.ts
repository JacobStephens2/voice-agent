import Database from "better-sqlite3";

import {
  administrativeEvidenceEventSchema,
  administrativeEvidenceRecordSchema,
  administrativeMutationOperationKinds,
  administrativeOperationRequestSchema,
  administrativePolicyRevisionSchema,
  administrativePolicyStatusSchema,
  administrativeTaskSchema,
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
  readonly capability_consumed_at: string | null;
  readonly capability_hash: string;
  readonly conclusion: string;
  readonly created_at: string;
  readonly id: string;
  readonly intended_state: string;
  readonly outcome: AdministrativeTask["outcome"];
  readonly owner_id: string;
  readonly policy_revision: number;
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
      outcome, policy_revision, state_version, status, question, intended_state, conclusion,
      target_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const readTask = database.prepare<[taskId: string], AdministrativeTaskRow>(`
    SELECT id, owner_id, capability_hash, capability_consumed_at, outcome,
      policy_revision, state_version, status, question, conclusion,
      intended_state, target_json, created_at, updated_at
    FROM administrative_tasks
    WHERE id = ?
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
    SET capability_consumed_at = ?, status = 'planning', updated_at = ?
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
    SELECT id, task_id, status, request_json, claim_id, lease_expires_at
    FROM administrative_operations
    WHERE id = ?
  `);
  const readNextOperation = database.prepare<
    [taskId: string],
    AdministrativeOperationRow
  >(`
    SELECT id, task_id, status, request_json, claim_id, lease_expires_at
    FROM administrative_operations
    WHERE task_id = ? AND status != 'completed'
    ORDER BY ordinal
    LIMIT 1
  `);
  const claimOperation = database.prepare(`
    UPDATE administrative_operations
    SET status = 'running', claim_id = ?, lease_expires_at = ?, updated_at = ?
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
    SELECT id, owner_id, capability_hash, capability_consumed_at, outcome,
      policy_revision, state_version, status, question, conclusion,
      intended_state, target_json, created_at, updated_at
    FROM administrative_tasks
    ORDER BY updated_at DESC, id DESC
    LIMIT 100
  `);
  const listRecoverableTaskIds = database.prepare<[], { readonly task_id: string }>(`
    SELECT id AS task_id
    FROM administrative_tasks
    WHERE status = 'running'
    ORDER BY id
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
      return administrativePolicyStatusSchema.parse({
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
      conclusion: task.conclusion,
      createdAt: task.created_at,
      id: task.id,
      intendedState: task.intended_state,
      kind: "administrative.work",
      outcome: task.outcome,
      policyRevision: task.policy_revision,
      policyStateVersion: task.state_version,
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
      const result = suspendPolicyState.run(
        input.suspendedAt,
        input.suspendedAt,
        input.expectedRevision,
        input.expectedStateVersion,
      );
      return result.changes === 1 ? policyStatus() : undefined;
    },
  );

  const prepareTransaction = database.transaction(
    (input: AdministrativePreparedTaskPersistence) => {
      const policy = requirePolicyState();
      if (
        policy.status !== "active" ||
        policy.active_revision !== input.task.policyRevision ||
        policy.state_version !== input.stateVersion
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
      if (task === undefined) {
        return { decision: "denied", reason: "task-unavailable" };
      }
      if (task.owner_id !== input.ownerId) {
        return { decision: "denied", reason: "identity-mismatch" };
      }
      if (task.capability_hash !== input.capabilityHash) {
        return { decision: "denied", reason: "invalid-capability" };
      }
      if (
        task.capability_consumed_at !== null ||
        task.status !== "awaiting-confirmation"
      ) {
        return { decision: "denied", reason: "confirmation-replayed" };
      }
      const policy = requirePolicyState();
      if (
        policy.status !== "active" ||
        policy.active_revision !== task.policy_revision ||
        policy.state_version !== task.state_version
      ) {
        return { decision: "denied", reason: "stale-policy" };
      }
      const result = consumeConfirmation.run(
        input.acceptedAt,
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
      if (task === undefined) {
        return { decision: "denied", reason: "task-unavailable" };
      }
      if (task.owner_id !== input.ownerId) {
        return { decision: "denied", reason: "identity-mismatch" };
      }
      if (task.capability_hash !== input.capabilityHash) {
        return { decision: "denied", reason: "invalid-capability" };
      }
      if (
        task.capability_consumed_at !== null ||
        task.status !== "awaiting-confirmation"
      ) {
        return { decision: "denied", reason: "confirmation-replayed" };
      }
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
        throw new Error("Administrative Task is not ready for an Operation plan");
      }
      const policy = requirePolicyState();
      if (
        policy.status !== "active" ||
        policy.active_revision !== task.policy_revision ||
        policy.state_version !== task.state_version
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
          request.policyRevision !== task.policy_revision ||
          request.policyStateVersion !== task.state_version
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
          request.policyRevision,
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
      const request = administrativeOperationRequestSchema.parse(
        JSON.parse(operation.request_json),
      );
      const policy = requirePolicyState();
      if (
        policy.status !== "active" ||
        policy.active_revision !== request.policyRevision ||
        policy.state_version !== request.policyStateVersion
      ) {
        return { decision: "denied", reason: "stale-policy" };
      }
      if (
        request.kind === "live-patch.apply" &&
        request.mutationBoundary.independentRollback.rollbackDeadline <=
          input.claimedAt
      ) {
        return {
          decision: "denied",
          reason: "unsafe-live-patch-deadline",
        };
      }
      if (
        operation.status === "running" &&
        operation.lease_expires_at !== null &&
        operation.lease_expires_at > input.claimedAt
      ) {
        return {
          decision: "deferred",
          retryAt: operation.lease_expires_at,
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
          return { decision: "deferred", retryAt: lane.lease_expires_at };
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
        operation.id,
        input.taskId,
        input.claimedAt,
      );
      if (result.changes !== 1) {
        throw new Error("Administrative Operation changed concurrently");
      }
      return {
        claimId: input.claimId,
        decision: "claimed",
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

  function requireTask(taskId: string): AdministrativeTaskRow {
    const task = readTask.get(taskId);
    if (task === undefined) throw new Error("Administrative Task is unavailable");
    return task;
  }

  return {
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
    async findTask(taskId) {
      const task = readTask.get(taskId);
      return task === undefined ? undefined : loadRecord(task);
    },
    async listTasks() {
      return listTasks.all().map(taskProjection);
    },
    async listRecoverableTaskIds() {
      return listRecoverableTaskIds.all().map((row) => row.task_id);
    },
    async readPolicyStatus() {
      return policyStatus();
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
      outcome TEXT NOT NULL,
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
      UNIQUE (task_id, ordinal),
      FOREIGN KEY (task_id) REFERENCES administrative_tasks(id),
      FOREIGN KEY (policy_revision)
        REFERENCES administrative_policy_revisions(revision)
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

    CREATE TRIGGER IF NOT EXISTS administrative_evidence_no_delete
    BEFORE DELETE ON administrative_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Administrative Evidence Events are immutable');
    END;
  `);
  ensureColumn(
    database,
    "administrative_tasks",
    "intended_state",
    "TEXT NOT NULL DEFAULT 'The intended state was not recorded by the legacy schema.'",
  );
  ensureColumn(database, "administrative_operations", "claim_id", "TEXT");
  ensureColumn(
    database,
    "administrative_operations",
    "lease_expires_at",
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
