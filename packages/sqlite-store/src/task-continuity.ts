import Database from "better-sqlite3";

import {
  notificationPreferenceInputSchema,
  notificationPreferenceSchema,
  registeredTelephoneSchema,
  type NotificationPreference,
} from "@voice-agent/contracts";
import type {
  ClaimedCompletionReport,
  CompletionCallbackOutcomeRecord,
  CompletionCallbackRequestSnapshot,
  NotificationDeliveryRecord,
  TaskContinuityStore,
} from "@voice-agent/durable-store";

interface CompletionRequestRow {
  readonly notification_operation_id: string | null;
  readonly operation_id: string;
  readonly preference_revision: number;
  readonly report_id: string;
  readonly request_id: string;
  readonly requested_at: string;
  readonly requested_event_id: string;
  readonly resumption_operation_id: string | null;
  readonly task_id: string;
  readonly state: string;
  readonly telephone_json: string;
  readonly telephone_session_id: string;
}

interface DeliveryRow {
  readonly result_json: string;
}

interface PreferenceRow {
  readonly click_tracking: number;
  readonly configured_at: string;
  readonly email: string;
  readonly from_identity: string;
  readonly notification_subdomain: string;
  readonly open_tracking: number;
  readonly revision: number;
}

interface OperationRow {
  readonly result_json: string;
  readonly status: string;
  readonly updated_at: string;
}

