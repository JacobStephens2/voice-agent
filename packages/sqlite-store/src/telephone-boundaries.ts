import Database from "better-sqlite3";

import {
  telephoneSpendingWarningThresholds,
  type TelephoneSpendingWarningThreshold,
} from "@voice-agent/contracts";
import type {
  TelephoneBoundaryDecision,
  TelephoneBoundaryMetrics,
  TelephoneBoundaryStore,
  TelephoneUsageReservationResult,
  TelephoneUsageResult,
  TelephoneUsageSource,
} from "@voice-agent/durable-store";

const usageSources = ["api", "telephony", "realtime-media"] as const;

interface CountRow {
  readonly value: number;
}

interface OwnerRow {
  readonly owner_id: string;
}

interface SessionRow {
  readonly activated_at: string | null;
  readonly last_activity_at: string | null;
  readonly session_id: string;
  readonly safe_terminal_only: 0 | 1;
  readonly raw_audio_debug_confirmed: 0 | 1;
  readonly raw_audio_debug_expires_at: string | null;
  readonly state: "active" | "ended" | "warm";
}

export function createSqliteTelephoneBoundaryStore(
  databasePath: string,
): TelephoneBoundaryStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const incrementDecision = database.prepare(`
    INSERT INTO telephone_boundary_counters (name, value)
    VALUES (?, 1)
    ON CONFLICT(name) DO UPDATE SET value = value + 1
  `);
  const findSession = database.prepare<
    [sessionId: string],
    SessionRow
  >(`
    SELECT session_id, state, activated_at, last_activity_at,
      safe_terminal_only, raw_audio_debug_expires_at,
      raw_audio_debug_confirmed
    FROM telephone_boundary_sessions
    WHERE session_id = ?
  `);
  const countSessions = database.prepare<
    [state: "active" | "warm"],
    CountRow
  >(`SELECT COUNT(*) AS value FROM telephone_boundary_sessions WHERE state = ?`);
  const insertWarmSession = database.prepare(`
    INSERT INTO telephone_boundary_sessions (
      session_id, state, reserved_at, activated_at, last_activity_at
    ) VALUES (?, 'warm', ?, NULL, NULL)
  `);
  const resetEndedSessionToWarm = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET state = 'warm', reserved_at = ?, activated_at = NULL,
      last_activity_at = NULL, ended_at = NULL, end_reason = NULL,
      duration_ms = NULL, safe_terminal_only = 0
    WHERE session_id = ? AND state = 'ended'
  `);
  const releaseWarmSession = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET state = 'ended', ended_at = ?, end_reason = 'disconnected',
      duration_ms = 0, raw_audio_debug_confirmed = 0
    WHERE session_id = ? AND state = 'warm'
  `);
  const expireWarmSessions = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET state = 'ended', ended_at = ?, end_reason = 'disconnected',
      duration_ms = 0, raw_audio_debug_confirmed = 0
    WHERE state = 'warm' AND reserved_at <= ?
  `);
  const findActiveSessionIds = database.prepare<
    [],
    { readonly session_id: string }
  >(`
    SELECT session_id
    FROM telephone_boundary_sessions
    WHERE state = 'active'
    ORDER BY activated_at, session_id
  `);
  const activateSession = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET state = 'active', activated_at = ?, last_activity_at = ?
    WHERE session_id = ? AND state = 'warm'
  `);
  const rejectWarmSession = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET state = 'ended', ended_at = ?, end_reason = 'spending-ceiling',
      duration_ms = 0
    WHERE session_id = ? AND state = 'warm'
  `);
  const touchSession = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET last_activity_at = ?
    WHERE session_id = ? AND state = 'active'
  `);
  const finishSession = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET state = 'ended', ended_at = ?, end_reason = ?, duration_ms = ?,
      raw_audio_debug_confirmed = 0
    WHERE session_id = ? AND state = 'active'
  `);
  const deleteSessionTasks = database.prepare(`
    DELETE FROM telephone_boundary_state_tasks WHERE session_id = ?
  `);
  const incrementDuration = database.prepare(`
    INSERT INTO telephone_boundary_counters (name, value)
    VALUES ('total-duration-ms', ?)
    ON CONFLICT(name) DO UPDATE SET value = value + excluded.value
  `);
  const findUsage = database.prepare<
    [usageId: string],
    { readonly recorded_at: string }
  >(`SELECT recorded_at FROM telephone_metered_usage WHERE usage_id = ?`);
  const insertUsage = database.prepare(`
    INSERT INTO telephone_metered_usage (
      usage_id, session_id, source, amount_microusd, recorded_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const sumUsage = database.prepare<
    [monthPrefix: string],
    CountRow
  >(`
    SELECT COALESCE(SUM(amount_microusd), 0) AS value
    FROM telephone_metered_usage
    WHERE substr(recorded_at, 1, 7) = ?
  `);
  const sumUsageBySource = database.prepare<
    [monthPrefix: string, source: string],
    CountRow
  >(`
    SELECT COALESCE(SUM(amount_microusd), 0) AS value
    FROM telephone_metered_usage
    WHERE substr(recorded_at, 1, 7) = ? AND source = ?
  `);
  const readSpendingPolicy = database.prepare<
    [],
    { readonly ceiling_microusd: number; readonly revision: number }
  >(`
    SELECT revision, ceiling_microusd
    FROM telephone_spending_policy
    ORDER BY revision DESC
    LIMIT 1
  `);
  const insertSpendingPolicy = database.prepare(`
    INSERT INTO telephone_spending_policy (
      revision, ceiling_microusd, changed_at
    ) VALUES (?, ?, ?)
  `);
  const markActiveSessionsSafeTerminal = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET safe_terminal_only = 1
    WHERE state = 'active'
  `);
  const grantRawAudioDebug = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET raw_audio_debug_expires_at = ?, raw_audio_debug_confirmed = 0,
      raw_audio_artifact_path = NULL
    WHERE session_id = ? AND state = 'active'
      AND (
        raw_audio_debug_expires_at IS NULL
        OR raw_audio_debug_expires_at <= ?
      )
      AND raw_audio_artifact_path IS NULL
  `);
  const confirmRawAudioDebug = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET raw_audio_debug_confirmed = 1
    WHERE session_id = ? AND state = 'active'
      AND raw_audio_debug_expires_at > ?
      AND raw_audio_debug_confirmed = 0
  `);
  const claimRawAudioArtifact = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET raw_audio_artifact_path = ?
    WHERE session_id = ? AND state = 'active'
      AND raw_audio_debug_expires_at > ?
      AND raw_audio_debug_confirmed = 1
  `);
  const findExpiredRawAudioDebug = database.prepare<
    [now: string],
    {
      readonly raw_audio_artifact_path: string | null;
      readonly session_id: string;
    }
  >(`
    SELECT session_id, raw_audio_artifact_path
    FROM telephone_boundary_sessions
    WHERE raw_audio_debug_expires_at IS NOT NULL
      AND raw_audio_debug_expires_at <= ?
  `);
  const clearRawAudioDebug = database.prepare(`
    UPDATE telephone_boundary_sessions
    SET raw_audio_debug_expires_at = NULL, raw_audio_debug_confirmed = 0,
      raw_audio_artifact_path = NULL
    WHERE session_id = ?
  `);
  const countActiveRawAudioDebug = database.prepare<
    [now: string],
    CountRow
  >(`
    SELECT COUNT(*) AS value
    FROM telephone_boundary_sessions
    WHERE raw_audio_debug_expires_at > ?
      AND raw_audio_debug_confirmed = 1
  `);
  const findTask = database.prepare<
    [taskId: string],
    { readonly state: "active" | "queued" }
  >(`SELECT state FROM telephone_boundary_state_tasks WHERE task_id = ?`);
  const countTasks = database.prepare<
    [sessionId: string, state: "active" | "queued"],
    CountRow
  >(`
    SELECT COUNT(*) AS value
    FROM telephone_boundary_state_tasks
    WHERE session_id = ? AND state = ?
  `);
  const insertTask = database.prepare(`
    INSERT INTO telephone_boundary_state_tasks (
      task_id, session_id, state, requested_at
    ) VALUES (?, ?, ?, ?)
  `);
  const deleteTask = database.prepare(`
    DELETE FROM telephone_boundary_state_tasks
    WHERE task_id = ? AND session_id = ?
  `);
  const findNextTask = database.prepare<
    [sessionId: string],
    OwnerRow
  >(`
    SELECT task_id AS owner_id
    FROM telephone_boundary_state_tasks
    WHERE session_id = ? AND state = 'queued'
    ORDER BY requested_at, task_id
    LIMIT 1
  `);
  const activateTask = database.prepare(`
    UPDATE telephone_boundary_state_tasks
    SET state = 'active'
    WHERE task_id = ?
  `);
  const findSubagent = database.prepare<
    [delegationId: string],
    { readonly state: "queued" | "running" }
  >(`SELECT state FROM telephone_boundary_subagents WHERE delegation_id = ?`);
  const countSubagents = database.prepare<
    [state: "queued" | "running"],
    CountRow
  >(`SELECT COUNT(*) AS value FROM telephone_boundary_subagents WHERE state = ?`);
  const insertSubagent = database.prepare(`
    INSERT INTO telephone_boundary_subagents (
      delegation_id, state, requested_at
    ) VALUES (?, ?, ?)
  `);
  const deleteSubagent = database.prepare(`
    DELETE FROM telephone_boundary_subagents WHERE delegation_id = ?
  `);
  const findNextSubagent = database.prepare<[], OwnerRow>(`
    SELECT delegation_id AS owner_id
    FROM telephone_boundary_subagents
    WHERE state = 'queued'
    ORDER BY requested_at, delegation_id
    LIMIT 1
  `);
  const activateSubagent = database.prepare(`
    UPDATE telephone_boundary_subagents
    SET state = 'running'
    WHERE delegation_id = ?
  `);
  const readCounter = database.prepare<[name: string], CountRow>(`
    SELECT value FROM telephone_boundary_counters WHERE name = ?
  `);

  const reserveWarm = database.transaction(
    (input: { readonly reservedAt: string; readonly sessionId: string }) => {
      const existing = findSession.get(input.sessionId);
      if (existing?.state === "warm") {
        return accepted("warm-session");
      }
      if (existing?.state === "active") {
        incrementDecision.run("rejected");
        return rejected("warm-session", "warm-session-limit");
      }
      const policy = requireSpendingPolicy(readSpendingPolicy.get());
      const month = input.reservedAt.slice(0, 7);
      if ((sumUsage.get(month)?.value ?? 0) >= policy.ceiling_microusd) {
        incrementDecision.run("rejected");
        return rejected("monthly-spend", "spending-ceiling");
      }
      if ((countSessions.get("warm")?.value ?? 0) >= 1) {
        incrementDecision.run("rejected");
        return rejected("warm-session", "warm-session-limit");
      }
      if (existing?.state === "ended") {
        resetEndedSessionToWarm.run(input.reservedAt, input.sessionId);
        incrementDecision.run("accepted");
        return accepted("warm-session");
      }
      insertWarmSession.run(input.sessionId, input.reservedAt);
      incrementDecision.run("accepted");
      return accepted("warm-session");
    },
  );
  const activate = database.transaction(
    (input: { readonly activatedAt: string; readonly sessionId: string }) => {
      const existing = findSession.get(input.sessionId);
      if (existing?.state === "active") return accepted("active-session");
      const policy = requireSpendingPolicy(readSpendingPolicy.get());
      const month = input.activatedAt.slice(0, 7);
      if ((sumUsage.get(month)?.value ?? 0) >= policy.ceiling_microusd) {
        rejectWarmSession.run(input.activatedAt, input.sessionId);
        incrementDecision.run("rejected");
        return rejected("monthly-spend", "spending-ceiling");
      }
      if (
        existing?.state !== "warm" ||
        (countSessions.get("active")?.value ?? 0) >= 1
      ) {
        incrementDecision.run("rejected");
        return rejected("active-session", "active-session-limit");
      }
      activateSession.run(input.activatedAt, input.activatedAt, input.sessionId);
      incrementDecision.run("accepted");
      return accepted("active-session");
    },
  );
  const claimTask = database.transaction(
    (input: {
      readonly requestedAt: string;
      readonly sessionId: string;
      readonly taskId: string;
    }) => {
      const existing = findTask.get(input.taskId);
      if (existing?.state === "active") return accepted("state-changing-task");
      if (existing?.state === "queued") {
        return queued(
          "state-changing-task",
          countTasks.get(input.sessionId, "queued")?.value ?? 1,
        );
      }
      const active = countTasks.get(input.sessionId, "active")?.value ?? 0;
      if (active === 0) {
        insertTask.run(
          input.taskId,
          input.sessionId,
          "active",
          input.requestedAt,
        );
        incrementDecision.run("accepted");
        return accepted("state-changing-task");
      }
      const position =
        (countTasks.get(input.sessionId, "queued")?.value ?? 0) + 1;
      insertTask.run(input.taskId, input.sessionId, "queued", input.requestedAt);
      incrementDecision.run("queued");
      return queued("state-changing-task", position);
    },
  );
  const claimGlobalSubagent = database.transaction(
    (input: { readonly delegationId: string; readonly requestedAt: string }) => {
      const existing = findSubagent.get(input.delegationId);
      if (existing?.state === "running") return accepted("subagent");
      if (existing?.state === "queued") {
        return queued(
          "subagent",
          countSubagents.get("queued")?.value ?? 1,
        );
      }
      if ((countSubagents.get("running")?.value ?? 0) === 0) {
        insertSubagent.run(input.delegationId, "running", input.requestedAt);
        incrementDecision.run("accepted");
        return accepted("subagent");
      }
      const position = (countSubagents.get("queued")?.value ?? 0) + 1;
      insertSubagent.run(input.delegationId, "queued", input.requestedAt);
      incrementDecision.run("queued");
      return queued("subagent", position);
    },
  );
  const releaseTask = database.transaction(
    (input: { readonly sessionId: string; readonly taskId: string }) => {
      const released = findTask.get(input.taskId);
      deleteTask.run(input.taskId, input.sessionId);
      if (released?.state !== "active") return {};
      const next = findNextTask.get(input.sessionId);
      if (next === undefined) return {};
      activateTask.run(next.owner_id);
      return { promotedOwnerId: next.owner_id };
    },
  );
  const releaseGlobalSubagent = database.transaction((delegationId: string) => {
    const released = findSubagent.get(delegationId);
    deleteSubagent.run(delegationId);
    if (released?.state !== "running") return {};
    const next = findNextSubagent.get();
    if (next === undefined) return {};
    activateSubagent.run(next.owner_id);
    return { promotedOwnerId: next.owner_id };
  });
  const endActiveSession = database.transaction(
    (input: {
      readonly durationMs: number;
      readonly endedAt: string;
      readonly reason: string;
      readonly sessionId: string;
    }) => {
      const result = finishSession.run(
        input.endedAt,
        input.reason,
        input.durationMs,
        input.sessionId,
      );
      if (result.changes !== 1) return { ended: false };
      deleteSessionTasks.run(input.sessionId);
      incrementDecision.run(`session-ended:${input.reason}`);
      incrementDuration.run(input.durationMs);
      return { ended: true };
    },
  );
  function persistUsageEntries(input: {
    readonly entries: readonly {
      readonly amountMicrousd: number;
      readonly source: TelephoneUsageSource;
      readonly usageId: string;
    }[];
    readonly recordedAt: string;
    readonly sessionId?: string;
  }): TelephoneUsageReservationResult {
    const month = input.recordedAt.slice(0, 7);
    const before = sumUsage.get(month)?.value ?? 0;
    const pending = input.entries.filter(
      (entry) => findUsage.get(entry.usageId) === undefined,
    );
    const proposedTotal =
      before + pending.reduce((total, entry) => total + entry.amountMicrousd, 0);
    const ceiling = requireSpendingPolicy(
      readSpendingPolicy.get(),
    ).ceiling_microusd;
    if (proposedTotal > ceiling) {
      markActiveSessionsSafeTerminal.run();
      return {
        disposition: "safe-terminal-only",
        month,
        reservedSources: [],
        totalMicrousd: before,
        warnings: [],
      };
    }
    for (const entry of pending) {
      insertUsage.run(
        entry.usageId,
        input.sessionId ?? null,
        entry.source,
        entry.amountMicrousd,
        input.recordedAt,
      );
    }
    const totalMicrousd = sumUsage.get(month)?.value ?? 0;
    if (totalMicrousd >= ceiling) markActiveSessionsSafeTerminal.run();
    return {
      disposition:
        totalMicrousd >= ceiling ? "safe-terminal-only" : "continue",
      month,
      reservedSources: pending.map((entry) => entry.source),
      totalMicrousd,
      warnings: crossedSpendingWarnings(before, totalMicrousd),
    };
  }
  const persistUsage = database.transaction(
    (input: {
      readonly amountMicrousd: number;
      readonly recordedAt: string;
      readonly sessionId?: string;
      readonly source: TelephoneUsageSource;
      readonly usageId: string;
    }): TelephoneUsageResult => {
      const { reservedSources: _reservedSources, ...result } =
        persistUsageEntries({
          entries: [input],
          recordedAt: input.recordedAt,
          ...(input.sessionId === undefined
            ? {}
            : { sessionId: input.sessionId }),
        });
      return result;
    },
  );
  const persistUsageSlice = database.transaction(
    (input: {
      readonly amountsMicrousd: Readonly<Record<TelephoneUsageSource, number>>;
      readonly recordedAt: string;
      readonly sessionId?: string;
      readonly usageScopeId: string;
    }): TelephoneUsageReservationResult =>
      persistUsageEntries({
        entries: usageSources.map((source) => ({
          amountMicrousd: input.amountsMicrousd[source],
          source,
          usageId: `${input.usageScopeId}:${source}`,
        })),
        recordedAt: input.recordedAt,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      }),
  );
  const persistSpendingPolicy = database.transaction(
    (input: { readonly ceilingMicrousd: number; readonly changedAt: string }) => {
      const current = requireSpendingPolicy(readSpendingPolicy.get());
      const revision = current.revision + 1;
      insertSpendingPolicy.run(revision, input.ceilingMicrousd, input.changedAt);
      return { ceilingMicrousd: input.ceilingMicrousd, revision };
    },
  );

  return {
    activateSession: async (input) => activate.immediate(input),
    changeSpendingCeiling: async (input) =>
      persistSpendingPolicy.immediate(input),
    async claimRawAudioArtifact(input) {
      return (
        claimRawAudioArtifact.run(
          input.artifactPath,
          input.sessionId,
          input.claimedAt,
        ).changes === 1
      );
    },
    claimStateChangingTask: async (input) => claimTask.immediate(input),
    claimSubagent: async (input) => claimGlobalSubagent.immediate(input),
    async confirmRawAudioDebug(input) {
      return (
        confirmRawAudioDebug.run(input.sessionId, input.confirmedAt).changes === 1
      );
    },
    async close() {
      database.close();
    },
    endSession: async (input) => endActiveSession.immediate(input),
    async expireWarmSessions(input) {
      return expireWarmSessions.run(input.endedAt, input.cutoff).changes;
    },
    async findActiveSessionIds() {
      return findActiveSessionIds.all().map((row) => row.session_id);
    },
    async findSession(sessionId) {
      const row = findSession.get(sessionId);
      if (row === undefined) return undefined;
      return {
        ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
        ...(row.last_activity_at === null
          ? {}
          : { lastActivityAt: row.last_activity_at }),
        sessionId: row.session_id,
        mode: row.safe_terminal_only === 1 ? "safe-terminal-only" : "ordinary",
        ...(row.raw_audio_debug_confirmed === 1
          ? { rawAudioDebugConfirmed: true }
          : {}),
        ...(row.raw_audio_debug_expires_at === null
          ? {}
          : { rawAudioDebugExpiresAt: row.raw_audio_debug_expires_at }),
        state: row.state,
      };
    },
    async findExpiredRawAudioDebug(now) {
      return findExpiredRawAudioDebug.all(now).map((row) => ({
        ...(row.raw_audio_artifact_path === null
          ? {}
          : { artifactPath: row.raw_audio_artifact_path }),
        sessionId: row.session_id,
      }));
    },
    async grantRawAudioDebug(input) {
      return (
        grantRawAudioDebug.run(
          input.expiresAt,
          input.sessionId,
          input.authorizedAt,
        ).changes === 1
      );
    },
    async readMetrics(month): Promise<TelephoneBoundaryMetrics> {
      const currentMonth = month.slice(0, 7);
      const spending = requireSpendingPolicy(readSpendingPolicy.get());
      return {
        audioDebug: {
          activeGrants: countActiveRawAudioDebug.get(month)?.value ?? 0,
          cleanup: {
            deleted: readCounter.get("audio-cleanup:deleted")?.value ?? 0,
            failed: readCounter.get("audio-cleanup:failed")?.value ?? 0,
            missing: readCounter.get("audio-cleanup:missing")?.value ?? 0,
          },
          grants: {
            accepted: readCounter.get("audio-grant:accepted")?.value ?? 0,
            rejected: readCounter.get("audio-grant:rejected")?.value ?? 0,
          },
        },
        limitDecisions: {
          accepted: readCounter.get("accepted")?.value ?? 0,
          queued: readCounter.get("queued")?.value ?? 0,
          rejected: readCounter.get("rejected")?.value ?? 0,
        },
        resources: {
          activeSessions: countSessions.get("active")?.value ?? 0,
          queuedStateChangingTasks:
            database
              .prepare<[], CountRow>(`
                SELECT COUNT(*) AS value
                FROM telephone_boundary_state_tasks
                WHERE state = 'queued'
              `)
              .get()?.value ?? 0,
          queuedSubagents: countSubagents.get("queued")?.value ?? 0,
          runningSubagents: countSubagents.get("running")?.value ?? 0,
          warmSessions: countSessions.get("warm")?.value ?? 0,
        },
        providerFailures: {
          coordinator: {
            timeout:
              readCounter.get("provider-failure:coordinator:timeout")?.value ?? 0,
            unavailable:
              readCounter.get("provider-failure:coordinator:unavailable")?.value ?? 0,
          },
          stt: {
            timeout: readCounter.get("provider-failure:stt:timeout")?.value ?? 0,
            unavailable:
              readCounter.get("provider-failure:stt:unavailable")?.value ?? 0,
          },
          tts: {
            timeout: readCounter.get("provider-failure:tts:timeout")?.value ?? 0,
            unavailable:
              readCounter.get("provider-failure:tts:unavailable")?.value ?? 0,
          },
        },
        sessionEndings: {
          maximumDuration:
            readCounter.get("session-ended:maximum-duration")?.value ?? 0,
          other:
            (readCounter.get("session-ended:completed")?.value ?? 0) +
            (readCounter.get("session-ended:disconnected")?.value ?? 0) +
            (readCounter.get("session-ended:spending-ceiling")?.value ?? 0),
          prolongedSilence:
            readCounter.get("session-ended:prolonged-silence")?.value ?? 0,
          providerFailure:
            readCounter.get("session-ended:provider-failure")?.value ?? 0,
        },
        spending: {
          bySourceMicrousd: {
            api: sumUsageBySource.get(currentMonth, "api")?.value ?? 0,
            "realtime-media":
              sumUsageBySource.get(currentMonth, "realtime-media")?.value ?? 0,
            telephony:
              sumUsageBySource.get(currentMonth, "telephony")?.value ?? 0,
          },
          ceilingMicrousd: spending.ceiling_microusd,
          month: currentMonth,
          totalMicrousd: sumUsage.get(currentMonth)?.value ?? 0,
        },
        totalDurationMs: readCounter.get("total-duration-ms")?.value ?? 0,
      };
    },
    recordUsage: async (input) => persistUsage.immediate(input),
    reserveUsageSlice: async (input) => persistUsageSlice.immediate(input),
    async recordProviderFailure(input) {
      incrementDecision.run(
        `provider-failure:${input.stage}:${input.failureClass}`,
      );
    },
    async recordRawAudioCleanup(input) {
      incrementDecision.run(`audio-cleanup:${input.outcome}`);
      if (input.outcome !== "failed") clearRawAudioDebug.run(input.sessionId);
    },
    async recordRawAudioDebugDecision(decision) {
      incrementDecision.run(`audio-grant:${decision}`);
    },
    async releaseWarmSession(sessionId) {
      releaseWarmSession.run(new Date().toISOString(), sessionId);
    },
    async revokeRawAudioDebug(sessionId) {
      clearRawAudioDebug.run(sessionId);
    },
    releaseStateChangingTask: async (input) => releaseTask.immediate(input),
    releaseSubagent: async (delegationId) =>
      releaseGlobalSubagent.immediate(delegationId),
    reserveWarmSession: async (input) => reserveWarm.immediate(input),
    async touchSession(input) {
      touchSession.run(input.occurredAt, input.sessionId);
    },
  };
}

