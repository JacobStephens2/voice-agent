import {
  keeploreButtonTrialEvidenceRecordSchema,
  keeploreTrialVerifiedConclusion,
  keeploreProductionAppearanceObservationSchema,
  type KeeploreButtonTrialEvidenceRecord,
  type KeeploreDelegationRecord,
  type KeeplorePromotionAttemptRecord,
  type KeeploreProductionAppearanceObservation,
  type KeeploreTrialCompletionNotice,
} from "@voice-agent/contracts";
import {
  deriveKeeploreButtonTrialConclusion,
  evaluateKeeploreProductionAppearance,
  type KeeploreWorktreeLifecycleDecision,
} from "@voice-agent/policy";

const maximumEvidenceEvents = 100;

export interface KeeploreButtonTrialPromotionInput {
  /**
   * What the trusted promoter's own browser saw production render. It is read
   * back through its contract because it arrives from a separate host program.
   */
  readonly appearance?: KeeploreProductionAppearanceObservation | undefined;
  /** Every Promotion Attempt line the host journal holds, in any order. */
  readonly attempts: readonly KeeplorePromotionAttemptRecord[];
  readonly delegation: KeeploreDelegationRecord;
  /** The exact commit a Human Merge produced for this trial's pull request. */
  readonly mergeCommit?: string | undefined;
  readonly notice?: KeeploreTrialCompletionNotice | undefined;
  readonly worktree?:
    | (KeeploreWorktreeLifecycleDecision & { readonly observedAt: string })
    | undefined;
}

/**
 * Project slice three's single terminal Evidence Record.
 *
 * Everything the trial touched already has a durable home — the Delegation in
 * SQLite, the Promotion Attempts in the host's append-only journal, the
 * appearance observation in the promoter's own evidence directory. None of
 * them is the record an owner reads. This joins them under the Durable Task the
 * confirmed telephone request created, so the request, the delegated work, the
 * pull request a human merged, the Release, what production rendered, any
 * rollback, and the notice sent all read as one history.
 */
