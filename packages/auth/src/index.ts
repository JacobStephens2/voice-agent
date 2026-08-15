import { z } from "zod";

import type { AuthenticationStatus } from "@voice-agent/contracts";

export type { AuthenticationStatus } from "@voice-agent/contracts";

export { createNodeAuthenticationSecrets } from "./node-secrets.ts";
export {
  createSimpleWebAuthnPasskeyAdapter,
  type SimpleWebAuthnPasskeyAdapterOptions,
} from "./simple-webauthn.ts";

export interface StoredPasskey {
  readonly backedUp: boolean;
  readonly counter: number;
  readonly credentialId: string;
  readonly deviceType: "singleDevice" | "multiDevice";
  readonly label: string;
  readonly publicKey: string;
  readonly transports: readonly string[];
}

export interface AuthenticationState {
  readonly authenticationChallenges: readonly {
    readonly challenge: string;
    readonly expiresAt: string;
    readonly purpose: "login" | "fresh";
    readonly sessionTokenDigest: string | null;
  }[];
  readonly bootstrap?: {
    readonly expiresAt: string;
    readonly verifier: string;
  } | undefined;
  readonly bootstrapPermanentlyDisabled: boolean;
  readonly ownerUserId: string;
  readonly passkeys: readonly StoredPasskey[];
  readonly recoveryCodeVerifiers: readonly string[];
  readonly recoveryConfirmation?: {
    readonly expiresAt: string;
    readonly pendingVerifiers: readonly string[];
    readonly tokenDigest: string;
  } | undefined;
  readonly sessions: readonly StoredSession[];
  readonly registrationChallenge?: {
    readonly challenge: string;
    readonly expiresAt: string;
    readonly label: string;
    readonly purpose: "bootstrap" | "recovery";
    readonly sessionTokenDigest: string | null;
  } | undefined;
}

export interface StoredSession {
  readonly csrfTokenDigest: string;
  readonly expiresAt: string;
  readonly freshUntil: string | null;
  readonly kind: "recovery" | "trusted";
  readonly sessionTokenDigest: string;
}

export interface AuthenticationSnapshot {
  readonly revision: number;
  readonly state: AuthenticationState;
}

export interface AuthenticationStore {
  close(): Promise<void>;
  read(): Promise<AuthenticationSnapshot | undefined>;
  write(expectedRevision: number, state: AuthenticationState): Promise<void>;
}

export interface AuthenticationSecrets {
  createBootstrapCode(): string;
  createCsrfToken(): string;
  createRecoveryCodes(): readonly string[];
  createRecoveryConfirmationToken(): string;
  createSessionToken(): string;
  digest(token: string): string;
  matches(secret: string, verifier: string): Promise<boolean>;
  protect(secret: string): Promise<string>;
}

export interface PasskeyRegistration {
  readonly backedUp: boolean;
  readonly counter: number;
  readonly credentialId: string;
  readonly deviceType: "singleDevice" | "multiDevice";
  readonly publicKey: string;
  readonly transports: readonly string[];
}

export interface PasskeyAdapter {
  beginAuthentication(input: {
    readonly credentials: readonly StoredPasskey[];
  }): Promise<{ readonly challenge: string; readonly options: unknown }>;
  beginRegistration(input: {
    readonly existingCredentials: readonly {
      readonly credentialId: string;
      readonly transports: readonly string[];
    }[];
    readonly ownerUserId: string;
  }): Promise<{ readonly challenge: string; readonly options: unknown }>;
  finishRegistration(input: {
    readonly expectedChallenge: string;
    readonly response: unknown;
  }): Promise<PasskeyRegistration>;
  finishAuthentication(input: {
    readonly credentials: readonly StoredPasskey[];
    readonly expectedChallenge: string;
    readonly response: unknown;
  }): Promise<{ readonly credentialId: string; readonly newCounter: number }>;
}

