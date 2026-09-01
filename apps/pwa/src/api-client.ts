import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import {
  authenticationStatusSchema,
  administrativeAutonomyStatusSchema,
  administrativePolicyStatusSchema,
  authorizeRawAudioDebugResultSchema,
  bountywellOutageInjectionSchema,
  bountywellRecoveryTimerProofSchema,
  bountywellRecoveryTimerSchema,
  bountywellRegistrationSchema,
  bountywellRegistrationStatusSchema,
  evidenceRecordProjectionSchema,
  evidenceRetentionResultSchema,
  evidenceRecordSummaryListSchema,
  freshPasskeyActionResponseSchema,
  keeploreDeploymentContractSchema,
  keeploreLiveInspectionSchema,
  keeploreRegistrationSchema,
  keeploreRegistrationStatusSchema,
  changeTelephoneSpendingCeilingResultSchema,
  deploymentAuthorityUpgradeOptionsSchema,
  deploymentAuthorityUpgradeResponseSchema,
  notificationPreferenceSchema,
  notificationPreferenceStatusSchema,
  passkeyEnrollmentResultSchema,
  promotionResumeResponseSchema,
  recoverySessionResponseSchema,
  trustedBrowserSessionResponseSchema,
  voiceAgentEvidenceRecordProjectionSchema,
  registeredTelephoneSchema,
  registeredTelephoneStatusSchema,
  telephoneBoundaryStatusSchema,
  webAuthnOptionsSchema,
  type AuthenticationStatus,
  type AdministrativeAutonomyStatus,
  type AdministrativePolicyStatus,
  type TelephoneBoundaryStatus,
  type BountywellOutageInjection,
  type BountywellRecoveryTimer,
  type BountywellRecoveryTimerProof,
  type BountywellRegistration,
  type EvidenceRecordProjection,
  type KeeploreDeploymentContract,
  type KeeploreLiveInspection,
  type KeeploreRegistration,
  type KeeploreWorkingTreeReconciliation,
  type EvidenceRecordSummary,
  type PasskeyEnrollmentResult,
  type NotificationPreference,
  type NotificationPreferenceInput,
  type RecoverySessionResponse,
  type TrustedBrowserSessionResponse,
  type VoiceAgentEvidenceRecordProjection,
  type RegisteredTelephone,
  type RegisteredTelephoneInput,
} from "@voice-agent/contracts";

import { describeRequestFailure } from "./request-failure.ts";

const csrfCookieName = "__Host-voice_agent_csrf";

export type ProtectedContent =
  | { readonly kind: "authentication-required" }
  | { readonly kind: "record"; readonly record: VoiceAgentEvidenceRecordProjection }
  | { readonly kind: "tasks"; readonly tasks: readonly EvidenceRecordSummary[] };

export async function loadAuthenticationStatus(): Promise<AuthenticationStatus> {
  const response = await fetch("/api/auth/status");
  if (!response.ok) throw new Error("Authentication status is unavailable.");
  return authenticationStatusSchema.parse(await response.json());
}

export async function loadAdministrativeAutonomyStatus(): Promise<
  AdministrativeAutonomyStatus | undefined
> {
  const response = await fetch("/api/administrative-autonomy");
  if (response.status === 401) return undefined;
  if (!response.ok) {
    throw new Error("Administrative Autonomy policy state is unavailable.");
  }
  return administrativeAutonomyStatusSchema.parse(await response.json());
}

