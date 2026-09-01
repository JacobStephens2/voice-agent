import type { AdministrativeEvidenceRecord } from "@voice-agent/contracts";

const eventLabels: Record<
  AdministrativeEvidenceRecord["evidence"][number]["kind"],
  string
> = {
  "administrative.confirmation.accepted": "Task Confirmation accepted",
  "administrative.confirmation.declined": "Task Confirmation declined",
  "administrative.confirmation.prepared": "Task Confirmation prepared",
  "administrative.live-patch.rollback-activated":
    "Live Patch rollback activated",
  "administrative.live-patch.rollback-activation-failed":
    "Live Patch rollback activation retry scheduled",
  "administrative.live-patch.rollback-window-expired":
    "Live Patch rollback window expired",
  "administrative.operation.accepted": "Operation accepted",
  "administrative.operation.completed": "Operation completed",
  "administrative.plan.accepted": "Operation plan accepted",
  "administrative.task.completed": "Administrative Task completed",
  "administrative.task.denied": "Administrative Task denied",
};

export function AdministrativeTaskPage({
  record,
}: {
  readonly record: AdministrativeEvidenceRecord;
}) {
  return (
    <main className="task-page">
      <header className="task-header">
        <p className="eyebrow">Administrative Durable Task</p>
        <h1>{record.task.question}</h1>
        <span className="status" aria-label={`Task status: ${record.task.status}`}>
          {record.task.status}
        </span>
      </header>

      <section className="conclusion" aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading">Conclusion</h2>
        <p>{record.task.conclusion}</p>
        <p>
          <strong>Intended resulting state:</strong> {record.task.intendedState}
        </p>
        <p>
          Administrative Autonomy Policy revision{" "}
          {record.task.authority.policyRevision}
        </p>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Evidence timeline</h2>
        {record.evidenceTruncated ? (
          <p>
            Showing the latest {record.evidence.length} of{" "}
            {record.evidenceTotalCount} immutable Evidence Events.
          </p>
        ) : null}
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
