import {
  keeploreOnboardingEvidenceRecordProjectionSchema,
  keeplorePromotionAttemptRecordSchema,
  type KeeploreOnboardingEvidenceRecordProjection,
  type KeeplorePromotionAttemptRecord,
} from "@voice-agent/contracts";
import type { KeeploreOnboardingStore } from "@voice-agent/durable-store";
import { deriveKeeploreOnboardingConclusion } from "@voice-agent/policy";

const maximumEvidenceEvents = 100;

export const keeplorePromotionTaskPrefix = "keeplore-promotion:" as const;

/** The Agent Host's Promotion Attempt journal, read as untrusted append-only events. */
export interface KeeplorePromotionJournal {
  read(): Promise<string>;
}

export function keeplorePromotionTaskId(commit: string): string {
  return `${keeplorePromotionTaskPrefix}${commit}`;
}

/**
 * Parses journal lines, discarding any the contract rejects. A truncated final
 * line — the host appends while this reads — is simply not yet evidence.
 */
export function readPromotionAttempts(
  journal: string,
): readonly KeeplorePromotionAttemptRecord[] {
  const attempts: KeeplorePromotionAttemptRecord[] = [];
  for (const line of journal.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const attempt = keeplorePromotionAttemptRecordSchema.safeParse(parsed);
    if (attempt.success) attempts.push(attempt.data);
  }
  return attempts;
}

interface EvidenceEvent {
  readonly details: Record<string, string | number | boolean | null>;
  readonly kind:
    | "merge.accepted"
    | "release.built"
    | "release.preflighted"
    | "release.rolled-back"
    | "release.verified";
  readonly summary: string;
}

function describeAttempt(attempt: KeeplorePromotionAttemptRecord): EvidenceEvent {
  if (attempt.result === "succeeded") {
    return {
      details: {
        commit: attempt.commit,
        releaseId: attempt.release?.id ?? attempt.commit,
        stage: attempt.stage,
      },
      kind: "release.verified",
      summary: `Release ${attempt.commit} was promoted and verified healthy.`,
    };
  }
  if (attempt.stage === "preflight") {
    return {
      details: { commit: attempt.commit, outcome: "failed" },
      kind: "release.preflighted",
      summary: `Release ${attempt.commit} failed its declared preflight.`,
    };
  }
  if (attempt.stage === "release-build") {
    return {
      details: { commit: attempt.commit, outcome: "failed" },
      kind: "release.built",
      summary: `Release ${attempt.commit} could not be built.`,
    };
  }
  return {
    details: {
      attemptedReleaseId: attempt.commit,
      drill: attempt.stage === "verification-drill",
      restoredReleaseId: attempt.restored ?? null,
    },
    kind: "release.rolled-back",
    summary:
      attempt.stage === "verification-drill"
        ? `A verification drill failed Release ${attempt.commit} and restored the retained Release.`
        : `Release ${attempt.commit} failed verification and the retained Release was restored.`,
  };
}

/**
 * Projects the host's journal into onboarding Evidence Records, one per merge
 * commit. Registration and Deployment Contract revisions come from the durable
 * store, so an unenrolled Keeplore produces no Evidence Record at all.
 */
