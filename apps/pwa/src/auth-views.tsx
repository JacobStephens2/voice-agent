import { useState, type ReactNode } from "react";

import type {
  AdministrativeAutonomyStatus,
  AdministrativeRestartWitnessObservationIdentity,
  BountywellRegistration,
  EvidenceRecordSummary,
  KeeploreLiveInspection,
  KeeploreRegistration,
  KeeploreWorkingTreeReconciliation,
  NotificationPreference,
  NotificationPreferenceInput,
  RegisteredTelephone,
  RegisteredTelephoneInput,
  TelephoneBoundaryStatus,
} from "@voice-agent/contracts";

import { KeeploreOnboardingControl } from "./keeplore-onboarding-control.tsx";
import { normalizeOwnerTelephoneInput } from "./owner-telephone-input.ts";

function hasBountywellRestart(registration: BountywellRegistration): boolean {
  return registration.capabilities.some(
    (capability) => capability === "bountywell.service.restart",
  );
}

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
  administrativeAutonomy?: AdministrativeAutonomyStatus | undefined;
  bountywellRegistration?: BountywellRegistration | undefined;
  keeploreInspection?: KeeploreLiveInspection | undefined;
  keeploreRegistration?: KeeploreRegistration | undefined;
  onActivateKeeploreDeploymentContract(): Promise<void>;
  onEnrollKeeplore(
    reconciliation: KeeploreWorkingTreeReconciliation,
  ): Promise<void>;
  onInspectKeeplore(): Promise<void>;
  registeredTelephone?: RegisteredTelephone | undefined;
  telephoneRegistrationLoaded?: boolean;
  telephoneBoundaries?: TelephoneBoundaryStatus | undefined;
  notificationPreference?: NotificationPreference | undefined;
  tasks: readonly EvidenceRecordSummary[];
  message?: string | undefined;
  busy: boolean;
  onAuthorizeDeploymentAuthorityUpgrade(): Promise<void>;
  onActivateAdministrativeAutonomy(): Promise<void>;
  onSuspendAdministrativeAutonomy(): Promise<void>;
  onRecordRestartWitnessObservation(): Promise<void>;
  onFresh(): Promise<void>;
  onApplyEvidenceRetention(): Promise<void>;
  onResumePromotions(): Promise<void>;
  onRegisterBountywell(): Promise<void>;
  onGrantBountywellRestart(): Promise<void>;
  onArmRecoveryTimer(): Promise<void>;
  onProveRecoveryTimer(): Promise<void>;
  onPresentOutageReport(): Promise<void>;
  onStartOutageDrill(): Promise<void>;
  onRegisterTelephone(input: RegisteredTelephoneInput): Promise<void>;
  onChangeSpendingCeiling(ceilingMicrousd: number): Promise<void>;
  onUpdateNotificationPreference(input: NotificationPreferenceInput): Promise<void>;
  onRunBountywell(): Promise<void>;
  restartWitnessObservation?:
    | AdministrativeRestartWitnessObservationIdentity
    | undefined;
}) {
  return (
    <main className="task-page">
      <p className="eyebrow">Voice Agent</p>
      <h1>Durable Tasks</h1>
      {props.message === undefined ? null : (
        <p className="notice" role="status">{props.message}</p>
      )}
      {props.registeredTelephone === undefined &&
      props.telephoneRegistrationLoaded !== true ? null : (
        <TelephoneRegistrationControl
          busy={props.busy}
          registration={props.registeredTelephone}
          onRegister={props.onRegisterTelephone}
        />
      )}
      <TelephoneSpendingControl
        busy={props.busy}
        onChange={props.onChangeSpendingCeiling}
        status={props.telephoneBoundaries}
      />
      <NotificationPreferenceControl
        key={props.notificationPreference?.revision ?? 0}
        busy={props.busy}
        onUpdate={props.onUpdateNotificationPreference}
        preference={props.notificationPreference}
      />
      <section
        className="bountywell-control"
        aria-labelledby="administrative-autonomy-heading"
      >
        <p className="eyebrow">Standing authority</p>
        <h2 id="administrative-autonomy-heading">Administrative Autonomy</h2>
        {props.administrativeAutonomy?.policy.status === "active" ? (
          <p>
            Policy revision {props.administrativeAutonomy.policy.revision} is
            active.
          </p>
        ) : props.administrativeAutonomy?.policy.status === "suspended" ? (
          <p>
            Policy revision {props.administrativeAutonomy.policy.revision} is
            suspended. A new Fresh Passkey Action is required before reactivation.
          </p>
        ) : (
          <p>
            Administrative Autonomy is inactive. Activation requires a Fresh
            Passkey Action and does not grant arbitrary shell, credential,
            merge, or deployment authority.
          </p>
        )}
        {props.administrativeAutonomy?.taskExecution.status ===
          "execution-manifest-present" &&
        props.administrativeAutonomy.policy.status === "active" ? (
          <p>
            Confirmed Durable Tasks may choose only the typed Operations allowed
            by their intended resulting state and policy.
          </p>
        ) : props.administrativeAutonomy?.taskExecution.status ===
          "execution-manifest-present" ? (
          <p>
            An Administrative Execution Manifest is present, but administrative
            effects remain blocked while the policy is not active.
          </p>
        ) : props.administrativeAutonomy?.taskExecution.status ===
          "activation-required" ? (
          <p>
            The runtime Administrative Execution Manifest differs from the
            active policy revision. A new Fresh Passkey Action is required
            before task execution.
          </p>
        ) : (
          <p>
            Task execution is unavailable because an executable Administrative
            Execution Manifest is not present. Policy activation alone does not
            grant executable administrative authority.
          </p>
        )}
        <button
          disabled={props.busy}
          onClick={() => void props.onActivateAdministrativeAutonomy()}
        >
          {props.administrativeAutonomy?.policy.status === "active"
            ? "Activate a new policy revision"
            : "Activate Administrative Autonomy"}
        </button>
        {props.administrativeAutonomy?.policy.status === "active" ? (
          <>
            <p>
              Administrative Suspension blocks every new administrative effect
              and activates every armed rollback. It preserves Delegated
              Worktrees and evidence, and reactivation needs a new Fresh Passkey
              Action.
            </p>
            <button
              disabled={props.busy}
              onClick={() => void props.onSuspendAdministrativeAutonomy()}
            >
              Suspend Administrative Autonomy
            </button>
          </>
        ) : null}
      </section>
      {props.restartWitnessObservation === undefined ? null : (
        <section
          className="bountywell-control"
          aria-labelledby="restart-witness-heading"
        >
          <p className="eyebrow">Attended acceptance</p>
          <h2 id="restart-witness-heading">Agent Host Restart Witness</h2>
          <p>
            Record the <strong>{props.restartWitnessObservation.phase}</strong>{" "}
            observation. The server reads the active policy, Administrative
            Execution Manifest, immutable Release, API service instance, and
            Linux boot identity from its fixed composition boundary.
          </p>
          <button
            disabled={props.busy}
            onClick={() => void props.onRecordRestartWitnessObservation()}
          >
            Record server observation
          </button>
        </section>
      )}
      <section className="bountywell-control" aria-labelledby="retention-heading">
        <p className="eyebrow">Lifecycle policy</p>
        <h2 id="retention-heading">Evidence retention</h2>
        <p>
          Remove ordinary Evidence Events older than 90 days while preserving
          Durable Task and Operation identities. A Fresh Passkey Action is required.
        </p>
        <button
          disabled={props.busy}
          onClick={() => void props.onApplyEvidenceRetention()}
        >
          Activate 90-day Evidence retention
        </button>
      </section>
      <section className="bountywell-control" aria-labelledby="bountywell-heading">
        <p className="eyebrow">Registered application</p>
        <h2 id="bountywell-heading">Bountywell production</h2>
        {props.bountywellRegistration === undefined ? (
          <>
            <p>
              Register the fixed public, local, systemd, and bounded resource
              reads after a Fresh Passkey Action.
            </p>
            <button
              disabled={props.busy}
              onClick={() => void props.onRegisterBountywell()}
            >
              Register Bountywell read-only access
            </button>
          </>
        ) : (
          <>
            <p>
              <strong>{props.bountywellRegistration.serviceUnit}</strong> is
              registered at revision {props.bountywellRegistration.revision}
              {hasBountywellRestart(props.bountywellRegistration)
                ? " with the exact bountywell-api.service restart capability."
                : " with five read-only capabilities. No restart or service-control authority is present."}
            </p>
            <button
              disabled={props.busy}
              onClick={() => void props.onRunBountywell()}
            >
              Run Bountywell health inquiry
            </button>
            {hasBountywellRestart(props.bountywellRegistration) ? (
              <>
                <p>
                  The guarded drill arms an independent ten-minute recovery
                  timer, then stops only bountywell-api.service while you are
                  available.
                </p>
                <button
                  disabled={props.busy}
                  onClick={() => void props.onArmRecoveryTimer()}
                >
                  Arm recovery timer
                </button>
                <button
                  disabled={props.busy}
                  onClick={() => void props.onProveRecoveryTimer()}
                >
                  Prove recovery timer
                </button>
                <button
                  disabled={props.busy}
                  onClick={() => void props.onStartOutageDrill()}
                >
                  Start guarded outage drill
                </button>
                <button
                  disabled={props.busy}
                  onClick={() => void props.onPresentOutageReport()}
                >
                  Present fault report again
                </button>
              </>
            ) : (
              <button
                disabled={props.busy}
                onClick={() => void props.onGrantBountywellRestart()}
              >
                Grant Bountywell restart authority
              </button>
            )}
          </>
        )}
      </section>
      <KeeploreOnboardingControl
        busy={props.busy}
        inspection={props.keeploreInspection}
        onActivateDeploymentContract={props.onActivateKeeploreDeploymentContract}
        onEnroll={props.onEnrollKeeplore}
        onInspect={props.onInspectKeeplore}
        registration={props.keeploreRegistration}
      />
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
      <ActionFooter
        busy={props.busy}
        onAuthorizeDeploymentAuthorityUpgrade={
          props.onAuthorizeDeploymentAuthorityUpgrade
        }
        onFresh={props.onFresh}
        onResumePromotions={props.onResumePromotions}
      />
    </main>
  );
}

