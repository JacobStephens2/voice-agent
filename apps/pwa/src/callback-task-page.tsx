import type {
  TelephoneEvidenceEvent,
  TelephoneSessionEvidenceRecordProjection,
} from "@voice-agent/contracts";

const eventLabels: Record<TelephoneEvidenceEvent["kind"], string> = {
  "notification.requested": "Silent Notification requested",
  "notification.sent": "Silent Notification sent",
  "telephone.audio-debug.cleaned": "Raw-audio debugging cleaned",
  "telephone.audio-debug.enabled": "Raw-audio debugging enabled",
  "telephone.audio-debug.revoked": "Raw-audio debugging revoked",
  "telephone.authorization.rejected": "Authorization rejected",
  "telephone.callback.outcome": "Callback outcome",
  "telephone.callback.requested": "Callback requested",
  "telephone.dtmf.received": "DTMF received",
  "telephone.inbound.notice": "Callback notice",
  "telephone.inbound.received": "Inbound call received",
  "telephone.machine.detected": "Answer classified",
  "telephone.provider.failure": "Speech provider failure",
  "telephone.provider.timing": "Speech provider timing",
  "telephone.response.interrupted": "Spoken response interrupted",
  "telephone.retry.scheduled": "Retry scheduled",
  "telephone.semantic.response": "Spoken response prepared",
  "telephone.session.authorized": "Telephone Session authorized",
  "telephone.session.ended": "Telephone Session ended",
  "telephone.spending.warning": "Provider spending warning",
  "telephone.turn.finalized": "Finalized telephone turn",
  "telephone.usage.recorded": "Provider usage recorded",
};

export function CallbackTaskPage({
  record,
}: {
  readonly record: TelephoneSessionEvidenceRecordProjection;
}) {
  return (
    <main className="task-page">
      <header className="task-header">
        <p className="eyebrow">Callback Handshake</p>
        <h1>{record.task.question}</h1>
        <span className="status" aria-label={`Task status: ${record.task.status}`}>
          {record.task.status}
        </span>
      </header>

      <section className="conclusion" aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading">Conclusion</h2>
        <p>{record.task.conclusion}</p>
      </section>

      <section aria-labelledby="session-heading">
        <h2 id="session-heading">Telephone Session</h2>
        <dl>
          <dt>Durable identity</dt>
          <dd>{record.session.id}</dd>
          <dt>Callback attempt</dt>
          <dd>{record.session.attempt}</dd>
          <dt>Outcome</dt>
          <dd>{record.session.outcome}</dd>
          {record.session.endedAt === undefined ? null : (
            <>
              <dt>Ended at</dt>
              <dd>{record.session.endedAt}</dd>
              <dt>End reason</dt>
              <dd>{record.session.endReason}</dd>
              <dt>Duration</dt>
              <dd>{record.session.durationMs} ms</dd>
            </>
          )}
          {record.session.authorizedAt === undefined ? null : (
            <>
              <dt>Authorized at</dt>
              <dd>{record.session.authorizedAt}</dd>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Sanitized evidence timeline</h2>
        <ol className="timeline">
          {record.evidence.map((event) => (
            <li key={event.id}>
              <div className="event-heading">
                <h3>{eventLabels[event.kind]}</h3>
                <time dateTime={event.occurredAt}>{event.occurredAt}</time>
              </div>
              <p>{event.summary}</p>
              {Object.keys(event.details).length === 0 ? null : (
                <details>
                  <summary>Sanitized detail</summary>
                  <pre>{JSON.stringify(event.details, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
