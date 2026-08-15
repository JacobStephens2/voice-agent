import type {
  BountywellHealthObservation,
  BountywellHealthObserver,
  BountywellHealthInquiryRequest,
  BountywellHealthObservationRequest,
  EvidenceRecordProjection,
} from "@voice-agent/contracts";
import { bountywellHealthObservationSchema } from "@voice-agent/contracts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import {
  createAuthenticationLifecycle,
  type AuthenticationLifecycle,
  type AuthenticationSecrets,
  type PasskeyAdapter,
} from "@voice-agent/auth";
import { renderTaskPage } from "@voice-agent/pwa/server";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import {
  createSqliteAuthenticationStore,
  createSqliteDurableTaskStore,
} from "@voice-agent/sqlite-store";

export interface BountywellHealthScenario {
  readonly brokerRequests: readonly BountywellHealthObservationRequest[];
  submit(request: BountywellHealthInquiryRequest): Promise<EvidenceRecordProjection>;
  readTaskPage(taskId: string, sessionToken?: string): Promise<{
    readonly statusCode: number;
    readonly body: unknown;
    readonly html: string;
    readonly headers: Readonly<
      Record<string, number | string | string[] | undefined>
    >;
  }>;
  replayOperation(
    operationId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  close(): Promise<void>;
}

export interface BountywellHealthScenarioOptions {
  readonly databasePath: string;
  readonly now: string;
  readonly ids: readonly string[];
  readonly observation: BountywellHealthObservation;
  readonly rejectedBrokerMaterial?: readonly string[];
}

export async function createBountywellHealthScenario(
  options: BountywellHealthScenarioOptions,
): Promise<BountywellHealthScenario> {
  const ids = [...options.ids];
  const broker = new DeterministicBountywellHealthBroker(
    options.observation,
    options.rejectedBrokerMaterial,
  );
  const runtime = createDurableTaskRuntime({
    healthObserver: broker,
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The scenario exhausted its deterministic identifiers");
      }
      return id;
    },
    now: () => options.now,
    store: createSqliteDurableTaskStore(options.databasePath),
  });
  const api = createTaskApi({
    authentication: {
      async canViewEvidence(sessionToken) {
        return sessionToken === "scenario-trusted-session";
      },
    },
    records: runtime,
  });

  return {
    brokerRequests: broker.requests,
    async close() {
      await api.close();
      await runtime.close();
    },
    async readTaskPage(taskId, sessionToken) {
      const request = {
        method: "GET",
        url: `/api/tasks/${encodeURIComponent(taskId)}`,
      } as const;
      const response = await api.inject(
        sessionToken === undefined
          ? request
          : {
              ...request,
              headers: {
                cookie: `${trustedSessionCookieName}=${sessionToken}`,
              },
            },
      );
      const body = response.json<unknown>();
      return {
        body,
        headers: response.headers,
        html:
          response.statusCode === 200
            ? renderTaskPage(body as EvidenceRecordProjection)
            : "",
        statusCode: response.statusCode,
      };
    },
    replayOperation: (operationId) =>
      runtime.replayBountywellHealthOperation(operationId),
    submit: (request) => runtime.submitBountywellHealthInquiry(request),
  };
}

class DeterministicBountywellHealthBroker implements BountywellHealthObserver {
  readonly requests: BountywellHealthObservationRequest[] = [];
  readonly #observation: BountywellHealthObservation;

  constructor(
    observation: BountywellHealthObservation,
    rejectedBrokerMaterial: readonly string[] = [],
  ) {
    if (rejectedBrokerMaterial.length > observation.rejectedEvidenceCount) {
      throw new Error("Rejected broker material count exceeds the bounded summary");
    }

    // The fixture deliberately drops rejected raw material at the adapter boundary.
    // Only the typed, size-bounded observation can enter orchestration.
    this.#observation = bountywellHealthObservationSchema.parse(observation);
  }

  async observe(
    request: BountywellHealthObservationRequest,
  ): Promise<BountywellHealthObservation> {
    this.requests.push(request);
    return this.#observation;
  }
}