function TelephoneSpendingControl(props: {
  busy: boolean;
  onChange(ceilingMicrousd: number): Promise<void>;
  status?: TelephoneBoundaryStatus | undefined;
}) {
  const [ceilingDollars, setCeilingDollars] = useState(
    (props.status?.spending.ceilingMicrousd ?? 50_000_000) / 1_000_000,
  );
  const spending = props.status?.spending;
  return (
    <section className="bountywell-control" aria-labelledby="spending-heading">
      <p className="eyebrow">Fail-closed budget</p>
      <h2 id="spending-heading">Paid provider spending</h2>
      {spending === undefined ? (
        <p>Provider usage is unavailable.</p>
      ) : (
        <p>
          {formatUsd(spending.totalMicrousd)} used in {spending.month}: API{" "}
          {formatUsd(spending.bySourceMicrousd.api)}, telephony{" "}
          {formatUsd(spending.bySourceMicrousd.telephony)}, realtime media{" "}
          {formatUsd(spending.bySourceMicrousd["realtime-media"])}. New paid
          work stops at {formatUsd(spending.ceilingMicrousd)}.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.onChange(Math.round(ceilingDollars * 1_000_000));
        }}
      >
        <label>
          Monthly ceiling (USD)
          <input
            min="1"
            max="1000"
            required
            step="1"
            type="number"
            value={ceilingDollars}
            onChange={(event) => setCeilingDollars(event.target.valueAsNumber)}
          />
        </label>
        <button disabled={props.busy}>Change ceiling after Fresh Passkey Action</button>
      </form>
    </section>
  );
}