export function projectKeeploreButtonTrialEvidenceRecord(
  input: KeeploreButtonTrialPromotionInput,
): KeeploreButtonTrialEvidenceRecord {
  const { brief, result } = input.delegation.delegation;
  if (result === undefined || result.pullRequest.url === null) {
    throw new Error("The Keeplore Button Trial has no published pull request to conclude");
  }
  const pullRequestUrl = result.pullRequest.url;
  const appearance =
    input.appearance === undefined
      ? undefined
      : keeploreProductionAppearanceObservationSchema.parse(input.appearance);
  const ordered = [...input.attempts]
    .filter(
      (attempt) =>
        input.mergeCommit === undefined ||
        attempt.commit === input.mergeCommit ||
        attempt.repromotion?.mergeCommit === input.mergeCommit,
    )
    .sort((left, right) => left.attemptedAt.localeCompare(right.attemptedAt));
  // A re-promotion makes two attempts that are about the merge without being a
  // Promotion of it: the bounded step back to the retained Release, and the
  // restore that returns production to the merge commit when the candidate
  // failed. Both belong in the history and neither may decide what the trial
  // concluded — a succeeded restore is production made safe again, not a
  // verified merge.
  const promotions = ordered.filter(
    (attempt) =>
      attempt.repromotion === undefined || attempt.repromotion.kind === "candidate",
  );
  const merge = promotions.find((attempt) => attempt.merge !== undefined);
  const release = promotions.find((attempt) => attempt.release !== undefined)?.release;
  const promoted = promotions.some(
    (attempt) => attempt.result === "succeeded" && attempt.stage === "promotion",
  );
  // The host writes `restored: ""` on every failed attempt, including ones that
  // failed before anything switched. Only a named restored Release is a
  // rollback; a preflight or baseline failure left production untouched.
  const rolledBackAttempt = promotions.find(
    (attempt) =>
      attempt.result === "failed" &&
      attempt.restored !== undefined &&
      attempt.restored !== "",
  );
  const health = promotions.find(
    (attempt) => attempt.verification !== undefined,
  )?.verification;
  const built = promotions.find((attempt) => attempt.contractRevision !== undefined);
  const verdict = appearance === undefined ? undefined : evaluateKeeploreProductionAppearance(appearance);

  const events: {
    details: Record<string, boolean | number | string | null>;
    kind: KeeploreButtonTrialEvidenceRecord["evidence"][number]["kind"];
    occurredAt: string;
    summary: string;
  }[] = [
    {
      details: {
        requestId: brief.durableTask.requestId,
        taskId: brief.durableTask.id,
      },
      kind: "request.confirmed",
      occurredAt: brief.durableTask.acceptedAt,
      summary:
        "The owner confirmed the Keeplore Button Trial on an authenticated Telephone Session.",
    },
    {
      details: {
        branch: result.branch,
        changedFiles: result.changedFiles.join(", "),
        commits: result.commits.join(", "),
        pullRequest: pullRequestUrl,
      },
      kind: "delegation.published",
      occurredAt: result.completedAt,
      summary: `Delegation ${brief.delegationId} opened ${pullRequestUrl} from ${result.branch}.`,
    },
  ];
  if (merge?.merge !== undefined) {
    events.push({
      details: {
        actor: merge.merge.actor,
        commit: merge.commit,
        source: merge.merge.source,
      },
      kind: "merge.accepted",
      occurredAt: merge.merge.mergedAt,
      summary: `${merge.merge.actor} merged ${merge.commit} into ${brief.registeredCodebase.productionBranch}.`,
    });
  }
  if (built?.contractRevision !== undefined) {
    events.push({
      details: {
        checks: (built.checks ?? [])
          .map((check) => `${check.name}=${check.conclusion}`)
          .join(", "),
        contractRevision: built.contractRevision,
      },
      kind: "checks.recorded",
      occurredAt: built.attemptedAt,
      summary: `Required checks and Deployment Contract revision ${built.contractRevision} were recorded before the Release was built.`,
    });
  }
  for (const attempt of ordered) {
    if (attempt.repromotion === undefined || attempt.result !== "succeeded") continue;
    if (attempt.repromotion.kind === "step-back") {
      events.push({
        details: {
          mergeCommit: attempt.repromotion.mergeCommit,
          retainedReleaseCommit: attempt.commit,
        },
        kind: "release.stepped-back",
        occurredAt: attempt.attemptedAt,
        summary: `Production stepped back to retained Release ${attempt.commit} so ${attempt.repromotion.mergeCommit} could be measured against a different Release.`,
      });
    }
    if (attempt.repromotion.kind === "restore") {
      events.push({
        details: { restoredReleaseCommit: attempt.commit },
        kind: "release.restored",
        occurredAt: attempt.attemptedAt,
        summary: `Production was restored to Release ${attempt.commit} after the re-promotion failed to verify it.`,
      });
    }
  }
  for (const attempt of promotions) {
    if (attempt.release === undefined) continue;
    events.push({
      details: { commit: attempt.commit, releaseId: attempt.release.id },
      kind: "release.built",
      occurredAt: attempt.attemptedAt,
      summary: `Release ${attempt.release.id} was built from ${attempt.commit} outside the live checkout.`,
    });
    break;
  }
  if (verdict !== undefined && appearance !== undefined) {
    events.push({
      details: {
        failures: verdict.failures.join("; "),
        outcome: verdict.outcome,
        releaseCommit: appearance.releaseCommit,
      },
      kind: "release.verified",
      occurredAt: appearance.observedAt,
      summary:
        verdict.outcome === "passed"
          ? "Production served the matched table-view controls at both verification viewports."
          : `Production appearance verification failed: ${verdict.failures.join("; ")}`,
    });
  }
  if (rolledBackAttempt !== undefined) {
    events.push({
      details: {
        attemptedReleaseCommit: rolledBackAttempt.commit,
        restoredReleaseCommit: rolledBackAttempt.restored ?? null,
      },
      kind: "release.rolled-back",
      occurredAt: rolledBackAttempt.attemptedAt,
      summary: `Release ${rolledBackAttempt.commit} failed verification and the retained Release was restored.`,
    });
  }
  if (input.worktree !== undefined) {
    events.push({
      details: { path: result.worktree.path, reason: input.worktree.reason },
      kind: input.worktree.decision === "remove" ? "worktree.removed" : "worktree.retained",
      occurredAt: input.worktree.observedAt,
      summary: input.worktree.reason,
    });
  }
  if (input.notice !== undefined) {
    events.push({
      details: {
        evidenceRecord: input.notice.evidenceRecordUrl,
        kind: input.notice.kind,
        reason: input.notice.kind === "silent-notification" ? input.notice.reason : "authorized",
      },
      kind: "notice.delivered",
      occurredAt: input.worktree?.observedAt ?? result.completedAt,
      summary:
        input.notice.kind === "completion-callback"
          ? "The owner received the requested Completion Callback linked to the authenticated Evidence Record."
          : "The owner received a generic Silent Notification linked to the authenticated Evidence Record.",
    });
  }

  const conclusion = deriveKeeploreButtonTrialConclusion({
    appearance: verdict,
    promoted,
    rolledBack: rolledBackAttempt !== undefined,
  });
  const verified = conclusion === keeploreTrialVerifiedConclusion;
  const history = events
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(0, maximumEvidenceEvents - 1);
  // The conclusion is terminal by construction rather than by timestamp: it is
  // derived from everything above it, so it can never sort into the middle of
  // the history it summarizes.
  const sorted = [
    ...history,
    {
      details: { conclusion },
      kind: "trial.concluded" as const,
      occurredAt: history[history.length - 1]?.occurredAt ?? result.completedAt,
      summary: conclusion,
    },
  ];

  return keeploreButtonTrialEvidenceRecordSchema.parse({
    evidence: sorted.map((event, index) => ({
      ...event,
      id: `${brief.durableTask.id}:${index + 1}`,
      sequence: index + 1,
    })),
    task: {
      conclusion,
      createdAt: brief.durableTask.acceptedAt,
      id: brief.durableTask.id,
      kind: "keeplore.button-trial",
      status: verified ? "completed" : rolledBackAttempt === undefined && !promoted ? "pending" : "failed",
      updatedAt: sorted[sorted.length - 1]?.occurredAt ?? result.completedAt,
    },
    trial: {
      delegation: {
        branch: result.branch,
        changedFiles: [...result.changedFiles],
        commits: [...result.commits],
        delegationId: brief.delegationId,
        pullRequestUrl,
        status: result.status,
      },
      ...(merge?.merge === undefined
        ? {}
        : {
            merge: {
              actor: merge.merge.actor,
              branch: brief.registeredCodebase.productionBranch,
              commit: merge.commit,
              mergedAt: merge.merge.mergedAt,
              repository: brief.registeredCodebase.repository,
              source: merge.merge.source,
            },
          }),
      ...(input.notice === undefined ? {} : { notice: input.notice }),
      ...(built?.contractRevision === undefined
        ? {}
        : {
            promotion: {
              checks: [...(built.checks ?? [])],
              contractRevision: built.contractRevision,
            },
          }),
      ...(release === undefined || merge === undefined
        ? {}
        : { release: { ...release, commit: merge.commit } }),
      request: {
        confirmedAt: brief.durableTask.acceptedAt,
        requestId: brief.durableTask.requestId,
        taskId: brief.durableTask.id,
      },
      rollback: {
        ...(rolledBackAttempt === undefined
          ? {}
          : {
              attemptedReleaseCommit: rolledBackAttempt.commit,
              ...(rolledBackAttempt.restored !== undefined && rolledBackAttempt.restored !== ""
                ? { restoredReleaseCommit: rolledBackAttempt.restored }
                : {}),
            }),
        performed: rolledBackAttempt !== undefined,
      },
      verification: {
        ...(verdict === undefined ? {} : { appearance: verdict }),
        ...(appearance === undefined ? {} : { cardView: appearance.cardView }),
        ...(health === undefined
          ? {}
          : {
              health: {
                actualStatus: health.actualStatus,
                expectedStatus: health.expectedStatus,
                outcome: health.actualStatus === health.expectedStatus ? "healthy" : "unhealthy",
              },
            }),
        screenshots: appearance === undefined ? [] : [...appearance.screenshots],
      },
    },
  });
}