export function createSqliteTaskContinuityStore(
  databasePath: string,
): TaskContinuityStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const findByRequestId = database.prepare<[requestId: string], CompletionRequestRow>(`
    SELECT report_id, request_id, task_id, telephone_session_id,
      operation_id, requested_event_id, requested_at, telephone_json,
      preference_revision, notification_operation_id, resumption_operation_id,
      state
    FROM task_completion_reports
    WHERE request_id = ?
  `);
  const findByOperationId = database.prepare<
    [operationId: string, notificationOperationId: string, resumptionOperationId: string],
    CompletionRequestRow
  >(`
    SELECT report_id, request_id, task_id, telephone_session_id,
      operation_id, requested_event_id, requested_at, telephone_json,
      preference_revision, notification_operation_id, resumption_operation_id,
      state
    FROM task_completion_reports
    WHERE operation_id = ? OR notification_operation_id = ?
      OR resumption_operation_id = ?
  `);
  const insertRequest = database.prepare(`
    INSERT INTO task_completion_reports (
      report_id, request_id, task_id, telephone_session_id, operation_id,
      requested_event_id, requested_at, telephone_json, preference_revision,
      notification_operation_id, resumption_operation_id, state,
      lease_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'waiting-task', NULL)
  `);
  const insertOperation = database.prepare(`
    INSERT INTO operations (
      id, task_id, idempotency_key, kind, status, result_json,
      created_at, updated_at, lease_expires_at
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, NULL)
  `);
  const findCallbackClaim = database.prepare<
    [claimedAt: string],
    CompletionRequestRow
  >(`
    SELECT reports.report_id, reports.request_id, reports.task_id,
      reports.telephone_session_id, reports.operation_id,
      reports.requested_event_id, reports.requested_at,
      reports.telephone_json, reports.preference_revision,
      reports.notification_operation_id, reports.resumption_operation_id,
      reports.state
    FROM task_completion_reports AS reports
    JOIN durable_tasks AS tasks ON tasks.id = reports.task_id
    -- A Delegation reaches its terminal state as 'failed' or 'stopped' just as
    -- often as 'completed', and those are the outcomes a caller most needs
    -- reported, so every terminal status claims its report.
    WHERE tasks.status IN ('completed', 'cancelled', 'failed', 'stopped')
      AND (
        reports.state = 'waiting-task'
        OR (
          reports.state = 'callback-running'
          AND reports.lease_expires_at <= ?
        )
      )
    ORDER BY reports.requested_at, reports.report_id
    LIMIT 1
  `);
  const findNotificationClaim = database.prepare<
    [claimedAt: string],
    CompletionRequestRow
  >(`
    SELECT report_id, request_id, task_id, telephone_session_id,
      operation_id, requested_event_id, requested_at, telephone_json,
      preference_revision, notification_operation_id, resumption_operation_id,
      state
    FROM task_completion_reports
    WHERE state = 'notification-ready'
      OR (state = 'notification-running' AND lease_expires_at <= ?)
    ORDER BY requested_at, report_id
    LIMIT 1
  `);
  const findResumptionClaim = database.prepare<
    [claimedAt: string],
    CompletionRequestRow
  >(`
    SELECT report_id, request_id, task_id, telephone_session_id,
      operation_id, requested_event_id, requested_at, telephone_json,
      preference_revision, notification_operation_id, resumption_operation_id,
      state
    FROM task_completion_reports
    WHERE state IN ('resumption-ready', 'resumption-running')
      AND lease_expires_at <= ?
    ORDER BY requested_at, report_id
    LIMIT 1
  `);
  const claimReport = database.prepare(`
    UPDATE task_completion_reports
    SET state = ?, lease_expires_at = ?
    WHERE report_id = ?
      AND (
        state = ?
        OR (state = ? AND lease_expires_at <= ?)
      )
  `);
  const claimOperation = database.prepare(`
    UPDATE operations
    SET status = 'running', lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('accepted', 'running')
  `);
  const completeOperation = database.prepare(`
    UPDATE operations
    SET status = 'completed', result_json = ?, lease_expires_at = NULL,
      updated_at = ?
    WHERE id = ? AND status IN ('accepted', 'running')
  `);
  const updateReportAfterCallback = database.prepare(`
    UPDATE task_completion_reports
    SET state = ?, notification_operation_id = ?, lease_expires_at = NULL
    WHERE report_id = ? AND state IN (
      'callback-running', 'resumption-ready', 'resumption-running', 'completed'
    )
  `);
  const markResumptionReady = database.prepare(`
    UPDATE task_completion_reports
    SET state = 'resumption-ready', lease_expires_at = ?,
      resumption_operation_id = ?
    WHERE report_id = ? AND state = 'callback-running'
  `);
  const markImmediateResumptionRunning = database.prepare(`
    UPDATE task_completion_reports
    SET state = 'resumption-running', lease_expires_at = ?
    WHERE task_id = ? AND resumption_operation_id = ?
      AND state = 'resumption-ready' AND lease_expires_at > ?
  `);
  const completeResumption = database.prepare(`
    UPDATE task_completion_reports
    SET state = 'completed', lease_expires_at = NULL
    WHERE resumption_operation_id = ?
      AND state IN ('resumption-ready', 'resumption-running')
  `);
  const findResumptionState = database.prepare<
    [operationId: string],
    { readonly state: string }
  >(`
    SELECT state FROM task_completion_reports WHERE operation_id = ?
  `);
  const findOperation = database.prepare<[operationId: string], OperationRow>(`
    SELECT status, result_json, updated_at FROM operations WHERE id = ?
  `);
  const findOutcomeByOperation = database.prepare<
    [operationId: string],
    DeliveryRow
  >(`
    SELECT result_json
    FROM task_completion_deliveries
    WHERE kind = 'completion-callback'
      AND json_extract(result_json, '$.event.operationId') = ?
    ORDER BY delivery_id
    LIMIT 1
  `);
  const completeReportAfterNotification = database.prepare(`
    UPDATE task_completion_reports
    SET state = 'completed', lease_expires_at = NULL
    WHERE report_id = ? AND state = 'notification-running'
  `);
  const findDelivery = database.prepare<[deliveryId: string], DeliveryRow>(`
    SELECT result_json FROM task_completion_deliveries WHERE delivery_id = ?
  `);
  const insertDelivery = database.prepare(`
    INSERT INTO task_completion_deliveries (delivery_id, kind, result_json)
    VALUES (?, ?, ?)
  `);
  const insertPlacementClaim = database.prepare(`
    INSERT OR IGNORE INTO completion_callback_placement_claims (
      effect_id, task_id
    ) VALUES (?, ?)
  `);
  const deletePlacementClaim = database.prepare(`
    DELETE FROM completion_callback_placement_claims WHERE effect_id = ?
  `);
  const findLatestPreference = database.prepare<[], PreferenceRow>(`
    SELECT revision, email, from_identity, notification_subdomain,
      open_tracking, click_tracking, configured_at
    FROM notification_preferences
    ORDER BY revision DESC
    LIMIT 1
  `);
  const findPreferenceRevision = database.prepare<
    [revision: number],
    PreferenceRow
  >(`
    SELECT revision, email, from_identity, notification_subdomain,
      open_tracking, click_tracking, configured_at
    FROM notification_preferences
    WHERE revision = ?
  `);
  const insertPreference = database.prepare(`
    INSERT INTO notification_preferences (
      revision, email, from_identity, notification_subdomain,
      open_tracking, click_tracking, configured_at
    ) VALUES (?, ?, ?, ?, 0, 0, ?)
  `);
  const activateEvidenceLifecyclePolicy = database.prepare(`
    INSERT INTO evidence_lifecycle_policy (policy_id, activated_at)
    VALUES ('ordinary-evidence-90-days', ?)
    ON CONFLICT(policy_id) DO NOTHING
  `);
  const findActiveEvidenceLifecyclePolicy = database.prepare<
    [],
    { readonly policy_id: string }
  >(`
    SELECT policy_id FROM evidence_lifecycle_policy
    WHERE policy_id = 'ordinary-evidence-90-days'
  `);

  const persistRequest = database.transaction(
    (snapshot: CompletionCallbackRequestSnapshot) => {
      const existing = findByRequestId.get(snapshot.requestId);
      if (existing !== undefined) return mapRequestRow(existing);
      insertRequest.run(
        snapshot.reportId,
        snapshot.requestId,
        snapshot.taskId,
        snapshot.telephoneSessionId,
        snapshot.operationId,
        snapshot.requestedEventId,
        snapshot.requestedAt,
        JSON.stringify(snapshot.telephone),
        snapshot.preferenceRevision,
      );
      insertOperation.run(
        snapshot.operationId,
        snapshot.taskId,
        `completion-callback:${snapshot.requestId}`,
        "completion.callback",
        "accepted",
        snapshot.requestedAt,
        snapshot.requestedAt,
      );
      return snapshot;
    },
  );

  const claimImmediateResumption = database.transaction((input: {
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
    readonly operationId: string;
    readonly taskId: string;
  }): boolean => {
    if (insertPlacementClaim.run(input.operationId, input.taskId).changes !== 1) {
      return false;
    }
    if (
      markImmediateResumptionRunning.run(
        input.leaseExpiresAt,
        input.taskId,
        input.operationId,
        input.claimedAt,
      ).changes !== 1
    ) {
      deletePlacementClaim.run(input.operationId);
      return false;
    }
    if (
      claimOperation.run(
        input.leaseExpiresAt,
        input.claimedAt,
        input.operationId,
      ).changes !== 1
    ) {
      throw new Error("Completion resumption Operation cannot be claimed");
    }
    return true;
  });

  const claim = database.transaction(
    (input: {
      readonly claimedAt: string;
      readonly callbackLeaseExpiresAt: string;
      readonly notificationLeaseExpiresAt: string;
    }): ClaimedCompletionReport | undefined => {
      const callback = findCallbackClaim.get(input.claimedAt);
      if (callback !== undefined) {
        const changed = claimReport.run(
          "callback-running",
          input.callbackLeaseExpiresAt,
          callback.report_id,
          "waiting-task",
          "callback-running",
          input.claimedAt,
        );
        if (changed.changes !== 1) return undefined;
        claimOperation.run(
          input.callbackLeaseExpiresAt,
          input.claimedAt,
          callback.operation_id,
        );
        return {
          kind: "callback",
          operationId: callback.operation_id,
          taskId: callback.task_id,
          telephone: registeredTelephoneSchema.parse(
            JSON.parse(callback.telephone_json),
          ),
          telephoneSessionId: callback.telephone_session_id,
        };
      }

      const resumption = findResumptionClaim.get(input.claimedAt);
      if (resumption !== undefined) {
        const changed = claimReport.run(
          "resumption-running",
          input.callbackLeaseExpiresAt,
          resumption.report_id,
          "resumption-ready",
          "resumption-running",
          input.claimedAt,
        );
        if (changed.changes !== 1) return undefined;
        if (resumption.resumption_operation_id === null) {
          throw new Error("Completion resumption Operation is unavailable");
        }
        claimOperation.run(
          input.callbackLeaseExpiresAt,
          input.claimedAt,
          resumption.resumption_operation_id,
        );
        return {
          callbackOperationId: resumption.operation_id,
          kind: "resumption",
          operationId: resumption.resumption_operation_id,
          taskId: resumption.task_id,
          telephoneSessionId:
            requireResumedTelephoneSessionId(resumption.operation_id),
        };
      }

      const notification = findNotificationClaim.get(input.claimedAt);
      if (
        notification === undefined ||
        notification.notification_operation_id === null
      ) {
        return undefined;
      }
      const changed = claimReport.run(
        "notification-running",
        input.notificationLeaseExpiresAt,
        notification.report_id,
        "notification-ready",
        "notification-running",
        input.claimedAt,
      );
      if (changed.changes !== 1) return undefined;
      claimOperation.run(
        input.notificationLeaseExpiresAt,
        input.claimedAt,
        notification.notification_operation_id,
      );
      const preference = findPreferenceRevision.get(
        notification.preference_revision,
      );
      if (preference === undefined) {
        throw new Error("Notification preference revision is unavailable");
      }
      return {
        kind: "notification",
        operationId: notification.notification_operation_id,
        preference: mapPreference(preference),
        taskId: notification.task_id,
      };
    },
  );

  const applyCallbackOutcome = database.transaction(
    (record: CompletionCallbackOutcomeRecord) => {
      const duplicate = findDelivery.get(record.event.deliveryId);
      if (duplicate !== undefined) {
        return {
          duplicate: true,
          record: JSON.parse(duplicate.result_json) as CompletionCallbackOutcomeRecord,
        };
      }
      const terminalOutcome = findOutcomeByOperation.get(
        record.event.operationId,
      );
      if (terminalOutcome !== undefined) {
        const persisted = JSON.parse(
          terminalOutcome.result_json,
        ) as CompletionCallbackOutcomeRecord;
        insertDelivery.run(
          record.event.deliveryId,
          "completion-callback",
          JSON.stringify(persisted),
        );
        return { duplicate: true, record: persisted };
      }
      const report = findByOperationId.get(
        record.event.operationId,
        record.event.operationId,
        record.event.operationId,
      );
      if (report === undefined || report.task_id !== record.taskId) {
        throw new Error("Completion Callback Operation is unavailable");
      }
      if (
        completeOperation.run(
          JSON.stringify({ outcome: record.event.outcome }),
          record.occurredAt,
          record.event.operationId,
        ).changes !== 1
      ) {
        throw new Error("Completion Callback Operation is already terminal");
      }
      if (record.event.outcome === "authorized") {
        if (
          record.resumptionLeaseExpiresAt === undefined ||
          record.resumptionOperationId === undefined
        ) {
          throw new Error("Completion Callback resumption is unavailable");
        }
        insertOperation.run(
          record.resumptionOperationId,
          record.taskId,
          `completion-resumption:${record.event.operationId}`,
          "completion.resumption",
          "accepted",
          record.occurredAt,
          record.occurredAt,
        );
        if (
          markResumptionReady.run(
            record.resumptionLeaseExpiresAt,
            record.resumptionOperationId,
            report.report_id,
          ).changes !== 1
        ) {
          throw new Error("Completion Callback resumption is unavailable");
        }
      } else {
        if (
          record.notificationOperationId === undefined ||
          record.notificationRequestedEventId === undefined
        ) {
          throw new Error("Silent Notification identity is required");
        }
        insertOperation.run(
          record.notificationOperationId,
          record.taskId,
          `silent-notification:${record.event.operationId}`,
          "silent.notification",
          "accepted",
          record.occurredAt,
          record.occurredAt,
        );
        updateReportAfterCallback.run(
          "notification-ready",
          record.notificationOperationId,
          report.report_id,
        );
      }
      insertDelivery.run(
        record.event.deliveryId,
        "completion-callback",
        JSON.stringify(record),
      );
      return { duplicate: false, record };
    },
  );

  const completeNotification = database.transaction(
    (record: NotificationDeliveryRecord) => {
      const duplicate = findDelivery.get(record.deliveryId);
      if (duplicate !== undefined) {
        return {
          duplicate: true,
          record: JSON.parse(duplicate.result_json) as NotificationDeliveryRecord,
        };
      }
      const report = findByOperationId.get(
        record.operationId,
        record.operationId,
        record.operationId,
      );
      if (report === undefined || report.task_id !== record.taskId) {
        throw new Error("Silent Notification Operation is unavailable");
      }
      completeOperation.run(
        JSON.stringify({ providerMessageId: record.providerMessageId }),
        record.occurredAt,
        record.operationId,
      );
      const completed = completeReportAfterNotification.run(report.report_id);
      if (completed.changes !== 1) {
        throw new Error("Silent Notification Operation is not running");
      }
      insertDelivery.run(
        record.deliveryId,
        "silent-notification",
        JSON.stringify(record),
      );
      return { duplicate: false, record };
    },
  );

  const completeCompletionResumption = database.transaction(
    (
      operationId: string,
      occurredAt: string,
    ): CompletionCallbackOutcomeRecord | undefined => {
      const completionDeliveryId = `completion-resumption:${operationId}`;
      const existing = findDelivery.get(completionDeliveryId);
      if (existing !== undefined) {
        return JSON.parse(
          existing.result_json,
        ) as CompletionCallbackOutcomeRecord;
      }
      const report = findByOperationId.get(operationId, operationId, operationId);
      if (
        report === undefined ||
        report.resumption_operation_id !== operationId
      ) {
        return undefined;
      }
      const operation = findOperation.get(operationId);
      if (operation === undefined) {
        throw new Error("Completion resumption Operation is unavailable");
      }
      const operationResult = JSON.parse(operation.result_json) as {
        readonly outcome?: string;
      };
      if (
        operation.status === "completed" &&
        operationResult.outcome !== "resumed"
      ) {
        return undefined;
      }
      if (
        operation.status !== "completed" &&
        !["resumption-ready", "resumption-running", "completed"].includes(
          report.state,
        )
      ) {
        return undefined;
      }
      const completedAt =
        operation.status === "completed" ? operation.updated_at : occurredAt;
      if (
        operation.status !== "completed" &&
        completeOperation.run(
          JSON.stringify({ outcome: "resumed" }),
          completedAt,
          operationId,
        ).changes !== 1
      ) {
        throw new Error("Completion resumption Operation is already terminal");
      }
      if (
        report.state !== "completed" &&
        completeResumption.run(operationId).changes !== 1
      ) {
        throw new Error("Completion resumption report changed concurrently");
      }
      const outcome = findOutcomeByOperation.get(report.operation_id);
      if (outcome === undefined) {
        throw new Error("Completion Callback outcome is unavailable");
      }
      const record = {
        ...(JSON.parse(
          outcome.result_json,
        ) as CompletionCallbackOutcomeRecord),
        resumptionCompletedAt: completedAt,
      };
      insertDelivery.run(
        completionDeliveryId,
        "completion-resumption",
        JSON.stringify(record),
      );
      return record;
    },
  );

  const requestFailureNotification = database.transaction((input: {
    readonly callbackOperationId: string;
    readonly notificationOperationId: string;
    readonly occurredAt: string;
    readonly taskId: string;
  }) => {
    const report = findByOperationId.get(
      input.callbackOperationId,
      input.callbackOperationId,
      input.callbackOperationId,
    );
    if (report === undefined || report.task_id !== input.taskId) {
      throw new Error("Completion Callback Operation is unavailable");
    }
    if (report.notification_operation_id !== null) {
      return {
        notificationOperationId: report.notification_operation_id,
        ...resumptionCompletionIdentity(report.operation_id),
      };
    }
    insertOperation.run(
      input.notificationOperationId,
      input.taskId,
      `silent-notification:${input.callbackOperationId}`,
      "silent.notification",
      "accepted",
      input.occurredAt,
      input.occurredAt,
    );
    const changed = updateReportAfterCallback.run(
      "notification-ready",
      input.notificationOperationId,
      report.report_id,
    );
    if (changed.changes !== 1) {
      throw new Error("Completion report cannot request a failure notification");
    }
    if (report.resumption_operation_id !== null) {
      completeOperation.run(
        JSON.stringify({ outcome: "failed" }),
        input.occurredAt,
        report.resumption_operation_id,
      );
    }
    return {
      notificationOperationId: input.notificationOperationId,
      ...resumptionCompletionIdentity(report.operation_id),
    };
  });

  function resumptionCompletionIdentity(callbackOperationId: string): {
    readonly resumptionCompletedEventId?: string;
    readonly resumptionOperationId?: string;
  } {
    const outcome = findOutcomeByOperation.get(callbackOperationId);
    if (outcome === undefined) return {};
    const record = JSON.parse(
      outcome.result_json,
    ) as CompletionCallbackOutcomeRecord;
    return {
      ...(record.resumptionCompletedEventId === undefined
        ? {}
        : { resumptionCompletedEventId: record.resumptionCompletedEventId }),
      ...(record.resumptionOperationId === undefined
        ? {}
        : { resumptionOperationId: record.resumptionOperationId }),
    };
  }

  function requireResumedTelephoneSessionId(operationId: string): string {
    const outcome = findOutcomeByOperation.get(operationId);
    if (outcome === undefined) {
      throw new Error("Completion Callback outcome is unavailable");
    }
    const record = JSON.parse(
      outcome.result_json,
    ) as CompletionCallbackOutcomeRecord;
    if (record.resumedTelephoneSessionId === undefined) {
      throw new Error("Completion Callback resumption identity is unavailable");
    }
    return record.resumedTelephoneSessionId;
  }

  return {
    async activateEvidenceLifecyclePolicy(activatedAt) {
      activateEvidenceLifecyclePolicy.run(activatedAt);
    },
    async applyCompletionCallbackOutcome(record) {
      return applyCallbackOutcome.immediate(record);
    },
    async claimNextReport(input) {
      return claim.immediate(input);
    },
    async claimCompletionCallbackPlacement(effectId, taskId) {
      return insertPlacementClaim.run(effectId, taskId).changes === 1;
    },
    async claimImmediateCompletionResumption(input) {
      return claimImmediateResumption.immediate(input);
    },
    async close() {
      database.close();
    },
    async completeNotification(record) {
      return completeNotification.immediate(record);
    },
    async completeCompletionResumption(operationId, occurredAt) {
      return completeCompletionResumption.immediate(operationId, occurredAt);
    },
    async configureNotification(untrustedInput, configuredAt) {
      const input = notificationPreferenceInputSchema.parse(untrustedInput);
      requireSenderSubdomain(input.from, input.notificationSubdomain);
      const current = findLatestPreference.get();
      if (
        current !== undefined &&
        current.email === input.email &&
        current.from_identity === input.from &&
        current.notification_subdomain === input.notificationSubdomain
      ) {
        return mapPreference(current);
      }
      const revision = (current?.revision ?? 0) + 1;
      insertPreference.run(
        revision,
        input.email,
        input.from,
        input.notificationSubdomain,
        configuredAt,
      );
      return mapPreference({
        click_tracking: 0,
        configured_at: configuredAt,
        email: input.email,
        from_identity: input.from,
        notification_subdomain: input.notificationSubdomain,
        open_tracking: 0,
        revision,
      });
    },
    async findCompletionCallbackOutcome(deliveryId) {
      const row = findDelivery.get(deliveryId);
      return row === undefined
        ? undefined
        : (JSON.parse(row.result_json) as CompletionCallbackOutcomeRecord);
    },
    async findCompletionCallbackRequest(requestId) {
      const row = findByRequestId.get(requestId);
      return row === undefined ? undefined : mapRequestRow(row);
    },
    async findNotificationDelivery(deliveryId) {
      const row = findDelivery.get(deliveryId);
      return row === undefined
        ? undefined
        : (JSON.parse(row.result_json) as NotificationDeliveryRecord);
    },
    async findNotificationPreference() {
      const row = findLatestPreference.get();
      return row === undefined ? undefined : mapPreference(row);
    },
    async isCompletionResumptionPending(operationId) {
      return findResumptionState.get(operationId)?.state === "resumption-ready";
    },
    async isEvidenceLifecyclePolicyActive() {
      return findActiveEvidenceLifecyclePolicy.get() !== undefined;
    },
    async findTaskIdByReportOperation(operationId) {
      return findByOperationId.get(
        operationId,
        operationId,
        operationId,
      )?.task_id;
    },
    async persistCompletionCallbackRequest(snapshot) {
      return persistRequest.immediate(snapshot);
    },
    async requestSessionFailureNotification(input) {
      return requestFailureNotification.immediate(input);
    },
  };
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      revision INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      from_identity TEXT NOT NULL,
      notification_subdomain TEXT NOT NULL,
      open_tracking INTEGER NOT NULL CHECK (open_tracking = 0),
      click_tracking INTEGER NOT NULL CHECK (click_tracking = 0),
      configured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_lifecycle_policy (
      policy_id TEXT PRIMARY KEY CHECK (policy_id = 'ordinary-evidence-90-days'),
      activated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_completion_reports (
      report_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES durable_tasks(id),
      telephone_session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      requested_event_id TEXT NOT NULL UNIQUE,
      requested_at TEXT NOT NULL,
      telephone_json TEXT NOT NULL,
      preference_revision INTEGER NOT NULL REFERENCES notification_preferences(revision),
      notification_operation_id TEXT UNIQUE,
      resumption_operation_id TEXT UNIQUE,
      state TEXT NOT NULL,
      lease_expires_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS task_completion_reports_task
      ON task_completion_reports (task_id);

    CREATE TABLE IF NOT EXISTS task_completion_deliveries (
      delivery_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      result_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS completion_callback_placement_claims (
      effect_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES durable_tasks(id)
    );
  `);
  ensureColumn(
    database,
    "task_completion_reports",
    "resumption_operation_id",
    "TEXT",
  );
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS task_completion_reports_resumption_operation
      ON task_completion_reports (resumption_operation_id)
      WHERE resumption_operation_id IS NOT NULL;
  `);
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

function mapRequestRow(
  row: CompletionRequestRow,
): CompletionCallbackRequestSnapshot {
  return {
    operationId: row.operation_id,
    preferenceRevision: row.preference_revision,
    reportId: row.report_id,
    requestId: row.request_id,
    requestedAt: row.requested_at,
    requestedEventId: row.requested_event_id,
    taskId: row.task_id,
    telephone: registeredTelephoneSchema.parse(JSON.parse(row.telephone_json)),
    telephoneSessionId: row.telephone_session_id,
  };
}

function mapPreference(row: PreferenceRow): NotificationPreference {
  return notificationPreferenceSchema.parse({
    clickTracking: row.click_tracking === 1,
    configuredAt: row.configured_at,
    email: row.email,
    from: row.from_identity,
    notificationSubdomain: row.notification_subdomain,
    openTracking: row.open_tracking === 1,
    revision: row.revision,
  });
}

function requireSenderSubdomain(from: string, subdomain: string): void {
  const match = /(?:^|<)([^<>\s]+@[^<>\s]+)>?$/u.exec(from);
  const address = match?.[1];
  if (address === undefined || address.split("@").at(1) !== subdomain) {
    throw new Error("Silent Notification sender must use the verified subdomain");
  }
}
