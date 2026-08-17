import type {
  EvidenceEventProjection,
  EvidenceRecordProjection,
} from "@voice-agent/contracts";

const eventLabels: Record<EvidenceEventProjection["kind"], string> = {
  "task.accepted": "Inquiry accepted",
  "operation.accepted": "Health check accepted",
  "evidence.observed": "Health evidence observed",
  "operation.completed": "Health check completed",
  "task.completed": "Inquiry completed",
  "telephone.provider.timing": "Speech provider timing",
  "telephone.provider.failure": "Speech provider failure",
  "telephone.response.interrupted": "Spoken response interrupted",
  "telephone.semantic.response": "Spoken response prepared",
  "telephone.turn.finalized": "Finalized telephone turn",
};

export function TaskPage({ record }: { readonly record: EvidenceRecordProjection }) {
  return (
    <main className="task-page">
      <header className="task-header">
        <p className="eyebrow">Durable Task</p>
        <h1>{record.task.question}</h1>
        <span className="status" aria-label={`Task status: ${record.task.status}`}>
          {record.task.status}
        </span>
      </header>

      <section className="conclusion" aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading">Conclusion</h2>
        <p>{record.task.conclusion}</p>
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
              {Object.keys(event.details).length > 0 ? (
                <details>
                  <summary>Bounded detail</summary>
                  <pre>{JSON.stringify(event.details, null, 2)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
