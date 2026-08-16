export interface FixtureGitHubEvent {
  readonly action: "closed" | "opened" | "synchronize";
  readonly beforeCommit: string;
  readonly branch: string;
  readonly commit: string;
  readonly event: "pull_request" | "push";
  readonly merged: boolean;
  readonly mergedBy: {
    readonly login: string;
    readonly type: "Bot" | "Organization" | "User";
  } | null;
  readonly repository: string;
}

export interface FixtureCodebaseRegistration {
  readonly applicationId: "fixture-production";
  readonly liveCheckoutPath: string;
  readonly productionBranch: "main";
  readonly registeredAt: string;
  readonly repository: "JacobStephens2/fixture-application";
  readonly sourceCheckoutRoot: string;
}

export interface FixtureDeploymentContract {
  readonly activatedAt: string;
  readonly activatedBy: "fresh-passkey-action";
  readonly applicationId: "fixture-production";
  readonly buildCommand: string;
  readonly health: {
    readonly expectedStatus: number;
    readonly path: string;
  };
  readonly preflightCommand: string;
  readonly releaseRoot: string;
  readonly revision: number;
  readonly source: "voice-agent-policy";
}

export type PromotionAttemptStatus =
  | "queued"
  | "running"
  | "rolled-back"
  | "succeeded";

export interface PromotionEvidenceEventProjection {
  readonly details: Readonly<Record<string, boolean | number | string | null>>;
  readonly id: string;
  readonly kind:
    | "circuit.changed"
    | "delivery.denied"
    | "delivery.duplicate"
    | "merge.accepted"
    | "promotion.queued"
    | "reconciliation.discovered"
    | "release.built"
    | "release.preflighted"
    | "release.rolled-back"
    | "release.switched"
    | "release.verified";
  readonly occurredAt: string;
  readonly sequence: number;
  readonly summary: string;
}

export interface PromotionEvidenceRecordProjection {
  readonly evidence: readonly PromotionEvidenceEventProjection[];
  readonly promotion: {
    readonly attempt?: {
      readonly id: string;
      readonly mergeCommit: string;
      readonly queueSequence: number;
      readonly status: PromotionAttemptStatus;
    };
    readonly circuit: {
      readonly consecutiveFailures: number;
      readonly state: "closed" | "half-open" | "open";
    };
    readonly contract?: {
      readonly activatedAt: string;
      readonly revision: number;
      readonly source: "voice-agent-policy";
    };
    readonly denialReason?: string;
    readonly merge: {
      readonly actor: string;
      readonly beforeCommit: string;
      readonly branch: string;
      readonly commit: string;
      readonly deliveryId: string;
      readonly repository: string;
      readonly source: "reconciliation" | "webhook";
    };
    readonly release?: {
      readonly commit: string;
      readonly id: string;
      readonly path: string;
    };
    readonly rollback: {
      readonly attemptedReleaseId?: string;
      readonly performed: boolean;
      readonly restoredReleaseId?: string;
    };
    readonly verification?: {
      readonly actualStatus: number;
      readonly expectedStatus: number;
      readonly outcome: "healthy" | "unhealthy";
      readonly path: string;
    };
  };
  readonly task: {
    readonly conclusion: string;
    readonly createdAt: string;
    readonly id: string;
    readonly kind: "human-merge.promotion";
    readonly question: string;
    readonly status: "completed" | "denied" | "pending" | "running";
    readonly updatedAt: string;
  };
}

export interface PromotionEffectProjection {
  readonly actualStatus?: number;
  readonly command?: string;
  readonly kind:
    | "release.build"
    | "release.preflight"
    | "release.rollback"
    | "release.switch"
    | "release.verify";
  readonly operationId: string;
  readonly outcome: "completed" | "healthy" | "passed" | "unhealthy";
  readonly releasePath?: string;
  readonly restoredReleaseId?: string;
  readonly sourcePath?: string;
}
