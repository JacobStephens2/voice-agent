import type {
  TelephoneUsageReservationResult,
  TelephoneUsageResult,
  TelephoneUsageSource,
} from "@voice-agent/contracts";

export type {
  TelephoneUsageReservationResult,
  TelephoneUsageResult,
  TelephoneUsageSource,
} from "@voice-agent/contracts";

export type TelephoneBoundaryResource =
  | "active-session"
  | "monthly-spend"
  | "state-changing-task"
  | "subagent"
  | "warm-session";

export type TelephoneBoundaryDecision =
  | {
      readonly decision: "accepted";
      readonly resource: TelephoneBoundaryResource;
    }
  | {
      readonly decision: "queued";
      readonly position: number;
      readonly resource: "state-changing-task" | "subagent";
    }
  | {
      readonly decision: "rejected";
      readonly reason:
        | "active-session-limit"
        | "duplicate-delegation"
        | "spending-ceiling"
        | "warm-session-limit";
      readonly resource:
        | "active-session"
        | "monthly-spend"
        | "subagent"
        | "warm-session";
    };

export type TelephoneProviderFailureClass = "timeout" | "unavailable";
export type TelephoneProviderStage = "coordinator" | "setup" | "stt" | "tts";

export interface TelephoneBoundaryMetrics {
  readonly audioDebug: {
    readonly activeGrants: number;
    readonly cleanup: {
      readonly deleted: number;
      readonly failed: number;
      readonly missing: number;
    };
    readonly grants: { readonly accepted: number; readonly rejected: number };
  };
  readonly limitDecisions: {
    readonly accepted: number;
    readonly queued: number;
    readonly rejected: number;
  };
  readonly resources: {
    readonly activeSessions: number;
    readonly queuedStateChangingTasks: number;
    readonly queuedSubagents: number;
    readonly runningSubagents: number;
    readonly warmSessions: number;
  };
  readonly providerFailures: Record<
    TelephoneProviderStage,
    Record<TelephoneProviderFailureClass, number>
  >;
  readonly sessionEndings: {
    readonly maximumDuration: number;
    readonly other: number;
    readonly prolongedSilence: number;
    readonly providerFailure: number;
  };
  readonly spending: {
    readonly bySourceMicrousd: Record<TelephoneUsageSource, number>;
    readonly ceilingMicrousd: number;
    readonly month: string;
    readonly totalMicrousd: number;
  };
  readonly totalDurationMs: number;
}

export interface TelephoneBoundarySession {
  readonly activatedAt?: string;
  readonly lastActivityAt?: string;
  readonly sessionId: string;
  readonly mode: "ordinary" | "safe-terminal-only";
  readonly rawAudioDebugConfirmed?: boolean;
  readonly rawAudioDebugExpiresAt?: string;
  readonly state: "active" | "ended" | "warm";
}

export interface TelephoneBoundaryStore {
  activateSession(input: {
    readonly activatedAt: string;
    readonly sessionId: string;
  }): Promise<TelephoneBoundaryDecision>;
  changeSpendingCeiling(input: {
    readonly ceilingMicrousd: number;
    readonly changedAt: string;
  }): Promise<{ readonly ceilingMicrousd: number; readonly revision: number }>;
  claimRawAudioArtifact(input: {
    readonly artifactPath: string;
    readonly claimedAt: string;
    readonly sessionId: string;
  }): Promise<boolean>;
  confirmRawAudioDebug(input: {
    readonly confirmedAt: string;
    readonly sessionId: string;
  }): Promise<boolean>;
  claimStateChangingTask(input: {
    readonly requestedAt: string;
    readonly sessionId: string;
    readonly taskId: string;
  }): Promise<TelephoneBoundaryDecision>;
  claimSubagent(input: {
    readonly delegationId: string;
    readonly executionId: string;
    readonly leaseExpiresAt: string;
    readonly requestedAt: string;
  }): Promise<TelephoneBoundaryDecision>;
  renewSubagentLease(input: {
    readonly delegationId: string;
    readonly executionId: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean>;
  close(): Promise<void>;
  endSession(input: {
    readonly durationMs: number;
    readonly endedAt: string;
    readonly reason:
      | "completed"
      | "disconnected"
      | "maximum-duration"
      | "prolonged-silence"
      | "provider-failure"
      | "spending-ceiling";
    readonly sessionId: string;
  }): Promise<{ readonly ended: boolean }>;
  findSession(sessionId: string): Promise<TelephoneBoundarySession | undefined>;
  findActiveSessionIds(): Promise<readonly string[]>;
  findExpiredRawAudioDebug(now: string): Promise<
    readonly {
      readonly artifactPath?: string;
      readonly sessionId: string;
    }[]
  >;
  grantRawAudioDebug(input: {
    readonly authorizedAt: string;
    readonly expiresAt: string;
    readonly sessionId: string;
  }): Promise<boolean>;
  expireWarmSessions(input: {
    readonly cutoff: string;
    readonly endedAt: string;
  }): Promise<number>;
  readMetrics(now: string): Promise<TelephoneBoundaryMetrics>;
  recordProviderFailure(input: {
    readonly failureClass: TelephoneProviderFailureClass;
    readonly stage: TelephoneProviderStage;
  }): Promise<void>;
  recordRawAudioCleanup(input: {
    readonly outcome: "deleted" | "failed" | "missing";
    readonly sessionId: string;
  }): Promise<void>;
  recordRawAudioDebugDecision(decision: "accepted" | "rejected"): Promise<void>;
  recordUsage(input: {
    readonly amountMicrousd: number;
    readonly recordedAt: string;
    readonly sessionId?: string;
    readonly source: TelephoneUsageSource;
    readonly usageId: string;
  }): Promise<TelephoneUsageResult>;
  reserveUsageSlice(input: {
    readonly amountsMicrousd: Readonly<Record<TelephoneUsageSource, number>>;
    readonly recordedAt: string;
    readonly sessionId?: string;
    readonly usageScopeId: string;
  }): Promise<TelephoneUsageReservationResult>;
  revokeRawAudioDebug(sessionId: string): Promise<void>;
  releaseWarmSession(sessionId: string): Promise<void>;
  releaseStateChangingTask(input: {
    readonly sessionId: string;
    readonly taskId: string;
  }): Promise<{ readonly promotedOwnerId?: string }>;
  releaseSubagent(input: {
    readonly delegationId: string;
    readonly executionId: string;
  }): Promise<void>;
  reserveWarmSession(input: {
    readonly reservedAt: string;
    readonly sessionId: string;
  }): Promise<TelephoneBoundaryDecision>;
  touchSession(input: {
    readonly occurredAt: string;
    readonly sessionId: string;
  }): Promise<void>;
}