export function RawAudioDebugControl(props: {
  busy: boolean;
  onEnable(sessionId: string): Promise<void>;
  sessionId: string;
}) {
  return (
    <section className="bountywell-control" aria-labelledby="audio-debug-heading">
      <p className="eyebrow">Exceptional privacy mode</p>
      <h2 id="audio-debug-heading">Raw-audio debugging</h2>
      <p className="notice">
        Raw audio is ordinarily discarded. Enabling this conspicuous exception
        records only this active Telephone Session and deletes it within 24 hours.
        Subagents cannot enable or use it.
      </p>
      <button
        disabled={props.busy}
        onClick={() => void props.onEnable(props.sessionId)}
      >
        Enable for this session after Fresh Passkey Action
      </button>
    </section>
  );
}

function formatUsd(microusd: number): string {
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(microusd / 1_000_000);
}

function NotificationPreferenceControl(props: {
  busy: boolean;
  onUpdate(input: NotificationPreferenceInput): Promise<void>;
  preference?: NotificationPreference | undefined;
}) {
  const [email, setEmail] = useState(props.preference?.email ?? "");
  const [from, setFrom] = useState(props.preference?.from ?? "");
  const [notificationSubdomain, setNotificationSubdomain] = useState(
    props.preference?.notificationSubdomain ?? "notify.stephens.page",
  );
  return (
    <section className="bountywell-control" aria-labelledby="notification-heading">
      <p className="eyebrow">Completion channel</p>
      <h2 id="notification-heading">Silent Notifications</h2>
      <p>
        A Fresh Passkey Action is required to change the destination or sender.
        Open and click tracking are always disabled.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.onUpdate({ email, from, notificationSubdomain });
        }}
      >
        <label>
          Owner email
          <input
            autoComplete="email"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Sender identity
          <input
            autoComplete="off"
            placeholder="Voice Agent <tasks@notify.stephens.page>"
            required
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          Verified notification subdomain
          <input
            autoComplete="off"
            pattern="[a-z0-9.-]+"
            required
            value={notificationSubdomain}
            onChange={(event) => setNotificationSubdomain(event.target.value)}
          />
        </label>
        <button disabled={props.busy}>Save Silent Notification preference</button>
      </form>
    </section>
  );
}

