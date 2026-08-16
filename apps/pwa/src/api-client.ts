import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import {
  authenticationStatusSchema,
  bountywellRegistrationSchema,
  bountywellRegistrationStatusSchema,
  evidenceRecordProjectionSchema,
  evidenceRecordSummaryListSchema,
  freshPasskeyActionResponseSchema,
  passkeyEnrollmentResultSchema,
  promotionResumeResponseSchema,
  promotionEvidenceRecordProjectionSchema,
  recoverySessionResponseSchema,
  trustedBrowserSessionResponseSchema,
  telephoneSessionEvidenceRecordProjectionSchema,
  registeredTelephoneSchema,
  registeredTelephoneStatusSchema,
  webAuthnOptionsSchema,
  type AuthenticationStatus,
  type BountywellRegistration,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
  type PasskeyEnrollmentResult,
  type RecoverySessionResponse,
  type TrustedBrowserSessionResponse,
  type VoiceAgentEvidenceRecordProjection,
  type RegisteredTelephone,
  type RegisteredTelephoneInput,
} from "@voice-agent/contracts";

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

export async function loadBountywellRegistration(): Promise<
  BountywellRegistration | undefined
> {
  const response = await fetch("/api/applications/bountywell");
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error("Bountywell registration is unavailable.");
  const result = bountywellRegistrationStatusSchema.parse(await response.json());
  return result.registration ?? undefined;
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
  if (
    typeof value === "object" &&
    value !== null &&
    "task" in value &&
    typeof value.task === "object" &&
    value.task !== null &&
    "kind" in value.task
  ) {
    if (value.task.kind === "human-merge.promotion") {
      return promotionEvidenceRecordProjectionSchema.parse(value);
    }
    if (value.task.kind === "callback.handshake") {
      return telephoneSessionEvidenceRecordProjectionSchema.parse(value);
    }
  }
  return evidenceRecordProjectionSchema.parse(value);
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
      response.status === 403
        ? "The request failed its origin or CSRF check."
        : "Authentication could not be completed.",
    );
  }
  return parser.parse(await response.json());
}
