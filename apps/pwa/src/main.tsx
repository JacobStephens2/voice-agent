import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import {
  type AuthenticationStatus,
  type AdministrativeAutonomyStatus,
  type BountywellRegistration,
  type KeeploreLiveInspection,
  type KeeploreRegistration,
  type KeeploreWorkingTreeReconciliation,
  type RegisteredTelephone,
  type RegisteredTelephoneInput,
  type TelephoneBoundaryStatus,
  type NotificationPreference,
  type NotificationPreferenceInput,
  type VoiceAgentEvidenceRecordProjection,
  type EvidenceRecordSummary,
} from "@voice-agent/contracts";
import {
  applyEvidenceLifecyclePolicy,
  activateAdministrativePolicy,
  authorizeDeploymentAuthorityUpgrade,
  authorizeRawAudioDebug,
  changeTelephoneSpendingCeiling,
  confirmRecoveryCodes,
  enrollBootstrapPasskey,
  enrollReplacementPasskey,
  loadAuthenticationStatus,
  loadAdministrativeAutonomyStatus,
  loadBountywellRegistration,
  loadRegisteredTelephone,
  loadTelephoneBoundaryStatus,
  loadNotificationPreference,
  loadProtectedContent as fetchProtectedContent,
  loginWithPasskey,
  performFreshPasskeyAction as requestFreshPasskeyAction,
  readCsrfCookie,
  activateKeeploreDeploymentContract,
  armBountywellRecoveryTimer,
  enrollKeeplore,
  grantBountywellRestart,
  loadKeeploreLiveInspection,
  loadKeeploreRegistration,
  injectBountywellOutage,
  presentBountywellOutage,
  proveBountywellRecoveryTimer,
  registerBountywell,
  registerTelephone,
  resumePromotionQueue,
  startRecovery,
  submitBountywellHealthInquiry,
  updateNotificationPreference,
} from "./api-client.ts";
import {
  ActionFooter,
  formatTime,
  LoginView,
  OfflineView,
  RecoveryCodesView,
  ReplacementView,
  SetupView,
  Shell,
  RawAudioDebugControl,
  TaskList,
} from "./auth-views.tsx";
import { EvidenceRecordPage } from "./evidence-record-page.tsx";
import { ThemeControl } from "./theme-control.tsx";
import "./styles.css";

registerSW({ immediate: true });

// Keeplore is PHP served from files: a Release is linted rather than built.
const keeploreReleaseLintCommand =
  "find . -name '*.php' -not -path './vendor/*' -print0 | xargs -0 -r -n1 php -l";

const pendingBountywellRequestIdKey =
  "voice-agent.pending-bountywell-inquiry-request-id";

