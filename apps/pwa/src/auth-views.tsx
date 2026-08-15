import { useState, type ReactNode } from "react";

import type { EvidenceRecordSummary } from "@voice-agent/contracts";

export function Shell({
  children,
  message,
}: {
  children: ReactNode;
  message?: string | undefined;
}) {
  return (
    <main className="auth-shell">
      <p className="eyebrow">Voice Agent</p>
      <h1>Evidence, under your control.</h1>
      {message === undefined ? null : (
        <p className="notice" role="status">{message}</p>
      )}
      {children}
    </main>
  );
}

export function SetupView(props: {
  busy: boolean;
  message?: string | undefined;
  passkeyCount: number;
  recoveryConfirmationRequired: boolean;
  onEnroll(code: string, label: string): Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(
    props.passkeyCount === 0 ? "Android phone" : "Second passkey",
  );
  return (
    <Shell message={props.message}>
      <p>
        {props.passkeyCount === 0
          ? "Enroll your first passkey."
          : props.recoveryConfirmationRequired
            ? "Recovery Code receipt was not confirmed. Enroll with another authenticator to issue a fresh set."
            : "One more independently usable passkey is required."}
      </p>
      <p className="muted">
        Generate a new short-lived Bootstrap Code through your existing server
        access. It is never saved in this browser.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.onEnroll(code, label);
        }}
      >
        <label>
          Bootstrap Code
          <input
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </label>
        <label>
          Passkey label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
          />
        </label>
        <button disabled={props.busy}>
          {props.busy ? "Waiting for passkey…" : "Enroll passkey"}
        </button>
      </form>
    </Shell>
  );
}

export function LoginView(props: {
  busy: boolean;
  message?: string | undefined;
  onLogin(): Promise<void>;
  onRecover(code: string): Promise<void>;
}) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  return (
    <Shell message={props.message}>
      <p>Use a passkey to open your live task list and Evidence Records.</p>
      <button disabled={props.busy} onClick={() => void props.onLogin()}>
        Sign in with a passkey
      </button>
      <button className="quiet" onClick={() => setRecovery(!recovery)}>
        Use a Recovery Code
      </button>
      {recovery ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void props.onRecover(code);
          }}
        >
          <label>
            Single-use Recovery Code
            <input
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </label>
          <button disabled={props.busy}>Start passkey replacement</button>
        </form>
      ) : null}
    </Shell>
  );
}

export function ReplacementView(props: {
  busy: boolean;
  message?: string | undefined;
  onEnroll(label: string): Promise<void>;
}) {
  const [label, setLabel] = useState("Replacement passkey");
  return (
    <Shell message={props.message}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.onEnroll(label);
        }}
      >
        <label>
          Passkey label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
          />
        </label>
        <button disabled={props.busy}>Enroll replacement passkey</button>
      </form>
      <p className="muted">
        Recovery cannot open tasks, authorize an Intervention, or edit policy.
      </p>
    </Shell>
  );
}

export function RecoveryCodesView(props: {
  busy: boolean;
  codes: readonly string[];
  onConfirm(): Promise<void>;
}) {
  return (
    <Shell>
      <h2>Save your Recovery Codes</h2>
      <p>Each code works once and is shown only now. Store them offline.</p>
      <ol className="recovery-codes">
        {props.codes.map((code) => (
          <li key={code}><code>{code}</code></li>
        ))}
      </ol>
      <button disabled={props.busy} onClick={() => void props.onConfirm()}>
        I saved them
      </button>
    </Shell>
  );
}

export function TaskList(props: {
  tasks: readonly EvidenceRecordSummary[];
  message?: string | undefined;
  busy: boolean;
  onFresh(): Promise<void>;
}) {
  return (
    <main className="task-page">
      <p className="eyebrow">Voice Agent</p>
      <h1>Durable Tasks</h1>
      {props.message === undefined ? null : (
        <p className="notice" role="status">{props.message}</p>
      )}
      <ul className="task-list">
        {props.tasks.length === 0 ? (
          <li>No Evidence Records yet.</li>
        ) : (
          props.tasks.map((task) => (
            <li key={task.id}>
              <a href={`/?task=${encodeURIComponent(task.id)}`}>
                <strong>{task.question}</strong>
                <span>{task.conclusion}</span>
                <time>{formatTime(task.updatedAt)}</time>
              </a>
            </li>
          ))
        )}
      </ul>
      <ActionFooter busy={props.busy} onFresh={props.onFresh} />
    </main>
  );
}

export function ActionFooter({
  busy,
  onFresh,
}: {
  busy: boolean;
  onFresh(): Promise<void>;
}) {
  return (
    <footer className="action-footer">
      <button
        className="quiet"
        disabled={busy}
        onClick={() => void onFresh()}
      >
        Perform Fresh Passkey Action
      </button>
    </footer>
  );
}

export function OfflineView() {
  return (
    <Shell>
      <div className="offline" role="status">
        <h2>You’re offline</h2>
        <p>
          Live information is unavailable. Tasks, Evidence Records, policy, and
          credentials are never available from the offline cache.
        </p>
      </div>
    </Shell>
  );
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
