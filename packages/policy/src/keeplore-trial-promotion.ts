import {
  describeKeeploreControlMismatch,
  keeploreTrialRolledBackConclusion,
  keeploreTrialUnpromotedConclusion,
  keeploreTrialVerifiedConclusion,
  keeploreProductionAppearanceVerdictSchema,
  keeploreProductionEvidenceRoot,
  keeploreTrialCompletionNoticeSchema,
  type KeeploreButtonTrialEvidenceRecord,
  type KeeploreDelegationResult,
  type KeeploreProductionAppearanceObservation,
  type KeeploreProductionAppearanceVerdict,
  type KeeploreTrialCompletionNotice,
} from "@voice-agent/contracts";

const verifiedViewports = ["desktop", "mobile"] as const;

/**
 * Judge what production was observed to render after a Promotion switched.
 *
 * This is the same bar the Delegation's candidate was held to, applied to the
 * live Release: the two table controls must share every matched property at
 * both viewports, keep differing content-based widths, and leave card view
 * exactly as the retained Release rendered it. Health alone is not enough —
 * a Release can answer 200 while serving the unchanged stylesheet.
 */
export function evaluateKeeploreProductionAppearance(
  observation: KeeploreProductionAppearanceObservation,
): KeeploreProductionAppearanceVerdict {
  const failures: string[] = [];
  if (observation.health.actualStatus !== observation.health.expectedStatus) {
    failures.push(
      `Keeplore production health answered ${observation.health.actualStatus}, expected ${observation.health.expectedStatus}`,
    );
  }
  for (const viewport of verifiedViewports) {
    const screenshot = observation.screenshots.find(
      (entry) => entry.viewport.name === viewport,
    );
    if (screenshot?.authenticated !== true) {
      failures.push(`Authenticated production ${viewport} screenshot is unavailable`);
    } else if (
      !screenshot.path.startsWith(keeploreProductionEvidenceRoot) ||
      screenshot.path.split("/").includes("..")
    ) {
      failures.push(
        `Production ${viewport} screenshot escaped the production evidence directory`,
      );
    }
    const styles = observation.computedStyles.find(
      (entry) => entry.viewport === viewport,
    );
    if (styles === undefined) {
      failures.push(`Production ${viewport} computed-style evidence is unavailable`);
      continue;
    }
    const mismatch = describeKeeploreControlMismatch(viewport, styles);
    if (mismatch !== null) failures.push(mismatch);
    if (
      styles.getRidOf.widthMode !== "content" ||
      styles.remove.widthMode !== "content" ||
      styles.getRidOf.width === styles.remove.width
    ) {
      failures.push(`Production ${viewport} table controls do not retain content widths`);
    }
  }
  if (!observation.cardView.unchanged || observation.cardView.beforeHash !== observation.cardView.afterHash) {
    failures.push("Card view regressed against the retained Release");
  }
  return keeploreProductionAppearanceVerdictSchema.parse({
    failures,
    outcome: failures.length === 0 ? "passed" : "failed",
  });
}

export type KeeploreObservedPullRequestState = "closed" | "merged" | "open";

export interface KeeploreWorktreeLifecycleDecision {
  readonly decision: "remove" | "retain";
  readonly reason: string;
}

/**
 * Whether a Delegated Worktree may finally be removed.
 *
 * A Delegated Worktree outlives its Delegation: review work happens on it while
 * the pull request is open. Only a merged or closed pull request ends that, and
 * only a clean, completed worktree is removed even then — anything stopped,
 * failed, dirty, or quarantined is kept for inspection rather than tidied away.
 */
export function decideKeeploreWorktreeLifecycle(input: {
  readonly pullRequestState: KeeploreObservedPullRequestState;
  readonly result: KeeploreDelegationResult;
}): KeeploreWorktreeLifecycleDecision {
  if (input.pullRequestState === "open") {
    return {
      decision: "retain",
      reason: "The Delegated Worktree's pull request is still open",
    };
  }
  const { result } = input;
  if (result.cleanup.quarantineReason !== null) {
    return { decision: "retain", reason: result.cleanup.quarantineReason };
  }
  if (result.status !== "completed" || result.worktree.state !== "completed") {
    return {
      decision: "retain",
      reason: `The Delegation ended ${result.status}; its worktree is retained for inspection`,
    };
  }
  if (result.worktree.dirty) {
    return {
      decision: "retain",
      reason: "The Delegated Worktree is dirty and is never removed automatically",
    };
  }
  return {
    decision: "remove",
    reason: `The pull request is ${input.pullRequestState} and the completed worktree is clean`,
  };
}

/**
 * The notice the owner receives. A Completion Callback the owner asked for is
 * only claimed when the call actually reached and authorized them; every other
 * ending falls back to the generic Silent Notification, which links the
 * authenticated Evidence Record and carries no operational evidence itself.
 */
export function chooseKeeploreTrialCompletionNotice(input: {
  readonly callback:
    | { readonly outcome: "authorized" | "failed" | "unanswered" | "voicemail" }
    | { readonly outcome: "not-requested" };
  readonly evidenceRecordUrl: string;
}): KeeploreTrialCompletionNotice {
  if (input.callback.outcome === "authorized") {
    return keeploreTrialCompletionNoticeSchema.parse({
      evidenceRecordUrl: input.evidenceRecordUrl,
      kind: "completion-callback",
      outcome: "authorized",
    });
  }
  return keeploreTrialCompletionNoticeSchema.parse({
    evidenceRecordUrl: input.evidenceRecordUrl,
    kind: "silent-notification",
    reason:
      input.callback.outcome === "not-requested"
        ? "not-requested"
        : (`callback-${input.callback.outcome}` as const),
  });
}

export function deriveKeeploreButtonTrialConclusion(input: {
  readonly appearance: KeeploreProductionAppearanceVerdict | undefined;
  readonly promoted: boolean;
  readonly rolledBack: boolean;
}): KeeploreButtonTrialEvidenceRecord["task"]["conclusion"] {
  if (input.rolledBack) return keeploreTrialRolledBackConclusion;
  if (input.promoted && input.appearance?.outcome === "passed") {
    return keeploreTrialVerifiedConclusion;
  }
  return keeploreTrialUnpromotedConclusion;
}