function accepted(
  resource:
    | "active-session"
    | "state-changing-task"
    | "subagent"
    | "warm-session",
): TelephoneBoundaryDecision {
  return { decision: "accepted", resource };
}

function queued(
  resource: "state-changing-task" | "subagent",
  position: number,
): TelephoneBoundaryDecision {
  return { decision: "queued", position, resource };
}

function rejected(
  resource: "active-session" | "monthly-spend" | "warm-session",
  reason:
    | "active-session-limit"
    | "spending-ceiling"
    | "warm-session-limit",
): TelephoneBoundaryDecision {
  return { decision: "rejected", reason, resource };
}

function crossedSpendingWarnings(
  before: number,
  after: number,
): readonly TelephoneSpendingWarningThreshold[] {
  return telephoneSpendingWarningThresholds.filter(
    (threshold) => before < threshold && after >= threshold,
  );
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS telephone_boundary_sessions (
      session_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('warm', 'active', 'ended')),
      reserved_at TEXT NOT NULL,
      activated_at TEXT,
      last_activity_at TEXT,
      ended_at TEXT,
      end_reason TEXT,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)
      ,safe_terminal_only INTEGER NOT NULL DEFAULT 0
        CHECK (safe_terminal_only IN (0, 1))
      ,raw_audio_debug_expires_at TEXT
      ,raw_audio_debug_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK (raw_audio_debug_confirmed IN (0, 1))
      ,raw_audio_artifact_path TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS telephone_boundary_one_warm_session
      ON telephone_boundary_sessions (state) WHERE state = 'warm';
    CREATE UNIQUE INDEX IF NOT EXISTS telephone_boundary_one_active_session
      ON telephone_boundary_sessions (state) WHERE state = 'active';

    CREATE TABLE IF NOT EXISTS telephone_boundary_state_tasks (
      task_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'queued')),
      requested_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES telephone_boundary_sessions(session_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS telephone_boundary_one_active_task
      ON telephone_boundary_state_tasks (session_id) WHERE state = 'active';

    CREATE TABLE IF NOT EXISTS telephone_boundary_subagents (
      delegation_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('running', 'queued')),
      requested_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS telephone_boundary_one_running_subagent
      ON telephone_boundary_subagents (state) WHERE state = 'running';

    CREATE TABLE IF NOT EXISTS telephone_boundary_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK (value >= 0)
    );

    CREATE TABLE IF NOT EXISTS telephone_metered_usage (
      usage_id TEXT PRIMARY KEY,
      session_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('api', 'telephony', 'realtime-media')),
      amount_microusd INTEGER NOT NULL CHECK (amount_microusd > 0),
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS telephone_metered_usage_month
      ON telephone_metered_usage (recorded_at, source);

    CREATE TABLE IF NOT EXISTS telephone_spending_policy (
      revision INTEGER PRIMARY KEY,
      ceiling_microusd INTEGER NOT NULL CHECK (ceiling_microusd > 0),
      changed_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO telephone_spending_policy (
      revision, ceiling_microusd, changed_at
    ) VALUES (1, 50000000, '1970-01-01T00:00:00.000Z');
  `);
}

function requireSpendingPolicy(
  policy:
    | { readonly ceiling_microusd: number; readonly revision: number }
    | undefined,
) {
  if (policy === undefined) throw new Error("Spending policy is unavailable");
  return policy;
}
