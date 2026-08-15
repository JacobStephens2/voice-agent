import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import {
  type AuthenticationStatus,
  type BountywellRegistration,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
} from "@voice-agent/contracts";
import {
  confirmRecoveryCodes,
  enrollBootstrapPasskey,
  enrollReplacementPasskey,
  loadAuthenticationStatus,
  loadBountywellRegistration,
  loadProtectedContent as fetchProtectedContent,
  loginWithPasskey,
  performFreshPasskeyAction as requestFreshPasskeyAction,
  readCsrfCookie,
  registerBountywell,
  resumePromotionQueue,
  startRecovery,
  submitBountywellHealthInquiry,
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
  TaskList,
} from "./auth-views.tsx";
import { TaskPage } from "./task-page.tsx";
import "./styles.css";

registerSW({ immediate: true });

const pendingBountywellRequestIdKey =
  "voice-agent.pending-bountywell-inquiry-request-id";

function App() {
  const [status, setStatus] = useState<AuthenticationStatus>();
  const [tasks, setTasks] = useState<readonly EvidenceRecordSummary[]>();
  const [record, setRecord] = useState<EvidenceRecordProjection>();
  const [bountywellRegistration, setBountywellRegistration] =
    useState<BountywellRegistration>();
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
      return false;
    }
    if (content.kind === "tasks") {
      setTasks(content.tasks);
      setRecord(undefined);
      setBountywellRegistration(await loadBountywellRegistration());
    } else {
      setRecord(content.record);
      setTasks(undefined);
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
    return (
      <>
        <TaskPage record={record} />
        <ActionFooter
          busy={busy}
          onFresh={freshPasskeyAction}
          onResumePromotions={resumePromotions}
        />
      </>
    );
  }
  return (
    <TaskList
      bountywellRegistration={bountywellRegistration}
      tasks={tasks ?? []}
      message={message}
      busy={busy}
      onFresh={freshPasskeyAction}
      onResumePromotions={resumePromotions}
      onRegisterBountywell={enrollBountywell}
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
createRoot(root).render(<StrictMode><App /></StrictMode>);