export interface AuthenticationLifecycle {
  beginBootstrapRegistration(input: {
    readonly bootstrapCode: string;
    readonly label: string;
  }): Promise<unknown>;
  finishRegistration(input: {
    readonly response: unknown;
    readonly sessionToken?: string;
  }): Promise<PasskeyEnrollmentResult>;
  beginLogin(): Promise<unknown>;
  finishLogin(input: {
    readonly ceremonyId: string;
    readonly response: unknown;
  }): Promise<TrustedBrowserSession>;
  beginFreshPasskeyAction(input: {
    readonly csrfToken: string;
    readonly sessionToken: string;
  }): Promise<unknown>;
  finishFreshPasskeyAction(input: {
    readonly ceremonyId: string;
    readonly response: unknown;
    readonly sessionToken: string;
  }): Promise<{
    readonly freshUntil: string;
  }>;
  beginRecoveryRegistration(input: {
    readonly csrfToken: string;
    readonly label: string;
    readonly sessionToken: string;
  }): Promise<unknown>;
  canChangeState(input: {
    readonly csrfToken: string;
    readonly sessionToken: string;
  }): Promise<boolean>;
  canViewEvidence(sessionToken: string): Promise<boolean>;
  confirmRecoveryCodes(input: {
    readonly confirmationToken: string;
  }): Promise<AuthenticationStatus>;
  hasFreshPasskeyAction(sessionToken: string): Promise<boolean>;
  generateBootstrapCode(): Promise<string>;
  recover(recoveryCode: string): Promise<RecoverySession>;
  status(): Promise<AuthenticationStatus>;
}

export interface PasskeyEnrollmentResult {
  readonly recoveryCodes: readonly string[];
  readonly recoveryConfirmationToken?: string;
  readonly status: AuthenticationStatus;
}

export interface TrustedBrowserSession {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly freshUntil: string | undefined;
  readonly sessionToken: string;
}

export interface RecoverySession {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly sessionToken: string;
}

export interface AuthenticationLifecycleOptions {
  readonly now: () => string;
  readonly ownerUserId: string;
  readonly passkeys: PasskeyAdapter;
  readonly secrets: AuthenticationSecrets;
  readonly store: AuthenticationStore;
}

const BOOTSTRAP_LIFETIME_MS = 10 * 60 * 1_000;
const REGISTRATION_LIFETIME_MS = 5 * 60 * 1_000;
const AUTHENTICATION_LIFETIME_MS = 5 * 60 * 1_000;
const FRESH_PASSKEY_LIFETIME_MS = 5 * 60 * 1_000;
const TRUSTED_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const RECOVERY_SESSION_LIFETIME_MS = 15 * 60 * 1_000;
const RECOVERY_CONFIRMATION_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_ACTIVE_LOGIN_CHALLENGES = 30;
const MAX_ACTIVE_FRESH_PASSKEY_CHALLENGES = 10;
const MAX_ACTIVE_AUTHENTICATION_CHALLENGES =
  MAX_ACTIVE_LOGIN_CHALLENGES + MAX_ACTIVE_FRESH_PASSKEY_CHALLENGES;
const MAX_ACTIVE_SESSIONS = 20;

const timestampSchema = z.iso.datetime();
const storedSessionSchema = z.object({
  csrfTokenDigest: z.string().min(1),
  expiresAt: timestampSchema,
  freshUntil: timestampSchema.nullable(),
  kind: z.enum(["recovery", "trusted"]),
  sessionTokenDigest: z.string().min(1),
});
export const authenticationStateSchema: z.ZodType<AuthenticationState> = z.object({
  authenticationChallenges: z.array(z.object({
    challenge: z.string().min(1),
    expiresAt: timestampSchema,
    purpose: z.enum(["login", "fresh"]),
    sessionTokenDigest: z.string().min(1).nullable(),
  })).max(MAX_ACTIVE_AUTHENTICATION_CHALLENGES),
  bootstrap: z.object({
    expiresAt: timestampSchema,
    verifier: z.string().min(1),
  }).optional(),
  bootstrapPermanentlyDisabled: z.boolean(),
  ownerUserId: z.string().min(1),
  passkeys: z.array(z.object({
    backedUp: z.boolean(),
    counter: z.number().int().nonnegative(),
    credentialId: z.string().min(1),
    deviceType: z.enum(["singleDevice", "multiDevice"]),
    label: z.string().min(1).max(80),
    publicKey: z.string().min(1),
    transports: z.array(z.string()).max(16),
  })).max(20),
  recoveryCodeVerifiers: z.array(z.string().min(1)).max(50),
  recoveryConfirmation: z.object({
    expiresAt: timestampSchema,
    pendingVerifiers: z.array(z.string().min(1)).min(1).max(50),
    tokenDigest: z.string().min(1),
  }).optional(),
  registrationChallenge: z.object({
    challenge: z.string().min(1),
    expiresAt: timestampSchema,
    label: z.string().min(1).max(80),
    purpose: z.enum(["bootstrap", "recovery"]),
    sessionTokenDigest: z.string().min(1).nullable(),
  }).optional(),
  sessions: z.array(storedSessionSchema).max(MAX_ACTIVE_SESSIONS),
});

