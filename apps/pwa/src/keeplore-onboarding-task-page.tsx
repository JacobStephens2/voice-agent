import type { KeeploreOnboardingEvidenceRecordProjection } from "@voice-agent/contracts";

const eventLabels: Record<
  KeeploreOnboardingEvidenceRecordProjection["evidence"][number]["kind"],
  string
> = {
  "circuit.changed": "Circuit state changed",
  "delivery.denied": "Delivery denied",
  "delivery.duplicate": "Duplicate delivery ignored",
  "merge.accepted": "Human Merge accepted",
  "promotion.queued": "Promotion Attempt queued",
  "promotion.reordered": "Promotion Attempt reordered",
  "reconciliation.discovered": "Missed Human Merge discovered",
  "release.built": "Release built",
  "release.preflighted": "Preflight completed",
  "release.rolled-back": "Prior Release restored",
  "release.switched": "Release switched",
  "release.verified": "Release verified",
};

function assessmentSummary(
  label: string,
  assessment: KeeploreOnboardingEvidenceRecordProjection["onboarding"]["branchProtection"],
): string {
  return assessment.satisfied
    ? `${label} satisfied`
    : `${label} unsatisfied: ${assessment.violations.join("; ")}`;
}

export function KeeploreOnboardingTaskPage({
  record,
}: {
  readonly record: KeeploreOnboardingEvidenceRecordProjection;
}) {
  const { onboarding } = record;
  return (
    <main className="task-page">
      <header className="task-header">
        <p className="eyebrow">Keeplore onboarding</p>
        <h1>{record.task.question}</h1>
        <span className="status" aria-label={`Task status: ${record.task.status}`}>
          {record.task.status}
        </span>
      </header>

      <section className="conclusion" aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading">Conclusion</h2>
        <p>{record.task.conclusion}</p>
      </section>

      <section aria-labelledby="onboarding-heading">
        <h2 id="onboarding-heading">Onboarding evidence</h2>
        <dl>
          <dt>Registered Codebase</dt>
          <dd>Registered Codebase revision {onboarding.registrationRevision}</dd>
          <dt>Deployment Contract</dt>
          <dd>Deployment Contract revision {onboarding.contractRevision}</dd>
          <dt>Production-branch rules</dt>
          <dd>
            {assessmentSummary("Production-branch rules", onboarding.branchProtection)}
          </dd>
          <dt>GitHub App</dt>
          <dd>{assessmentSummary("GitHub App permissions", onboarding.githubApp)}</dd>
          {onboarding.merge === undefined ? null : (
            <>
              <dt>Human Merge provenance</dt>
              <dd>
                {onboarding.merge.source === "webhook"
                  ? `Webhook delivery ${onboarding.merge.deliveryId}`
                  : `Reconciliation ${onboarding.merge.deliveryId}`} by{" "}
                {onboarding.merge.actor} into {onboarding.merge.branch} of{" "}
                {onboarding.merge.repository} at {onboarding.merge.mergedAt}
              </dd>
              <dt>Merge commit</dt>
              <dd>{onboarding.merge.commit}</dd>
            </>
          )}
          {onboarding.promotionAttempt === undefined ? null : (
            <>
              <dt>Promotion Attempt</dt>
              <dd>
                Promotion Attempt {onboarding.promotionAttempt.id} is{" "}
                {onboarding.promotionAttempt.status}
              </dd>
            </>
          )}
          {onboarding.release === undefined ? null : (
            <>
              <dt>Release</dt>
              <dd>
                Release {onboarding.release.id} at {onboarding.release.path}
              </dd>
            </>
          )}
          {onboarding.retainedRelease === undefined ? null : (
            <>
              <dt>Retained Release</dt>
              <dd>Retained Release {onboarding.retainedRelease.id} for rollback</dd>
            </>
          )}
          {onboarding.health === undefined ? null : (
            <>
              <dt>Health verification</dt>
              <dd>
                Verification {onboarding.health.outcome}: {onboarding.health.path}{" "}
                answered {onboarding.health.actualStatus}, expected{" "}
                {onboarding.health.expectedStatus}
              </dd>
            </>
          )}
          <dt>Rollback</dt>
          <dd>
            {onboarding.rollback.performed
              ? `Rollback performed${
                  onboarding.rollback.restoredReleaseId === undefined
                    ? " with no prior Release"
                    : `. Restored ${onboarding.rollback.restoredReleaseId}`
                }`
              : "Rollback not required"}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Evidence timeline</h2>
        <ol className="timeline">
          {record.evidence.map((event) => (
            <li key={event.id}>
              <div className="event-heading">
                <h3>{eventLabels[event.kind]}</h3>
                <time dateTime={event.occurredAt}>{event.occurredAt}</time>
              </div>
              <p>{event.summary}</p>
              <details>
                <summary>Bounded detail</summary>
                <pre>{JSON.stringify(event.details, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
