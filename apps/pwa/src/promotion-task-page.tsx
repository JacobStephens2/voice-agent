import type { PromotionEvidenceRecordProjection } from "@voice-agent/contracts";

const eventLabels: Record<
  PromotionEvidenceRecordProjection["evidence"][number]["kind"],
  string
> = {
  "circuit.changed": "Circuit state changed",
  "delivery.denied": "Delivery denied",
  "delivery.duplicate": "Duplicate delivery ignored",
  "merge.accepted": "Human Merge accepted",
  "promotion.queued": "Promotion Attempt queued",
  "reconciliation.discovered": "Missed Human Merge discovered",
  "release.built": "Release built",
  "release.preflighted": "Preflight completed",
  "release.rolled-back": "Prior Release restored",
  "release.switched": "Release switched",
  "release.verified": "Release verified",
};

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
          <dt>Merge commit</dt>
          <dd>{record.promotion.merge.commit}</dd>
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
          <dt>Deployment Circuit Breaker</dt>
          <dd>Circuit {record.promotion.circuit.state}</dd>
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