export function createAuthenticationLifecycle(
  options: AuthenticationLifecycleOptions,
): AuthenticationLifecycle {
  async function readState(): Promise<AuthenticationSnapshot> {
    return (
      (await options.store.read()) ?? {
        revision: 0,
        state: {
          authenticationChallenges: [],
          bootstrapPermanentlyDisabled: false,
          ownerUserId: options.ownerUserId,
          passkeys: [],
          recoveryCodeVerifiers: [],
          sessions: [],
        },
      }
    );
  }

  return {
    async beginLogin() {
      const snapshot = await readState();
      if (!projectStatus(snapshot.state).unattendedAuthorityEnabled) {
        throw new Error("Authentication setup is incomplete");
      }
      const authentication = await options.passkeys.beginAuthentication({
        credentials: snapshot.state.passkeys,
      });
      await options.store.write(snapshot.revision, {
        ...snapshot.state,
        authenticationChallenges: appendActiveAuthenticationChallenge(
          snapshot.state.authenticationChallenges,
          {
            challenge: authentication.challenge,
            expiresAt: plusMilliseconds(
              options.now(),
              AUTHENTICATION_LIFETIME_MS,
            ),
            purpose: "login",
            sessionTokenDigest: null,
          },
          options.now(),
        ),
      });
      return authentication.options;
    },

    async finishLogin(input) {
      const snapshot = await readState();
      const challenge = requireAuthenticationChallenge(
        snapshot.state,
        input.ceremonyId,
        "login",
        options.now(),
      );
      const verification = await options.passkeys.finishAuthentication({
        credentials: snapshot.state.passkeys,
        expectedChallenge: challenge.challenge,
        response: input.response,
      });
      const sessionToken = options.secrets.createSessionToken();
      const csrfToken = options.secrets.createCsrfToken();
      const session: StoredSession = {
        csrfTokenDigest: options.secrets.digest(csrfToken),
        expiresAt: plusMilliseconds(
          options.now(),
          TRUSTED_SESSION_LIFETIME_MS,
        ),
        freshUntil: null,
        kind: "trusted",
        sessionTokenDigest: options.secrets.digest(sessionToken),
      };
      await options.store.write(snapshot.revision, {
        ...withoutAuthenticationChallenge(
          snapshot.state,
          challenge.challenge,
        ),
        passkeys: updatePasskeyCounter(
          snapshot.state.passkeys,
          verification.credentialId,
          verification.newCounter,
        ),
        sessions: appendActiveSession(
          snapshot.state.sessions,
          session,
          options.now(),
        ),
      });
      return {
        csrfToken,
        expiresAt: session.expiresAt,
        freshUntil: undefined,
        sessionToken,
      };
    },

    async beginFreshPasskeyAction(input) {
      const snapshot = await readState();
      const session = findActiveSession(
        snapshot.state,
        options.secrets.digest(input.sessionToken),
        options.now(),
      );
      if (
        session === undefined ||
        session.kind !== "trusted" ||
        session.csrfTokenDigest !== options.secrets.digest(input.csrfToken)
      ) {
        throw new Error("CSRF validation failed");
      }
      const authentication = await options.passkeys.beginAuthentication({
        credentials: snapshot.state.passkeys,
      });
      await options.store.write(snapshot.revision, {
        ...snapshot.state,
        authenticationChallenges: appendActiveAuthenticationChallenge(
          snapshot.state.authenticationChallenges,
          {
            challenge: authentication.challenge,
            expiresAt: plusMilliseconds(
              options.now(),
              AUTHENTICATION_LIFETIME_MS,
            ),
            purpose: "fresh",
            sessionTokenDigest: session.sessionTokenDigest,
          },
          options.now(),
        ),
      });
      return authentication.options;
    },

    async finishFreshPasskeyAction(input) {
      const snapshot = await readState();
      const challenge = requireAuthenticationChallenge(
        snapshot.state,
        input.ceremonyId,
        "fresh",
        options.now(),
      );
      if (challenge.sessionTokenDigest === null) {
        throw new Error("Fresh Passkey Action session is unavailable");
      }
      if (
        challenge.sessionTokenDigest !==
        options.secrets.digest(input.sessionToken)
      ) {
        throw new Error("Fresh Passkey Action session is unavailable");
      }
      const verification = await options.passkeys.finishAuthentication({
        credentials: snapshot.state.passkeys,
        expectedChallenge: challenge.challenge,
        response: input.response,
      });
      const freshUntil = plusMilliseconds(
        options.now(),
        FRESH_PASSKEY_LIFETIME_MS,
      );
      await options.store.write(snapshot.revision, {
        ...withoutAuthenticationChallenge(
          snapshot.state,
          challenge.challenge,
        ),
        passkeys: updatePasskeyCounter(
          snapshot.state.passkeys,
          verification.credentialId,
          verification.newCounter,
        ),
        sessions: snapshot.state.sessions.map((session) =>
          session.sessionTokenDigest === challenge.sessionTokenDigest
            ? { ...session, freshUntil }
            : session,
        ),
      });
      return { freshUntil };
    },

    async canViewEvidence(sessionToken) {
      const snapshot = await readState();
      const session = findActiveSession(
          snapshot.state,
          options.secrets.digest(sessionToken),
          options.now(),
        );
      return session?.kind === "trusted";
    },

    async canChangeState(input) {
      const snapshot = await readState();
      const session = findActiveSession(
        snapshot.state,
        options.secrets.digest(input.sessionToken),
        options.now(),
      );
      return (
        session?.kind === "trusted" &&
        session.csrfTokenDigest === options.secrets.digest(input.csrfToken)
      );
    },

    async hasFreshPasskeyAction(sessionToken) {
      const snapshot = await readState();
      const session = findActiveSession(
        snapshot.state,
        options.secrets.digest(sessionToken),
        options.now(),
      );
      return (
        session !== undefined &&
        session.kind === "trusted" &&
        session.freshUntil !== null &&
        !isExpired(session.freshUntil, options.now())
      );
    },

    async beginBootstrapRegistration(input) {
      const snapshot = await readState();
      const bootstrap = snapshot.state.bootstrap;
      if (
        bootstrap === undefined ||
        isExpired(bootstrap.expiresAt, options.now()) ||
        !(await options.secrets.matches(input.bootstrapCode, bootstrap.verifier))
      ) {
        throw new Error("Bootstrap Code is unavailable");
      }

      const registration = await options.passkeys.beginRegistration({
        existingCredentials: snapshot.state.passkeys.map((passkey) => ({
          credentialId: passkey.credentialId,
          transports: passkey.transports,
        })),
        ownerUserId: snapshot.state.ownerUserId,
      });
      await options.store.write(snapshot.revision, {
        ...snapshot.state,
        registrationChallenge: {
          challenge: registration.challenge,
          expiresAt: plusMilliseconds(options.now(), REGISTRATION_LIFETIME_MS),
          label: input.label,
          purpose: "bootstrap",
          sessionTokenDigest: null,
        },
      });
      return registration.options;
    },

    async finishRegistration(input) {
      const snapshot = await readState();
      const challenge = snapshot.state.registrationChallenge;
      const bootstrap = snapshot.state.bootstrap;
      if (
        challenge === undefined ||
        isExpired(challenge.expiresAt, options.now())
      ) {
        throw new Error("Registration challenge is unavailable");
      }
      if (
        challenge.purpose === "bootstrap" &&
        (bootstrap === undefined ||
          isExpired(bootstrap.expiresAt, options.now()))
      ) {
        throw new Error("Registration challenge is unavailable");
      }
      if (challenge.purpose === "recovery") {
        if (
          input.sessionToken === undefined ||
          challenge.sessionTokenDigest !==
            options.secrets.digest(input.sessionToken)
        ) {
          throw new Error("Recovery enrollment session is unavailable");
        }
        const recoverySession =
          challenge.sessionTokenDigest === null
            ? undefined
            : findActiveSession(
                snapshot.state,
                challenge.sessionTokenDigest,
                options.now(),
              );
        if (recoverySession?.kind !== "recovery") {
          throw new Error("Recovery enrollment session is unavailable");
        }
      }

      const registration = await options.passkeys.finishRegistration({
        expectedChallenge: challenge.challenge,
        response: input.response,
      });
      if (
        snapshot.state.passkeys.some(
          (passkey) => passkey.credentialId === registration.credentialId,
        )
      ) {
        throw new Error("Passkey is already enrolled");
      }
      const passkeys = [
        ...snapshot.state.passkeys,
        {
          ...registration,
          label: challenge.label,
        },
      ];
      const recoveryCodes =
        challenge.purpose === "bootstrap" &&
        passkeys.length >= 2 &&
        snapshot.state.recoveryCodeVerifiers.length === 0
          ? [...options.secrets.createRecoveryCodes()]
          : [];
      const recoveryConfirmationToken =
        recoveryCodes.length > 0
          ? options.secrets.createRecoveryConfirmationToken()
          : undefined;
      const pendingRecoveryCodeVerifiers = await Promise.all(
        recoveryCodes.map((code) => options.secrets.protect(code)),
      );
      if (
        passkeys.length >= 2 &&
        snapshot.state.recoveryCodeVerifiers.length === 0 &&
        recoveryCodes.length === 0
      ) {
        throw new Error("Recovery Codes could not be generated");
      }
      const nextState: AuthenticationState = {
        authenticationChallenges: snapshot.state.authenticationChallenges,
        bootstrapPermanentlyDisabled: snapshot.state.bootstrapPermanentlyDisabled,
        ownerUserId: snapshot.state.ownerUserId,
        passkeys,
        recoveryCodeVerifiers: snapshot.state.recoveryCodeVerifiers,
        ...(recoveryConfirmationToken === undefined
          ? snapshot.state.recoveryConfirmation === undefined
            ? {}
            : { recoveryConfirmation: snapshot.state.recoveryConfirmation }
          : {
              recoveryConfirmation: {
                expiresAt: plusMilliseconds(
                  options.now(),
                  RECOVERY_CONFIRMATION_LIFETIME_MS,
                ),
                pendingVerifiers: pendingRecoveryCodeVerifiers,
                tokenDigest: options.secrets.digest(recoveryConfirmationToken),
              },
            }),
        sessions:
          challenge.purpose === "recovery"
            ? snapshot.state.sessions.filter(
                (session) =>
                  session.sessionTokenDigest !==
                  challenge.sessionTokenDigest,
              )
            : snapshot.state.sessions,
      };
      await options.store.write(snapshot.revision, nextState);
      return {
        recoveryCodes,
        ...(recoveryConfirmationToken === undefined
          ? {}
          : { recoveryConfirmationToken }),
        status: projectStatus(nextState),
      };
    },

    async generateBootstrapCode() {
      const snapshot = await readState();
      if (snapshot.state.bootstrapPermanentlyDisabled) {
        throw new Error("Bootstrap enrollment is permanently disabled");
      }
      const code = options.secrets.createBootstrapCode();
      await options.store.write(snapshot.revision, {
        authenticationChallenges: snapshot.state.authenticationChallenges,
        bootstrap: {
          expiresAt: plusMilliseconds(options.now(), BOOTSTRAP_LIFETIME_MS),
          verifier: await options.secrets.protect(code),
        },
        bootstrapPermanentlyDisabled:
          snapshot.state.bootstrapPermanentlyDisabled,
        ownerUserId: snapshot.state.ownerUserId,
        passkeys: snapshot.state.passkeys,
        recoveryCodeVerifiers: snapshot.state.recoveryCodeVerifiers,
        ...(snapshot.state.recoveryConfirmation === undefined
          ? {}
          : { recoveryConfirmation: snapshot.state.recoveryConfirmation }),
        sessions: snapshot.state.sessions,
      });
      return code;
    },

    async beginRecoveryRegistration(input) {
      const snapshot = await readState();
      const session = findActiveSession(
        snapshot.state,
        options.secrets.digest(input.sessionToken),
        options.now(),
      );
      if (
        session?.kind !== "recovery" ||
        session.csrfTokenDigest !== options.secrets.digest(input.csrfToken)
      ) {
        throw new Error("Recovery enrollment session is unavailable");
      }
      const registration = await options.passkeys.beginRegistration({
        existingCredentials: snapshot.state.passkeys.map((passkey) => ({
          credentialId: passkey.credentialId,
          transports: passkey.transports,
        })),
        ownerUserId: snapshot.state.ownerUserId,
      });
      await options.store.write(snapshot.revision, {
        ...snapshot.state,
        registrationChallenge: {
          challenge: registration.challenge,
          expiresAt: plusMilliseconds(
            options.now(),
            REGISTRATION_LIFETIME_MS,
          ),
          label: input.label,
          purpose: "recovery",
          sessionTokenDigest: session.sessionTokenDigest,
        },
      });
      return registration.options;
    },

    async recover(recoveryCode) {
      const snapshot = await readState();
      const matchingIndex = await findMatchingRecoveryCode(
        snapshot.state.recoveryCodeVerifiers,
        recoveryCode,
        options.secrets,
      );
      if (matchingIndex === -1) {
        throw new Error("Recovery Code is unavailable");
      }
      const sessionToken = options.secrets.createSessionToken();
      const csrfToken = options.secrets.createCsrfToken();
      const recoverySession: StoredSession = {
        csrfTokenDigest: options.secrets.digest(csrfToken),
        expiresAt: plusMilliseconds(
          options.now(),
          RECOVERY_SESSION_LIFETIME_MS,
        ),
        freshUntil: null,
        kind: "recovery",
        sessionTokenDigest: options.secrets.digest(sessionToken),
      };
      await options.store.write(snapshot.revision, {
        ...snapshot.state,
        recoveryCodeVerifiers:
          snapshot.state.recoveryCodeVerifiers.filter(
            (_verifier, index) => index !== matchingIndex,
          ),
        sessions: appendActiveSession(
          snapshot.state.sessions,
          recoverySession,
          options.now(),
        ),
      });
      return {
        csrfToken,
        expiresAt: recoverySession.expiresAt,
        sessionToken,
      };
    },

    async status() {
      return projectStatus((await readState()).state);
    },

    async confirmRecoveryCodes(input) {
      const snapshot = await readState();
      const confirmation = snapshot.state.recoveryConfirmation;
      if (
        confirmation === undefined ||
        isExpired(confirmation.expiresAt, options.now()) ||
        confirmation.tokenDigest !==
          options.secrets.digest(input.confirmationToken)
      ) {
        throw new Error("Recovery Code confirmation is unavailable");
      }
      const nextState: AuthenticationState = {
        authenticationChallenges: snapshot.state.authenticationChallenges,
        bootstrapPermanentlyDisabled: true,
        ownerUserId: snapshot.state.ownerUserId,
        passkeys: snapshot.state.passkeys,
        recoveryCodeVerifiers: confirmation.pendingVerifiers,
        sessions: snapshot.state.sessions,
      };
      await options.store.write(snapshot.revision, nextState);
      return projectStatus(nextState);
    },
  };
}

