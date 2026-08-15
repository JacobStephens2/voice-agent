import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import {
  authenticationStatusSchema,
  evidenceRecordProjectionSchema,
  evidenceRecordSummaryListSchema,
  freshPasskeyActionResponseSchema,
  passkeyEnrollmentResultSchema,
  recoverySessionResponseSchema,
  trustedBrowserSessionResponseSchema,
  webAuthnOptionsSchema,
  type AuthenticationStatus,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
  type PasskeyEnrollmentResult,
  type RecoverySessionResponse,
  type TrustedBrowserSessionResponse,
} from "@voice-agent/contracts";

const csrfCookieName = "__Host-voice_agent_csrf";

export type ProtectedContent =
  | { readonly kind: "authentication-required" }
  | { readonly kind: "record"; readonly record: EvidenceRecordProjection }
  | { readonly kind: "tasks"; readonly tasks: readonly EvidenceRecordSummary[] };

export async function loadAuthenticationStatus(): Promise<AuthenticationStatus> {
  const response = await fetch("/api/auth/status");
  if (!response.ok) throw new Error("Authentication status is unavailable.");
  return authenticationStatusSchema.parse(await response.json());
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
        record: evidenceRecordProjectionSchema.parse(await response.json()),
      };
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