function TelephoneRegistrationControl(props: {
  busy: boolean;
  onRegister(input: RegisteredTelephoneInput): Promise<void>;
  registration?: RegisteredTelephone | undefined;
}) {
  const [telephoneNumber, setTelephoneNumber] = useState(
    props.registration?.telephoneNumber ?? "",
  );
  const [telnyxNumber, setTelnyxNumber] = useState(
    props.registration?.telnyxNumber ?? "",
  );
  const [livekitInboundTrunkId, setLivekitInboundTrunkId] = useState(
    props.registration?.livekitInboundTrunkId ?? "",
  );
  const [livekitOutboundTrunkId, setLivekitOutboundTrunkId] = useState(
    props.registration?.livekitOutboundTrunkId ?? "",
  );
  return (
    <section className="bountywell-control" aria-labelledby="telephone-heading">
      <p className="eyebrow">Telephone authority</p>
      <h2 id="telephone-heading">Registered Telephone</h2>
      {props.registration === undefined ? (
        <p>
          Perform a Fresh Passkey Action, then enroll the owner telephone and
          its fixed Telnyx-to-LiveKit route.
        </p>
      ) : (
        <p>
          Revision {props.registration.revision} authorizes callbacks only to{" "}
          <strong>{props.registration.telephoneNumber}</strong>.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.onRegister({
            livekitInboundTrunkId,
            livekitOutboundTrunkId,
            telephoneNumber,
            telnyxNumber,
          });
        }}
      >
        <label>
          Owner telephone (E.164)
          <input
            autoComplete="off"
            inputMode="tel"
            pattern="\+[1-9][0-9]{7,14}"
            required
            spellCheck={false}
            value={telephoneNumber}
            onChange={(event) =>
              setTelephoneNumber(normalizeOwnerTelephoneInput(event.target.value))
            }
          />
        </label>
        <label>
          Dedicated Telnyx number (E.164)
          <input
            autoComplete="off"
            pattern="\+[1-9][0-9]{7,14}"
            required
            value={telnyxNumber}
            onChange={(event) => setTelnyxNumber(event.target.value)}
          />
        </label>
        <label>
          LiveKit inbound trunk ID
          <input
            autoComplete="off"
            required
            value={livekitInboundTrunkId}
            onChange={(event) => setLivekitInboundTrunkId(event.target.value)}
          />
        </label>
        <label>
          LiveKit outbound trunk ID
          <input
            autoComplete="off"
            required
            value={livekitOutboundTrunkId}
            onChange={(event) => setLivekitOutboundTrunkId(event.target.value)}
          />
        </label>
        <button disabled={props.busy}>
          {props.registration === undefined
            ? "Enroll Registered Telephone"
            : "Save Registered Telephone revision"}
        </button>
      </form>
    </section>
  );
}

export function ActionFooter({
  busy,
  onAuthorizeDeploymentAuthorityUpgrade,
  onFresh,
  onResumePromotions,
}: {
  busy: boolean;
  onAuthorizeDeploymentAuthorityUpgrade(): Promise<void>;
  onFresh(): Promise<void>;
  onResumePromotions(): Promise<void>;
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
      <button
        className="quiet"
        disabled={busy}
        onClick={() => void onAuthorizeDeploymentAuthorityUpgrade()}
      >
        Create deployment-authority Fresh Passkey proof
      </button>
      <button
        className="quiet"
        disabled={busy}
        onClick={() => void onResumePromotions()}
      >
        Resume Promotion queue after review
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