function App() {
  const [status, setStatus] = useState<AuthenticationStatus>();
  const [administrativeAutonomy, setAdministrativeAutonomy] =
    useState<AdministrativeAutonomyStatus>();
  const [tasks, setTasks] = useState<readonly EvidenceRecordSummary[]>();
  const [record, setRecord] = useState<VoiceAgentEvidenceRecordProjection>();
  const [bountywellRegistration, setBountywellRegistration] =
    useState<BountywellRegistration>();
  const [registeredTelephone, setRegisteredTelephone] =
    useState<RegisteredTelephone>();
  const [telephoneRegistrationLoaded, setTelephoneRegistrationLoaded] =
    useState(false);
  const [telephoneBoundaries, setTelephoneBoundaries] =
    useState<TelephoneBoundaryStatus>();
  const [notificationPreference, setNotificationPreference] =
    useState<NotificationPreference>();
  const [keeploreRegistration, setKeeploreRegistration] =
    useState<KeeploreRegistration>();
  const [keeploreInspection, setKeeploreInspection] =
    useState<KeeploreLiveInspection>();
  const [csrfToken, setCsrfToken] = useState<string | undefined>(readCsrfCookie);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState<{
    readonly codes: readonly string[];
    readonly token: string;
  }>();
  const [offline, setOffline] = useState(!navigator.onLine);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingBountywellRequestId, setPendingBountywellRequestId] =
    useState(readPendingBountywellRequestId);

  const loadProtectedContent = useCallback(async () => {
    const taskId = new URLSearchParams(window.location.search).get("task");
    const content = await fetchProtectedContent(taskId);
    if (content.kind === "authentication-required") {
      setTasks(undefined);
      setRecord(undefined);
      setTelephoneRegistrationLoaded(false);
      return false;
    }
    if (content.kind === "tasks") {
      setTasks(content.tasks);
      setRecord(undefined);
      const [administrative, bountywell, telephone, notification, boundaries] =
        await Promise.all([
          loadAdministrativeAutonomyStatus(),
          loadBountywellRegistration(),
          loadRegisteredTelephone(),
          loadNotificationPreference(),
          loadTelephoneBoundaryStatus(),
        ]);
      setAdministrativeAutonomy(administrative);
      setBountywellRegistration(bountywell);
      setRegisteredTelephone(telephone);
      setTelephoneRegistrationLoaded(true);
      setNotificationPreference(notification);
      setTelephoneBoundaries(boundaries);
    } else {
      setRecord(content.record);
      setTasks(undefined);
      setTelephoneRegistrationLoaded(false);
    }
    return true;
  }, []);

  useEffect(() => {
    if (record?.task.status !== "pending") return;
    const timeout = window.setTimeout(() => {
      void fetchProtectedContent(record.task.id).then((content) => {
        if (content.kind === "record") setRecord(content.record);
      });
    }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [record]);

  const refresh = useCallback(async () => {
    try {
      const nextStatus = await loadAuthenticationStatus();
      setStatus(nextStatus);
      if (nextStatus.setup === "ready") await loadProtectedContent();
      setOffline(false);
    } catch (reason) {
      if (!navigator.onLine || reason instanceof TypeError) setOffline(true);
      else setMessage(errorMessage(reason));
    }
  }, [loadProtectedContent]);

  useEffect(() => {
    void refresh();
    const wentOffline = () => setOffline(true);
    const cameOnline = () => {
      setOffline(false);
      void refresh();
    };
    window.addEventListener("offline", wentOffline);
    window.addEventListener("online", cameOnline);
    return () => {
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener("online", cameOnline);
    };
  }, [refresh]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      await action();
    } catch (reason) {
      if (!navigator.onLine || reason instanceof TypeError) setOffline(true);
      else setMessage(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function enrollBootstrap(bootstrapCode: string, label: string) {
    await run(async () => {
      const result = await enrollBootstrapPasskey(bootstrapCode, label);
      if (
        result.recoveryCodes.length > 0 &&
        result.recoveryConfirmationToken !== undefined
      ) {
        setRecoveryConfirmation({
          codes: result.recoveryCodes,
          token: result.recoveryConfirmationToken,
        });
      }
      setStatus(result.status);
      setMessage(
        result.status.setup === "recovery-confirmation-required"
          ? "Both passkeys are enrolled. Save the Recovery Codes before continuing."
          : "First passkey enrolled. Generate a new Bootstrap Code for the second passkey.",
      );
    });
  }

  async function login() {
    await run(async () => {
      const session = await loginWithPasskey();
      setCsrfToken(session.csrfToken);
      await loadProtectedContent();
    });
  }

  async function recover(recoveryCode: string) {
    await run(async () => {
      const session = await startRecovery(recoveryCode);
      setCsrfToken(session.csrfToken);
      setMessage("Recovery accepted. Enroll one replacement passkey now.");
    });
  }

  async function enrollReplacement(label: string) {
    if (csrfToken === undefined) return;
    await run(async () => {
      await enrollReplacementPasskey(csrfToken, label);
      setCsrfToken(undefined);
      setMessage("Replacement passkey enrolled. Sign in with a passkey to continue.");
    });
  }

  async function freshPasskeyAction() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before requesting a Fresh Passkey Action.");
      return;
    }
    await run(async () => {
      const result = await requestFreshPasskeyAction(csrfToken);
      setMessage(`Fresh Passkey Action valid until ${formatTime(result.freshUntil)}.`);
    });
  }

  async function enrollBountywell() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before registering Bountywell.");
      return;
    }
    await run(async () => {
      setBountywellRegistration(await registerBountywell(csrfToken));
      setMessage("Bountywell read-only access is registered.");
    });
  }

  async function activateAdministrativeAutonomy() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before activating Administrative Autonomy.");
      return;
    }
    await run(async () => {
      const expectedActiveRevision =
        administrativeAutonomy === undefined ||
        administrativeAutonomy.policy.status === "inactive"
          ? null
          : administrativeAutonomy.policy.revision;
      const activated = await activateAdministrativePolicy(
        csrfToken,
        expectedActiveRevision,
        administrativeAutonomy?.policy.stateVersion ?? 0,
      );
      setAdministrativeAutonomy((current) => ({
        policy: activated,
        taskExecution: current?.taskExecution ?? {
          reason:
            "Typed administrative task execution adapters are not configured.",
          status: "unavailable",
        },
      }));
      if (activated.status !== "active") {
        throw new Error("Administrative Autonomy did not become active.");
      }
      setMessage(
        `Administrative Autonomy Policy revision ${activated.revision} is active.`,
      );
    });
  }

  async function grantRestart() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before granting Bountywell restart authority.");
      return;
    }
    await run(async () => {
      setBountywellRegistration(await grantBountywellRestart(csrfToken));
      setMessage("Bountywell restart authority is enrolled for bountywell-api.service.");
    });
  }

  async function armTimer() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before arming the recovery timer.");
      return;
    }
    await run(async () => {
      await armBountywellRecoveryTimer(csrfToken);
      setMessage("Independent recovery timer armed for bountywell-api.service.");
    });
  }

  async function proveTimer() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before proving the recovery timer.");
      return;
    }
    await run(async () => {
      await proveBountywellRecoveryTimer(csrfToken);
      setMessage("Recovery timer was proven capable of starting bountywell-api.service.");
    });
  }

  async function startOutageDrill() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before starting the guarded drill.");
      return;
    }
    await run(async () => {
      // The drill controller stops the registered unit, then hands the Voice
      // Agent the one sentence it is told about the fault.
      await injectBountywellOutage(csrfToken);
      await presentOutageReport();
    });
  }

  async function presentOutageReport() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before presenting the fault report.");
      return;
    }
    const presented = await presentBountywellOutage(csrfToken);
    window.location.assign(`/?task=${encodeURIComponent(presented.taskId)}`);
  }

  async function inspectKeeplore() {
    await run(async () => {
      const inspection = await loadKeeploreLiveInspection();
      setKeeploreInspection(inspection);
      setKeeploreRegistration(await loadKeeploreRegistration());
      setMessage(
        inspection === undefined
          ? "This Agent Host holds no root-owned Keeplore registration yet."
          : "The live Keeplore checkout was inspected read-only.",
      );
    });
  }

  async function onboardKeeplore(
    reconciliation: KeeploreWorkingTreeReconciliation,
  ) {
    if (csrfToken === undefined) {
      setMessage("Sign in again before enrolling Keeplore.");
      return;
    }
    await run(async () => {
      setKeeploreRegistration(await enrollKeeplore(csrfToken, reconciliation));
      setMessage("Keeplore is enrolled with its fixed repository and boundaries.");
    });
  }

  async function activateKeeploreContract() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before activating the Deployment Contract.");
      return;
    }
    const registration = keeploreRegistration;
    if (registration === undefined) {
      setMessage("Enroll Keeplore before activating its Deployment Contract.");
      return;
    }
    await run(async () => {
      const contract = await activateKeeploreDeploymentContract(csrfToken, {
        buildCommand: keeploreReleaseLintCommand,
        health: { expectedStatus: 200, path: "/api/health" },
        preflightCommand: keeploreReleaseLintCommand,
        releaseRoot: registration.deploymentBoundaries.releaseRoot,
        retainedReleases: registration.deploymentBoundaries.retainedReleases,
        revision: 1,
      });
      setMessage(
        `Keeplore Deployment Contract revision ${contract.revision} is active.`,
      );
    });
  }

  async function enrollTelephone(input: RegisteredTelephoneInput) {
    if (csrfToken === undefined) {
      setMessage("Sign in again before changing the Registered Telephone.");
      return;
    }
    await run(async () => {
      setRegisteredTelephone(await registerTelephone(csrfToken, input));
      setMessage("Registered Telephone and Telnyx-to-LiveKit route saved.");
    });
  }

  async function saveNotificationPreference(input: NotificationPreferenceInput) {
    if (csrfToken === undefined) {
      setMessage("Sign in again before changing notifications.");
      return;
    }
    await run(async () => {
      setNotificationPreference(
        await updateNotificationPreference(csrfToken, input),
      );
      setMessage("Silent Notification identity and destination saved.");
    });
  }

  async function saveSpendingCeiling(ceilingMicrousd: number) {
    if (csrfToken === undefined) {
      setMessage("Sign in again before changing the spending ceiling.");
      return;
    }
    await run(async () => {
      await changeTelephoneSpendingCeiling(csrfToken, ceilingMicrousd);
      setTelephoneBoundaries(await loadTelephoneBoundaryStatus());
      setMessage("Monthly paid-provider spending ceiling updated.");
    });
  }

  async function enableRawAudioDebug(sessionId: string) {
    if (csrfToken === undefined) {
      setMessage("Sign in again before enabling raw-audio debugging.");
      return;
    }
    await run(async () => {
      const result = await authorizeRawAudioDebug(csrfToken, sessionId);
      setMessage(
        `RAW AUDIO DEBUGGING ENABLED until ${formatTime(result.expiresAt)} for this session only.`,
      );
    });
  }

  async function retainOrdinaryEvidence() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before applying Evidence retention.");
      return;
    }
    await run(async () => {
      const result = await applyEvidenceLifecyclePolicy(csrfToken);
      setMessage(`Ordinary Evidence Events before ${formatTime(result.cutoff)} were removed.`);
      await loadProtectedContent();
    });
  }

  async function resumePromotions() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before resuming Promotions.");
      return;
    }
    await run(async () => {
      const result = await resumePromotionQueue(csrfToken);
      setMessage(
        `Promotion queue resume requested for reviewed commit ${result.commit.slice(0, 12)}.`,
      );
    });
  }

  async function authorizeAuthorityUpgrade() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before authorizing a deployment-authority upgrade.");
      return;
    }
    await run(async () => {
      const result = await authorizeDeploymentAuthorityUpgrade(csrfToken);
      setMessage(
        `Fresh Passkey proof submitted for reviewed deployment-authority commit ${result.commit.slice(0, 12)}; return to the attended terminal verifier.`,
      );
    });
  }

  async function runBountywellInquiry() {
    if (csrfToken === undefined) {
      setMessage("Sign in again before running an inquiry.");
      return;
    }
    await run(async () => {
      const requestId = pendingBountywellRequestId ?? crypto.randomUUID();
      if (pendingBountywellRequestId === undefined) {
        setPendingBountywellRequestId(requestId);
        writePendingBountywellRequestId(requestId);
      }
      const accepted = await submitBountywellHealthInquiry(
        csrfToken,
        requestId,
      );
      setPendingBountywellRequestId(undefined);
      clearPendingBountywellRequestId(requestId);
      window.history.replaceState(null, "", `/?task=${encodeURIComponent(accepted.task.id)}`);
      setRecord(accepted);
      setTasks(undefined);
    });
  }

  if (offline) return <OfflineView />;
  if (status === undefined) return <Shell message={message}>Checking authentication…</Shell>;
  if (recoveryConfirmation !== undefined) {
    return (
      <RecoveryCodesView
        busy={busy}
        codes={recoveryConfirmation.codes}
        onConfirm={() =>
          run(async () => {
            const nextStatus = await confirmRecoveryCodes({
              confirmationToken: recoveryConfirmation.token,
            });
            setStatus(nextStatus);
            setRecoveryConfirmation(undefined);
            setMessage("Recovery Codes confirmed. Sign in with a passkey to continue.");
          })
        }
      />
    );
  }
  if (status.setup !== "ready") {
    return (
      <SetupView
        busy={busy}
        message={message}
        passkeyCount={status.passkeyCount}
        recoveryConfirmationRequired={
          status.setup === "recovery-confirmation-required"
        }
        onEnroll={enrollBootstrap}
      />
    );
  }
  if (csrfToken !== undefined && tasks === undefined && record === undefined) {
    return (
      <ReplacementView
        busy={busy}
        message={message}
        onEnroll={enrollReplacement}
      />
    );
  }
  if (tasks === undefined && record === undefined) {
    return (
      <LoginView
        busy={busy}
        message={message}
        onLogin={login}
        onRecover={recover}
      />
    );
  }
  if (record !== undefined) {
    const rawAudioSessionId =
      record.task.kind === "callback.handshake" &&
      "session" in record &&
      record.session.outcome === "authorized" &&
      record.session.endedAt === undefined
        ? record.session.id
        : undefined;
    return (
      <>
        <EvidenceRecordPage record={record} />
        {rawAudioSessionId === undefined ? null : (
          <RawAudioDebugControl
            busy={busy}
            onEnable={enableRawAudioDebug}
            sessionId={rawAudioSessionId}
          />
        )}
        <ActionFooter
          busy={busy}
          onAuthorizeDeploymentAuthorityUpgrade={authorizeAuthorityUpgrade}
          onFresh={freshPasskeyAction}
          onResumePromotions={resumePromotions}
        />
      </>
    );
  }
  return (
    <TaskList
      administrativeAutonomy={administrativeAutonomy}
      bountywellRegistration={bountywellRegistration}
      registeredTelephone={registeredTelephone}
      telephoneRegistrationLoaded={telephoneRegistrationLoaded}
      telephoneBoundaries={telephoneBoundaries}
      notificationPreference={notificationPreference}
      tasks={tasks ?? []}
      message={message}
      busy={busy}
      onAuthorizeDeploymentAuthorityUpgrade={authorizeAuthorityUpgrade}
      onActivateAdministrativeAutonomy={activateAdministrativeAutonomy}
      onFresh={freshPasskeyAction}
      onApplyEvidenceRetention={retainOrdinaryEvidence}
      onResumePromotions={resumePromotions}
      keeploreInspection={keeploreInspection}
      keeploreRegistration={keeploreRegistration}
      onActivateKeeploreDeploymentContract={activateKeeploreContract}
      onEnrollKeeplore={onboardKeeplore}
      onInspectKeeplore={inspectKeeplore}
      onRegisterBountywell={enrollBountywell}
      onGrantBountywellRestart={grantRestart}
      onArmRecoveryTimer={armTimer}
      onProveRecoveryTimer={proveTimer}
      onPresentOutageReport={() => run(presentOutageReport)}
      onStartOutageDrill={startOutageDrill}
      onRegisterTelephone={enrollTelephone}
      onChangeSpendingCeiling={saveSpendingCeiling}
      onUpdateNotificationPreference={saveNotificationPreference}
      onRunBountywell={runBountywellInquiry}
    />
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The request could not be completed.";
}

function readPendingBountywellRequestId(): string | undefined {
  try {
    return localStorage.getItem(pendingBountywellRequestIdKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function writePendingBountywellRequestId(requestId: string): void {
  try {
    localStorage.setItem(pendingBountywellRequestIdKey, requestId);
  } catch {
    // React state still preserves retry identity for this page lifetime.
  }
}

function clearPendingBountywellRequestId(requestId: string): void {
  try {
    if (localStorage.getItem(pendingBountywellRequestIdKey) === requestId) {
      localStorage.removeItem(pendingBountywellRequestIdKey);
    }
  } catch {
    // Nothing durable remains to clear when storage is unavailable.
  }
}

const root = document.getElementById("root");
if (root === null) throw new Error("PWA root element is missing");
createRoot(root).render(
  <StrictMode>
    <ThemeControl />
    <App />
  </StrictMode>,
);