async function findMatchingRecoveryCode(
  verifiers: readonly string[],
  recoveryCode: string,
  secrets: AuthenticationSecrets,
): Promise<number> {
  for (const [index, verifier] of verifiers.entries()) {
    if (await secrets.matches(recoveryCode, verifier)) return index;
  }
  return -1;
}

function requireAuthenticationChallenge(
  state: AuthenticationState,
  ceremonyId: string,
  purpose: "login" | "fresh",
  now: string,
): AuthenticationState["authenticationChallenges"][number] {
  const challenge = state.authenticationChallenges.find(
    (candidate) => candidate.challenge === ceremonyId,
  );
  if (
    challenge === undefined ||
    challenge.purpose !== purpose ||
    isExpired(challenge.expiresAt, now)
  ) {
    throw new Error("Passkey authentication challenge is unavailable");
  }
  return challenge;
}

function findActiveSession(
  state: AuthenticationState,
  sessionTokenDigest: string,
  now: string,
): StoredSession | undefined {
  return state.sessions.find(
    (session) =>
      session.sessionTokenDigest === sessionTokenDigest &&
      !isExpired(session.expiresAt, now),
  );
}

function withoutAuthenticationChallenge(
  state: AuthenticationState,
  ceremonyId: string,
): AuthenticationState {
  return {
    ...state,
    authenticationChallenges: state.authenticationChallenges.filter(
      (challenge) => challenge.challenge !== ceremonyId,
    ),
  };
}