export async function projectKeeplorePromotionEvidence(options: {
  readonly journal: KeeplorePromotionJournal;
  readonly store: KeeploreOnboardingStore;
}): Promise<readonly KeeploreOnboardingEvidenceRecordProjection[]> {
  const [registration, contract] = await Promise.all([
    options.store.findRegistration(),
    options.store.findActiveContract(),
  ]);
  if (registration === undefined || contract === undefined) return [];
  const [branchProtection, githubApp] = await Promise.all([
    options.store.findAssessment("branch-protection"),
    options.store.findAssessment("github-app"),
  ]);
  const unassessed = { satisfied: false, violations: ["Not assessed"] };

  const attemptsByCommit = new Map<string, KeeplorePromotionAttemptRecord[]>();
  for (const attempt of readPromotionAttempts(await options.journal.read())) {
    const existing = attemptsByCommit.get(attempt.commit) ?? [];
    existing.push(attempt);
    attemptsByCommit.set(attempt.commit, existing);
  }

  const records: KeeploreOnboardingEvidenceRecordProjection[] = [];
  for (const [commit, attempts] of attemptsByCommit) {
    const ordered = [...attempts].sort((left, right) =>
      left.attemptedAt.localeCompare(right.attemptedAt),
    );
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first === undefined || last === undefined) continue;
    const merge = ordered.find((attempt) => attempt.merge !== undefined)?.merge;
    const promoted = ordered.some(
      (attempt) => attempt.result === "succeeded" && attempt.stage === "promotion",
    );
    const rolledBack = ordered.some(
      (attempt) =>
        attempt.result === "failed" &&
        (attempt.stage === "verification" || attempt.stage === "verification-drill"),
    );
    const release = ordered.find((attempt) => attempt.release !== undefined)?.release;
    const verification = ordered.find(
      (attempt) => attempt.verification !== undefined,
    )?.verification;

    const evidence = ordered
      .slice(0, maximumEvidenceEvents)
      .map((attempt, index) => {
        const event = describeAttempt(attempt);
        return {
          details: event.details,
          id: `${commit}:${index + 1}`,
          kind: event.kind,
          occurredAt: attempt.attemptedAt,
          sequence: index + 1,
          summary: event.summary,
        };
      });
    if (merge !== undefined && evidence.length < maximumEvidenceEvents) {
      evidence.unshift({
        details: { actor: merge.actor, commit, source: merge.source },
        id: `${commit}:merge`,
        kind: "merge.accepted",
        occurredAt: merge.mergedAt,
        sequence: 0,
        summary: `${merge.actor} merged ${commit} into ${registration.productionBranch}.`,
      });
    }

    records.push(
      keeploreOnboardingEvidenceRecordProjectionSchema.parse({
        evidence: evidence.map((event, index) => ({
          ...event,
          sequence: index + 1,
        })),
        onboarding: {
          branchProtection: branchProtection ?? unassessed,
          contractRevision: contract.revision,
          githubApp: githubApp ?? unassessed,
          ...(verification === undefined
            ? {}
            : {
                health: {
                  actualStatus: Math.max(verification.actualStatus, 100),
                  expectedStatus: verification.expectedStatus,
                  outcome:
                    verification.actualStatus === verification.expectedStatus
                      ? "healthy"
                      : "unhealthy",
                  path: contract.health.path,
                },
              }),
          ...(merge === undefined
            ? {}
            : {
                merge: {
                  actor: merge.actor,
                  beforeCommit: /^[0-9a-f]{40}$/u.test(last.previous)
                    ? last.previous
                    : commit,
                  branch: registration.productionBranch,
                  commit,
                  deliveryId: `agent-host:${commit}`,
                  mergedAt: merge.mergedAt,
                  repository: registration.repository,
                  source: merge.source,
                },
              }),
          promotionAttempt: {
            id: `${commit}:${ordered.length}`,
            mergeCommit: commit,
            status: promoted ? "succeeded" : rolledBack ? "rolled-back" : "queued",
          },
          registrationRevision: registration.revision,
          ...(release === undefined ? {} : { release: { ...release, commit } }),
          rollback: {
            ...(rolledBack ? { attemptedReleaseId: commit } : {}),
            performed: rolledBack,
            ...(rolledBack && last.restored !== undefined && last.restored !== ""
              ? { restoredReleaseId: last.restored }
              : {}),
          },
        },
        task: {
          conclusion: promoted
            ? deriveKeeploreOnboardingConclusion({ promoted, rolledBack: false })
            : "Keeplore onboarding could not be confirmed.",
          createdAt: first.attemptedAt,
          id: keeplorePromotionTaskId(commit),
          kind: "keeplore.onboarding",
          question: "Onboard Keeplore with a harmless Human Merge.",
          status: promoted ? "completed" : "denied",
          updatedAt: last.attemptedAt,
        },
      }),
    );
  }
  return records;
}
