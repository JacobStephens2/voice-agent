import type {
  EvidenceEventProjection,
  EvidenceRecordProjection,
} from "@voice-agent/contracts";

const eventLabels: Record<EvidenceEventProjection["kind"], string> = {
  "completion.callback.requested": "Completion Callback requested",
  "completion.callback.outcome": "Completion Callback outcome",
  "notification.requested": "Silent Notification requested",
  "notification.sent": "Silent Notification sent",
  "telephone.audio-debug.cleaned": "Raw-audio debugging cleaned",
  "telephone.audio-debug.enabled": "Raw-audio debugging enabled",
  "telephone.audio-debug.revoked": "Raw-audio debugging revoked",
  "task.cancellation.requested": "Cancellation requested",
  "task.cancelled": "Task cancelled",
  "task.accepted": "Inquiry accepted",
  "operation.accepted": "Health check accepted",
  "evidence.observed": "Health evidence observed",
  "operation.completed": "Health check completed",
  "task.completed": "Inquiry completed",
  "fault.reported": "Fault reported",
  "fault.presented": "Fault report presented",
  "diagnosis.recorded": "Diagnosis recorded",
  "policy.decided": "Policy decision",
  "timer.lifecycle": "Recovery timer",
  "telephone.provider.timing": "Speech provider timing",
  "telephone.provider.failure": "Speech provider failure",
  "telephone.provider.retry": "Speech provider retry",
  "telephone.response.interrupted": "Spoken response interrupted",
  "telephone.semantic.response": "Spoken response prepared",
  "telephone.session.ended": "Telephone Session ended",
  "telephone.spending.warning": "Provider spending warning",
  "telephone.turn.finalized": "Finalized telephone turn",
  "telephone.usage.recorded": "Provider usage recorded",
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