export interface AuthenticationScenario {
  beginFreshPasskeyAction(input: {
    readonly csrfToken: string;
    readonly sessionToken: string;
  }): Promise<string>;
  beginLogin(): Promise<string>;
  canViewEvidence(sessionToken: string): Promise<boolean>;
  close(): Promise<void>;
  enrollBootstrapPasskey(input: {
    readonly bootstrapCode: string;
    readonly credentialId: string;
    readonly label: string;
  }): ReturnType<AuthenticationLifecycle["finishRegistration"]>;
  enrollRecoveryPasskey(input: {
    readonly credentialId: string;
    readonly csrfToken: string;
    readonly label: string;
    readonly sessionToken: string;
  }): Promise<Awaited<ReturnType<AuthenticationLifecycle["status"]>>>;
  generateBootstrapCode(): Promise<string>;
  confirmRecoveryCodes(input: {
    readonly confirmationToken: string;
  }): ReturnType<AuthenticationLifecycle["confirmRecoveryCodes"]>;
  finishFreshPasskeyAction(input: {
    readonly ceremonyId: string;
    readonly credentialId: string;
    readonly sessionToken: string;
  }): ReturnType<AuthenticationLifecycle["finishFreshPasskeyAction"]>;
  finishLogin(input: {
    readonly ceremonyId: string;
    readonly credentialId: string;
  }): ReturnType<AuthenticationLifecycle["finishLogin"]>;
  hasFreshPasskeyAction(sessionToken: string): Promise<boolean>;
  login(credentialId: string): ReturnType<AuthenticationLifecycle["finishLogin"]>;
  performFreshPasskeyAction(input: {
    readonly credentialId: string;
    readonly csrfToken: string;
    readonly sessionToken: string;
  }): ReturnType<AuthenticationLifecycle["finishFreshPasskeyAction"]>;
  recover(recoveryCode: string): ReturnType<AuthenticationLifecycle["recover"]>;
  setTime(now: string): void;
  status(): ReturnType<AuthenticationLifecycle["status"]>;
}

export interface AuthenticationScenarioOptions {
  readonly authenticationChallenges?: readonly string[];
  readonly bootstrapCodes: readonly string[];
  readonly challenges: readonly string[];
  readonly csrfTokens?: readonly string[];
  readonly databasePath: string;
  readonly now: string;
  readonly ownerUserId: string;
  readonly recoveryCodes: readonly string[];
  readonly recoveryConfirmationTokens?: readonly string[];
  readonly sessionTokens?: readonly string[];
}