function updatePasskeyCounter(
  passkeys: readonly StoredPasskey[],
  credentialId: string,
  counter: number,
): readonly StoredPasskey[] {
  let found = false;
  const updated = passkeys.map((passkey) => {
    if (passkey.credentialId !== credentialId) return passkey;
    found = true;
    return { ...passkey, counter };
  });
  if (!found) throw new Error("Passkey is not enrolled");
  return updated;
}

function projectStatus(state: AuthenticationState): AuthenticationStatus {
  const unattendedAuthorityEnabled =
    state.passkeys.length >= 2 && state.recoveryCodeVerifiers.length > 0;
  return {
    bootstrapAvailable: !state.bootstrapPermanentlyDisabled,
    passkeyCount: state.passkeys.length,
    setup:
      state.passkeys.length === 0
        ? "bootstrap-required"
        : unattendedAuthorityEnabled
          ? "ready"
          : state.passkeys.length >= 2 &&
              state.recoveryConfirmation !== undefined
            ? "recovery-confirmation-required"
            : "second-passkey-required",
    unattendedAuthorityEnabled,
  };
}

function appendActiveAuthenticationChallenge(
  challenges: AuthenticationState["authenticationChallenges"],
  challenge: AuthenticationState["authenticationChallenges"][number],
  now: string,
): AuthenticationState["authenticationChallenges"] {
  const activeChallenges = challenges.filter(
    (candidate) => !isExpired(candidate.expiresAt, now),
  );
  const purposeLimit =
    challenge.purpose === "login"
      ? MAX_ACTIVE_LOGIN_CHALLENGES
      : MAX_ACTIVE_FRESH_PASSKEY_CHALLENGES;
  if (
    activeChallenges.filter(
      (candidate) => candidate.purpose === challenge.purpose,
    ).length >= purposeLimit ||
    activeChallenges.some(
      (candidate) => candidate.challenge === challenge.challenge,
    )
  ) {
    throw new Error("Passkey authentication ceremony could not be started");
  }
  return [...activeChallenges, challenge];
}

function appendActiveSession(
  sessions: readonly StoredSession[],
  session: StoredSession,
  now: string,
): readonly StoredSession[] {
  const activeSessions = sessions.filter(
    (candidate) => !isExpired(candidate.expiresAt, now),
  );
  if (activeSessions.length >= MAX_ACTIVE_SESSIONS) {
    throw new Error("Trusted Browser Session limit reached");
  }
  return [...activeSessions, session];
}

function plusMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function isExpired(expiresAt: string, now: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}