export async function activateAdministrativePolicy(
  csrfToken: string,
  expectedActiveRevision: number | null,
): Promise<AdministrativePolicyStatus> {
  const response = await fetch("/api/administrative-autonomy/activate", {
    body: JSON.stringify({ csrfToken, expectedActiveRevision }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before activating Administrative Autonomy."
        : await denialReason(
            response,
            "Administrative Autonomy could not be activated.",
          ),
    );
  }
  return administrativePolicyStatusSchema.parse(await response.json());
}

export async function loadBountywellRegistration(): Promise<
  BountywellRegistration | undefined
> {
  const response = await fetch("/api/applications/bountywell");
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error("Bountywell registration is unavailable.");
  const result = bountywellRegistrationStatusSchema.parse(await response.json());
  return result.registration ?? undefined;
}

export async function grantBountywellRestart(
  csrfToken: string,
): Promise<BountywellRegistration> {
  const response = await fetch("/api/applications/bountywell/restart-authority", {
    body: JSON.stringify({ csrfToken }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before granting Bountywell restart authority."
        : "Bountywell restart authority could not be granted.",
    );
  }
  return bountywellRegistrationSchema.parse(await response.json());
}

export async function loadKeeploreRegistration(): Promise<
  KeeploreRegistration | undefined
> {
  const response = await fetch("/api/applications/keeplore");
  if (response.status === 401 || response.status === 404) return undefined;
  if (!response.ok) throw new Error("Keeplore registration is unavailable.");
  const result = keeploreRegistrationStatusSchema.parse(await response.json());
  return result.registration ?? undefined;
}

export async function loadKeeploreLiveInspection(): Promise<
  KeeploreLiveInspection | undefined
> {
  const response = await fetch("/api/applications/keeplore/live-inspection");
  if (response.status === 401 || response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error("The read-only Keeplore inspection is unavailable.");
  }
  return keeploreLiveInspectionSchema.parse(await response.json());
}

export async function enrollKeeplore(
  csrfToken: string,
  reconciliation: KeeploreWorkingTreeReconciliation,
): Promise<KeeploreRegistration> {
  const response = await fetch("/api/applications/keeplore/registration", {
    body: JSON.stringify({ csrfToken, reconciliation }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? await denialReason(
            response,
            "Perform a Fresh Passkey Action before enrolling Keeplore.",
          )
        : "Keeplore could not be enrolled.",
    );
  }
  return keeploreRegistrationSchema.parse(await response.json());
}

export async function activateKeeploreDeploymentContract(
  csrfToken: string,
  input: {
    readonly buildCommand: string;
    readonly health: KeeploreDeploymentContract["health"];
    readonly preflightCommand: string;
    readonly releaseRoot: string;
    readonly retainedReleases: number;
    readonly revision: number;
  },
): Promise<KeeploreDeploymentContract> {
  const response = await fetch("/api/applications/keeplore/deployment-contract", {
    body: JSON.stringify({ ...input, csrfToken }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? await denialReason(
            response,
            "Perform a Fresh Passkey Action before activating the Deployment Contract.",
          )
        : "The Keeplore Deployment Contract could not be activated.",
    );
  }
  return keeploreDeploymentContractSchema.parse(await response.json());
}

async function denialReason(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export async function armBountywellRecoveryTimer(
  csrfToken: string,
): Promise<BountywellRecoveryTimer> {
  const response = await fetch("/api/operations/bountywell-outage-drill/arm-timer", {
    body: JSON.stringify({ csrfToken }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Sign in again to restore your Trusted Browser Session before arming the recovery timer."
        : "The recovery timer could not be armed.",
    );
  }
  return bountywellRecoveryTimerSchema.parse(await response.json());
}

export async function proveBountywellRecoveryTimer(
  csrfToken: string,
): Promise<BountywellRecoveryTimerProof> {
  const response = await fetch(
    "/api/operations/bountywell-outage-drill/prove-timer",
    {
      body: JSON.stringify({ csrfToken }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Sign in again to restore your Trusted Browser Session before proving the recovery timer."
        : "The recovery timer could not be proven.",
    );
  }
  return bountywellRecoveryTimerProofSchema.parse(await response.json());
}

export async function injectBountywellOutage(
  csrfToken: string,
): Promise<BountywellOutageInjection> {
  const response = await fetch("/api/operations/bountywell-outage-drill/inject", {
    body: JSON.stringify({ csrfToken, ownerAvailable: true }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 400
        ? "The live drill occurs only while the owner is available on a Telephone Session."
        : "The guarded Bountywell outage drill could not be started.",
    );
  }
  return bountywellOutageInjectionSchema.parse(await response.json());
}

export async function presentBountywellOutage(
  csrfToken: string,
): Promise<BountywellOutageInjection> {
  const response = await fetch(
    "/api/operations/bountywell-outage-drill/present",
    {
      body: JSON.stringify({ csrfToken }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "Start the guarded drill before presenting its fault report."
        : "The fault report could not be presented to the Voice Agent.",
    );
  }
  return bountywellOutageInjectionSchema.parse(await response.json());
}

export async function registerBountywell(
  csrfToken: string,
): Promise<BountywellRegistration> {
  const response = await fetch("/api/applications/bountywell/registration", {
    body: JSON.stringify({ csrfToken }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before registering Bountywell."
        : "Bountywell registration could not be completed.",
    );
  }
  return bountywellRegistrationSchema.parse(await response.json());
}

export async function loadRegisteredTelephone(): Promise<
  RegisteredTelephone | undefined
> {
  const response = await fetch("/api/telephone/registration");
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error("Registered Telephone is unavailable.");
  const result = registeredTelephoneStatusSchema.parse(await response.json());
  return result.registration ?? undefined;
}

export async function loadTelephoneBoundaryStatus(): Promise<
  TelephoneBoundaryStatus | undefined
> {
  const response = await fetch("/api/telephone/boundaries");
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error("Telephone boundary status is unavailable.");
  return telephoneBoundaryStatusSchema.parse(await response.json());
}

export async function changeTelephoneSpendingCeiling(
  csrfToken: string,
  ceilingMicrousd: number,
) {
  const response = await fetch("/api/telephone/spending-ceiling", {
    body: JSON.stringify({ ceilingMicrousd, csrfToken }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before changing the spending ceiling."
        : "The spending ceiling could not be changed.",
    );
  }
  return changeTelephoneSpendingCeilingResultSchema.parse(await response.json());
}

export async function authorizeRawAudioDebug(
  csrfToken: string,
  sessionId: string,
) {
  const response = await fetch(
    `/api/telephone/sessions/${encodeURIComponent(sessionId)}/raw-audio-debug`,
    {
      body: JSON.stringify({ csrfToken }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before enabling raw-audio debugging."
        : "Raw-audio debugging was not enabled for this active session.",
    );
  }
  return authorizeRawAudioDebugResultSchema.parse(await response.json());
}

export async function registerTelephone(
  csrfToken: string,
  input: RegisteredTelephoneInput,
): Promise<RegisteredTelephone> {
  const response = await fetch("/api/telephone/registration", {
    body: JSON.stringify({ csrfToken, ...input }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before changing the Registered Telephone."
        : "The Registered Telephone could not be saved.",
    );
  }
  return registeredTelephoneSchema.parse(await response.json());
}

export async function loadNotificationPreference(): Promise<
  NotificationPreference | undefined
> {
  const response = await fetch("/api/notifications/preference");
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error("Notification preference is unavailable.");
  const result = notificationPreferenceStatusSchema.parse(await response.json());
  return result.preference ?? undefined;
}

export async function updateNotificationPreference(
  csrfToken: string,
  input: NotificationPreferenceInput,
): Promise<NotificationPreference> {
  const response = await fetch("/api/notifications/preference", {
    body: JSON.stringify({ csrfToken, ...input }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before changing notifications."
        : "The notification preference could not be saved.",
    );
  }
  return notificationPreferenceSchema.parse(await response.json());
}

export async function applyEvidenceLifecyclePolicy(
  csrfToken: string,
): Promise<{ readonly cutoff: string }> {
  const response = await fetch("/api/evidence/retention", {
    body: JSON.stringify({ csrfToken }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Perform a Fresh Passkey Action before applying Evidence retention."
        : "Evidence retention could not be applied.",
    );
  }
  return evidenceRetentionResultSchema.parse(await response.json());
}

export async function submitBountywellHealthInquiry(
  csrfToken: string,
  requestId: string,
): Promise<EvidenceRecordProjection> {
  const response = await fetch("/api/tasks/bountywell-health", {
    body: JSON.stringify({ csrfToken, requestId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "Register Bountywell before running an inquiry."
        : "The Bountywell inquiry could not be accepted.",
    );
  }
  return evidenceRecordProjectionSchema.parse(await response.json());
}

export async function loadProtectedContent(
  taskId: string | null,
): Promise<ProtectedContent> {
  const response = await fetch(
    taskId === null
      ? "/api/tasks"
      : `/api/tasks/${encodeURIComponent(taskId)}`,
  );
  if (response.status === 401) return { kind: "authentication-required" };
  if (!response.ok) throw new Error("Live task information could not be loaded.");
  return taskId === null
    ? {
        kind: "tasks",
        tasks: evidenceRecordSummaryListSchema.parse(await response.json()),
      }
    : {
        kind: "record",
        record: parseEvidenceRecord(await response.json()),
      };
}

function parseEvidenceRecord(value: unknown): VoiceAgentEvidenceRecordProjection {
  return voiceAgentEvidenceRecordProjectionSchema.parse(value);
}

export async function enrollBootstrapPasskey(
  bootstrapCode: string,
  label: string,
): Promise<PasskeyEnrollmentResult> {
  return enrollPasskey({ bootstrapCode, label, mode: "bootstrap" });
}

export async function enrollReplacementPasskey(
  csrfToken: string,
  label: string,
): Promise<PasskeyEnrollmentResult> {
  return enrollPasskey({ csrfToken, label, mode: "recovery" });
}

export async function loginWithPasskey(): Promise<TrustedBrowserSessionResponse> {
  const options = await postJson(
    "/api/auth/login/options",
    {},
    authenticationOptions,
  );
  const response = await startAuthentication({ optionsJSON: options });
  return postJson(
    "/api/auth/login/verify",
    { ceremonyId: options.challenge, response },
    trustedBrowserSessionResponseSchema,
  );
}

export function startRecovery(
  recoveryCode: string,
): Promise<RecoverySessionResponse> {
  return postJson(
    "/api/auth/recovery",
    { recoveryCode },
    recoverySessionResponseSchema,
  );
}

export function confirmRecoveryCodes(input: {
  readonly confirmationToken: string;
}): Promise<AuthenticationStatus> {
  return postJson(
    "/api/auth/recovery-codes/confirm",
    input,
    authenticationStatusSchema,
  );
}

export async function performFreshPasskeyAction(
  csrfToken: string,
): Promise<{ readonly freshUntil: string }> {
  const options = await postJson(
    "/api/auth/fresh/options",
    { csrfToken },
    authenticationOptions,
  );
  const response = await startAuthentication({ optionsJSON: options });
  return postJson(
    "/api/auth/fresh/verify",
    { ceremonyId: options.challenge, response },
    freshPasskeyActionResponseSchema,
  );
}

export function resumePromotionQueue(
  csrfToken: string,
): Promise<{ readonly commit: string; readonly status: "queued" }> {
  return postJson(
    "/api/operations/promotions/resume",
    { csrfToken },
    promotionResumeResponseSchema,
  );
}

export async function authorizeDeploymentAuthorityUpgrade(
  csrfToken: string,
): Promise<{ readonly commit: string; readonly status: "submitted" }> {
  const authorization = await postJson(
    "/api/operations/deployment-authority/upgrade-authorization/options",
    { csrfToken },
    deploymentAuthorityUpgradeOptionsSchema,
  );
  const response = await startAuthentication({
    optionsJSON: authorization.options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  return postJson(
    "/api/operations/deployment-authority/upgrade-authorization/verify",
    { ceremonyId: authorization.options.challenge, response },
    deploymentAuthorityUpgradeResponseSchema,
  );
}

export function readCsrfCookie(): string | undefined {
  const prefix = `${csrfCookieName}=`;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  return value === undefined ? undefined : decodeURIComponent(value);
}

async function enrollPasskey(body: unknown): Promise<PasskeyEnrollmentResult> {
  const options = await postJson(
    "/api/auth/registration/options",
    body,
    registrationOptions,
  );
  const response = await startRegistration({ optionsJSON: options });
  return postJson(
    "/api/auth/registration/verify",
    { response },
    passkeyEnrollmentResultSchema,
  );
}

interface Parser<T> {
  parse(value: unknown): T;
}

const registrationOptions: Parser<PublicKeyCredentialCreationOptionsJSON> = {
  parse(value) {
    return webAuthnOptionsSchema.parse(
      value,
    ) as unknown as PublicKeyCredentialCreationOptionsJSON;
  },
};

const authenticationOptions: Parser<PublicKeyCredentialRequestOptionsJSON> = {
  parse(value) {
    return webAuthnOptionsSchema.parse(
      value,
    ) as unknown as PublicKeyCredentialRequestOptionsJSON;
  },
};

async function postJson<T>(
  url: string,
  body: unknown,
  parser: Parser<T>,
): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      describeRequestFailure(
        response.status,
        await readOptionalJson(response),
        "Authentication could not be completed.",
      ),
    );
  }
  return parser.parse(await response.json());
}

async function readOptionalJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