export async function createAuthenticationScenario(
  options: AuthenticationScenarioOptions,
): Promise<AuthenticationScenario> {
  const bootstrapCodes = [...options.bootstrapCodes];
  const challenges = [...options.challenges];
  const authenticationChallenges = [
    ...(options.authenticationChallenges ?? []),
  ];
  const csrfTokens = [...(options.csrfTokens ?? [])];
  const sessionTokens = [...(options.sessionTokens ?? [])];
  const recoveryConfirmationTokens = [
    ...(options.recoveryConfirmationTokens ?? ["recovery-confirmation-token"]),
  ];
  let currentNow = options.now;
  const store = createSqliteAuthenticationStore(options.databasePath);
  const secrets: AuthenticationSecrets = {
    createBootstrapCode() {
      return takeNext(bootstrapCodes, "Bootstrap Code");
    },
    createCsrfToken() {
      return takeNext(csrfTokens, "CSRF token");
    },
    createRecoveryCodes() {
      return options.recoveryCodes;
    },
    createRecoveryConfirmationToken() {
      return takeNext(
        recoveryConfirmationTokens,
        "Recovery Code confirmation token",
      );
    },
    createSessionToken() {
      return takeNext(sessionTokens, "session token");
    },
    digest(token) {
      return `digest:${token}`;
    },
    async matches(secret, verifier) {
      return verifier === `scenario:${secret}`;
    },
    async protect(secret) {
      return `scenario:${secret}`;
    },
  };
  const passkeys: PasskeyAdapter = {
    async beginAuthentication() {
      const challenge = takeNext(
        authenticationChallenges,
        "authentication challenge",
      );
      return { challenge, options: { challenge } };
    },
    async beginRegistration() {
      const challenge = takeNext(challenges, "registration challenge");
      return { challenge, options: { challenge } };
    },
    async finishRegistration({ expectedChallenge, response }) {
      if (
        !isScenarioRegistrationResponse(response) ||
        response.challenge !== expectedChallenge
      ) {
        throw new Error("Passkey registration could not be verified");
      }
      return {
        backedUp: false,
        counter: 0,
        credentialId: response.credentialId,
        deviceType: "singleDevice",
        publicKey: `public-key:${response.credentialId}`,
        transports: ["internal"],
      };
    },
    async finishAuthentication({
      credentials,
      expectedChallenge,
      response,
    }) {
      if (
        !isScenarioRegistrationResponse(response) ||
        response.challenge !== expectedChallenge ||
        !credentials.some(
          (credential) =>
            credential.credentialId === response.credentialId,
        )
      ) {
        throw new Error("Passkey authentication could not be verified");
      }
      const credential = credentials.find(
        (candidate) => candidate.credentialId === response.credentialId,
      );
      if (credential === undefined) {
        throw new Error("Passkey is not enrolled");
      }
      return {
        credentialId: credential.credentialId,
        newCounter: credential.counter + 1,
      };
    },
  };
  const authentication = createAuthenticationLifecycle({
    now: () => currentNow,
    ownerUserId: options.ownerUserId,
    passkeys,
    secrets,
    store,
  });

  async function beginLogin(): Promise<string> {
    return readScenarioChallenge(await authentication.beginLogin());
  }

  function finishLogin(input: {
    readonly ceremonyId: string;
    readonly credentialId: string;
  }) {
    return authentication.finishLogin({
      ceremonyId: input.ceremonyId,
      response: {
        challenge: input.ceremonyId,
        credentialId: input.credentialId,
      },
    });
  }

  async function beginFreshPasskeyAction(input: {
    readonly csrfToken: string;
    readonly sessionToken: string;
  }): Promise<string> {
    return readScenarioChallenge(
      await authentication.beginFreshPasskeyAction(input),
    );
  }

  function finishFreshPasskeyAction(input: {
    readonly ceremonyId: string;
    readonly credentialId: string;
    readonly sessionToken: string;
  }) {
    return authentication.finishFreshPasskeyAction({
      ceremonyId: input.ceremonyId,
      response: {
        challenge: input.ceremonyId,
        credentialId: input.credentialId,
      },
      sessionToken: input.sessionToken,
    });
  }

  return {
    beginFreshPasskeyAction,
    beginLogin,
    canViewEvidence: (sessionToken) =>
      authentication.canViewEvidence(sessionToken),
    close: () => store.close(),
    confirmRecoveryCodes: (input) =>
      authentication.confirmRecoveryCodes(input),
    async enrollBootstrapPasskey(input) {
      const registrationOptions =
        await authentication.beginBootstrapRegistration({
          bootstrapCode: input.bootstrapCode,
          label: input.label,
        });
      return authentication.finishRegistration({
        response: {
          challenge: readScenarioChallenge(registrationOptions),
          credentialId: input.credentialId,
        },
      });
    },
    async enrollRecoveryPasskey(input) {
      const registrationOptions =
        await authentication.beginRecoveryRegistration({
          csrfToken: input.csrfToken,
          label: input.label,
          sessionToken: input.sessionToken,
        });
      const result = await authentication.finishRegistration({
        response: {
          challenge: readScenarioChallenge(registrationOptions),
          credentialId: input.credentialId,
        },
        sessionToken: input.sessionToken,
      });
      return result.status;
    },
    generateBootstrapCode: () => authentication.generateBootstrapCode(),
    finishFreshPasskeyAction,
    finishLogin,
    hasFreshPasskeyAction: (sessionToken) =>
      authentication.hasFreshPasskeyAction(sessionToken),
    async login(credentialId) {
      const ceremonyId = await beginLogin();
      return finishLogin({
        ceremonyId,
        credentialId,
      });
    },
    async performFreshPasskeyAction(input) {
      const ceremonyId = await beginFreshPasskeyAction({
        csrfToken: input.csrfToken,
        sessionToken: input.sessionToken,
      });
      return finishFreshPasskeyAction({
        ceremonyId,
        credentialId: input.credentialId,
        sessionToken: input.sessionToken,
      });
    },
    recover: (recoveryCode) => authentication.recover(recoveryCode),
    setTime(now) {
      currentNow = now;
    },
    status: () => authentication.status(),
  };
}

function readScenarioChallenge(options: unknown): string {
  if (
    typeof options !== "object" ||
    options === null ||
    !("challenge" in options) ||
    typeof options.challenge !== "string"
  ) {
    throw new Error("Scenario registration options did not contain a challenge");
  }
  return options.challenge;
}

function isScenarioRegistrationResponse(
  response: unknown,
): response is { readonly challenge: string; readonly credentialId: string } {
  return (
    typeof response === "object" &&
    response !== null &&
    "challenge" in response &&
    typeof response.challenge === "string" &&
    "credentialId" in response &&
    typeof response.credentialId === "string"
  );
}

function takeNext(values: string[], kind: string): string {
  const value = values.shift();
  if (value === undefined) throw new Error(`Scenario exhausted its ${kind}s`);
  return value;
}
