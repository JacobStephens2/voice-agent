import type { PromotionEvidenceRecordProjection } from "@voice-agent/contracts";

import { promotionEventLabels } from "./promotion-event-labels.ts";

export function PromotionTaskPage({
  record,
}: {
  readonly record: PromotionEvidenceRecordProjection;
}) {
  return (
    <main className="task-page">
      <header className="task-header">
        <p className="eyebrow">Human Merge Promotion</p>
        <h1>{record.task.question}</h1>
        <span className="status" aria-label={`Task status: ${record.task.status}`}>
          {record.task.status}
        </span>
      </header>

      <section className="conclusion" aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading">Conclusion</h2>
        <p>{record.task.conclusion}</p>
      </section>

      <section aria-labelledby="promotion-heading">
        <h2 id="promotion-heading">Promotion evidence</h2>
        <dl>
          <dt>Merge provenance</dt>
          <dd>
            {record.promotion.merge.source === "webhook"
              ? `Webhook delivery ${record.promotion.merge.deliveryId}`
              : `Reconciliation ${record.promotion.merge.deliveryId}`} by{" "}
            {record.promotion.merge.actor} into {record.promotion.merge.branch} of{" "}
            {record.promotion.merge.repository} at {record.promotion.merge.mergedAt}
          </dd>
          <dt>Merge commit</dt>
          <dd>{record.promotion.merge.commit}</dd>
          {record.promotion.attempt === undefined ? null : (
            <>
              <dt>Promotion Attempt</dt>
              <dd>
                Promotion Attempt {record.promotion.attempt.id}, queue{" "}
                {record.promotion.attempt.queueSequence}, {record.promotion.attempt.status}
              </dd>
            </>
          )}
          {record.promotion.contract === undefined ? null : (
            <>
              <dt>Deployment Contract</dt>
              <dd>Deployment Contract revision {record.promotion.contract.revision}</dd>
            </>
          )}
          {record.promotion.verification === undefined ? null : (
            <>
              <dt>Verification</dt>
              <dd>Verification {record.promotion.verification.outcome}</dd>
            </>
          )}
          {record.promotion.release === undefined ? null : (
            <>
              <dt>Release</dt>
              <dd>
                Release {record.promotion.release.id} at {record.promotion.release.path}
              </dd>
            </>
          )}
          <dt>Rollback</dt>
          <dd>
            {record.promotion.rollback.performed
              ? `Rollback performed${
                  record.promotion.rollback.restoredReleaseId === undefined
                    ? " with no prior Release"
                    : `. Restored ${record.promotion.rollback.restoredReleaseId}`
                }`
              : "Rollback not required"}
          </dd>
          <dt>Deployment Circuit Breaker</dt>
          <dd>Circuit {record.promotion.circuit.state}</dd>
          {record.promotion.authorityDrift === undefined ? null : (
            <>
              <dt>Pinned Deployment Authority</dt>
              <dd>
                {record.promotion.authorityDrift.diverged
                  ? `This Release diverges at ${record.promotion.authorityDrift.paths.join(
                      ", ",
                    )}. Apply the reviewed changes with the attended ${
                      record.promotion.authorityDrift.action
                    }.`
                  : "This Release matches the Pinned Deployment Authority"}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Evidence timeline</h2>
        <ol className="timeline">
          {record.evidence.map((event) => (
            <li key={event.id}>
              <div className="event-heading">
                <h3>{promotionEventLabels[event.kind]}</h3>
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
