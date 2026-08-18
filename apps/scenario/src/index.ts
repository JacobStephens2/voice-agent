import {
  bountywellHealthObservationSchema,
  telephoneBoundaryEvidenceEventSchema,
  telephoneConversationEvidenceEventSchema,
  type BountywellHealthObservation,
  type BountywellHealthObserver,
  type BountywellHealthInquiryRequest,
  type BountywellHealthObservationRequest,
  type CallbackActionResult,
  type CallbackProviderEvent,
  type EvidenceRecordProjection,
  type TelephoneConversationEvidenceEvent,
  type TelephoneBoundaryEvidenceEvent,
  type TelephoneProviderFailureStage,
  type TelephoneSessionActionResult,
  type TelephoneSessionProviderEvent,
  type InboundTelephoneEvent,
  type InboundTelephoneResult,
  type RegisteredTelephoneInput,
  type TelephoneSessionEvidenceRecordProjection,
} from "@voice-agent/contracts";

export * from "./human-merge-promotion.ts";
export * from "./task-continuity.ts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import {
  createAuthenticationLifecycle,
  type AuthenticationLifecycle,
  type AuthenticationSecrets,
  type PasskeyAdapter,
} from "@voice-agent/auth";
import {
  renderEvidenceRecordPage,
  renderTaskPage,
} from "@voice-agent/pwa/server";
import {
  createCallbackHandshakeRuntime,
  createDurableTaskRuntime,
  createTelephoneBoundaryRuntime,
  createTelephoneSessionCoordinator,
  type TelephoneTurnInterpreter,
} from "@voice-agent/runtime";
import {
  createSqliteAuthenticationStore,
  createSqliteCallbackHandshakeStore,
  createSqliteDurableTaskStore,
  createSqliteTelephoneBoundaryStore,
} from "@voice-agent/sqlite-store";

export interface TelephoneBoundaryScenario {
  readonly evidence: readonly TelephoneBoundaryEvidenceEvent[];
  activateSession(sessionId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["activateSession"]
  >;
  authorizeRawAudioDebug(input: {
    readonly actor: "owner" | "subagent";
    readonly freshPasskey: boolean;
    readonly sessionId: string;
  }): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["authorizeRawAudioDebug"]
  >;
  claimStateChangingTask(sessionId: string, taskId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["claimStateChangingTask"]
  >;
  claimRawAudioCapture(input: {
    readonly actor: "subagent" | "voice-agent";
    readonly sessionId: string;
  }): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["claimRawAudioCapture"]
  >;
  changeSpendingCeiling(input: {
    readonly ceilingMicrousd: number;
    readonly freshPasskey: boolean;
  }): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["changeSpendingCeiling"]
  >;
  close(): Promise<void>;
  cleanupExpiredRawAudio(): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["cleanupExpiredRawAudio"]
  >;
  enforceDeadline(sessionId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["enforceDeadline"]
  >;
  enforceDeadlines(): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["enforceDeadlines"]
  >;
  executeSubagent: ReturnType<
    typeof createTelephoneBoundaryRuntime
  >["executeSubagent"];
  endSession(
    sessionId: string,
    reason: "completed" | "disconnected" | "provider-failure",
  ): ReturnType<ReturnType<typeof createTelephoneBoundaryRuntime>["endSession"]>;
  noteActivity(sessionId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["noteActivity"]
  >;
  readMetrics(): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["readMetrics"]
  >;
  readBoundaryStatus(): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["readBoundaryStatus"]
  >;
  readSession(sessionId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["readSession"]
  >;
  recordProviderFailure(input: {
    readonly failureClass: "timeout" | "unavailable";
    readonly sessionId: string;
    readonly stage: TelephoneProviderFailureStage;
  }): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["recordProviderFailure"]
  >;
  recordUsage(input: {
    readonly amountMicrousd: number;
    readonly sessionId?: string;
    readonly source: "api" | "realtime-media" | "telephony";
    readonly usageId: string;
  }): ReturnType<ReturnType<typeof createTelephoneBoundaryRuntime>["recordUsage"]>;
  reserveUsageSlice(input: {
    readonly amountsMicrousd: Readonly<
      Record<"api" | "realtime-media" | "telephony", number>
    >;
    readonly sessionId?: string;
    readonly usageScopeId: string;
  }): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["reserveUsageSlice"]
  >;
  releaseWarmSession(sessionId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["releaseWarmSession"]
  >;
  releaseStateChangingTask(sessionId: string, taskId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["releaseStateChangingTask"]
  >;
  reserveWarmSession(sessionId: string): ReturnType<
    ReturnType<typeof createTelephoneBoundaryRuntime>["reserveWarmSession"]
  >;
  setTime(now: string): void;
}

export async function createTelephoneBoundaryScenario(options: {
  readonly databasePath: string;
  readonly endSessionOnEvidenceKinds?: readonly TelephoneBoundaryEvidenceEvent["kind"][];
  readonly failEvidenceKinds?: readonly TelephoneBoundaryEvidenceEvent["kind"][];
  readonly now: string;
  readonly prolongedSilenceMs?: number;
  readonly rawAudioDebugDirectory?: string;
}): Promise<TelephoneBoundaryScenario> {
  let currentNow = options.now;
  let sequence = 0;
  const evidence: TelephoneBoundaryEvidenceEvent[] = [];
  const store = createSqliteTelephoneBoundaryStore(options.databasePath);
  const runtime = createTelephoneBoundaryRuntime({
    evidence: {
      async append(_sessionId, event) {
        if (options.failEvidenceKinds?.includes(event.kind)) {
          throw new Error("Injected Telephone Boundary evidence failure");
        }
        evidence.push(
          telephoneBoundaryEvidenceEventSchema.parse({
            ...event,
            sequence: evidence.length + 1,
          }),
        );
        if (options.endSessionOnEvidenceKinds?.includes(event.kind)) {
          await store.endSession({
            durationMs: 0,
            endedAt: event.occurredAt,
            reason: "disconnected",
            sessionId: _sessionId,
          });
        }
      },
    },
    nextId: () => `telephone-boundary-event-${(sequence += 1)}`,
    now: () => currentNow,
    ...(options.prolongedSilenceMs === undefined
      ? {}
      : { prolongedSilenceMs: options.prolongedSilenceMs }),
    rawAudioArtifacts: {
      async remove() {
        return "deleted";
      },
    },
    ...(options.rawAudioDebugDirectory === undefined
      ? {}
      : { rawAudioDebugDirectory: options.rawAudioDebugDirectory }),
    store,
  });
  return {
    ...runtime,
    evidence,
    setTime(now) {
      currentNow = now;
    },
  };
}

export interface CallbackHandshakeScenario {
  applyEvidenceRetention(input: {
    readonly cutoff: string;
  }): Promise<void>;
  appendTelephoneSessionEvidence: ReturnType<
    typeof createCallbackHandshakeRuntime
  >["appendTelephoneSessionEvidence"];
  close(): Promise<void>;
  processDueRetries(): ReturnType<
    ReturnType<typeof createCallbackHandshakeRuntime>["processDueRetries"]
  >;
  readEvidenceRecord(
    handshakeId: string,
  ): Promise<TelephoneSessionEvidenceRecordProjection | undefined>;
  readOperationalMetrics(): ReturnType<
    ReturnType<typeof createCallbackHandshakeRuntime>["readOperationalMetrics"]
  >;
  requestTelephoneSessionFailureNotification: ReturnType<
    typeof createCallbackHandshakeRuntime
  >["requestTelephoneSessionFailureNotification"];
  readMetrics(): Promise<string>;
  readTaskPage(taskId: string, sessionToken?: string): Promise<{
    readonly body: unknown;
    readonly html: string;
    readonly statusCode: number;
  }>;
  receiveInbound(event: InboundTelephoneEvent): Promise<InboundTelephoneResult>;
  receiveProviderEvent(
    handshakeId: string,
    event: CallbackProviderEvent,
  ): Promise<CallbackActionResult>;
  registerTelephone(
    input: RegisteredTelephoneInput,
  ): ReturnType<ReturnType<typeof createCallbackHandshakeRuntime>["registerTelephone"]>;
  setTime(now: string): void;
}

export interface CallbackHandshakeScenarioOptions {
  readonly databasePath: string;
  readonly ids: readonly string[];
  readonly maximumAcceptedInWindow?: number;
  readonly now: string;
  readonly registeredTelephone: RegisteredTelephoneInput;
}

export async function createCallbackHandshakeScenario(
  options: CallbackHandshakeScenarioOptions,
): Promise<CallbackHandshakeScenario> {
  const ids = [...options.ids];
  let currentNow = options.now;
  const store = createSqliteCallbackHandshakeStore(options.databasePath);
  const runtime = createCallbackHandshakeRuntime({
    ...(options.maximumAcceptedInWindow === undefined
      ? {}
      : { maximumAcceptedInWindow: options.maximumAcceptedInWindow }),
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The scenario exhausted its deterministic identifiers");
      }
      return id;
    },
    now: () => currentNow,
    store,
  });
  await runtime.registerTelephone(options.registeredTelephone);
  const api = createTaskApi({
    authentication: {
      async canViewEvidence(sessionToken) {
        return sessionToken === "scenario-trusted-session";
      },
    },
    records: {
      getEvidenceRecord: (taskId) => runtime.readEvidenceRecord(taskId),
      listEvidenceRecords: () => runtime.listEvidenceRecords(),
      readOperationalMetrics: async () => ({
        bountywellChecks: [],
        callbacks: await runtime.readOperationalMetrics(),
        operations: { accepted: 0, completed: 0, running: 0 },
        policyDenials: 0,
        storage: { databaseBytes: 0, filesystemAvailableBytes: 0 },
        tasks: { completed: 0, pending: 0 },
      }),
    },
  });
  return {
    applyEvidenceRetention: (input) => store.applyEvidenceRetention(input),
    appendTelephoneSessionEvidence: (handshakeId, event) =>
      runtime.appendTelephoneSessionEvidence(handshakeId, event),
    async close() {
      await api.close();
      await runtime.close();
    },
    processDueRetries: () => runtime.processDueRetries(),
    readEvidenceRecord: (handshakeId) =>
      runtime.readEvidenceRecord(handshakeId),
    readOperationalMetrics: () => runtime.readOperationalMetrics(),
    requestTelephoneSessionFailureNotification: (handshakeId, input) =>
      runtime.requestTelephoneSessionFailureNotification(handshakeId, input),
    async readMetrics() {
      const response = await api.inject({ method: "GET", url: "/metrics" });
      if (response.statusCode !== 200) {
        throw new Error("Callback metrics endpoint was unavailable");
      }
      return response.body;
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
        html:
          response.statusCode === 200
            ? renderEvidenceRecordPage(
                body as TelephoneSessionEvidenceRecordProjection,
              )
            : "",
        statusCode: response.statusCode,
      };
    },
    receiveInbound: (event) => runtime.receiveInbound(event),
    receiveProviderEvent: (handshakeId, event) =>
      runtime.receiveProviderEvent(handshakeId, event),
    registerTelephone: (input) => runtime.registerTelephone(input),
    setTime(now) {
      currentNow = now;
    },
  };
}

export interface TelephoneBountywellScenario {
  readonly brokerRequests: readonly BountywellHealthObservationRequest[];
  readonly failureNotifications: readonly {
    readonly failureEventId: string;
    readonly occurredAt: string;
  }[];
  readonly sessionEvidence: readonly TelephoneConversationEvidenceEvent[];
  close(): Promise<void>;
  readEvidenceRecord(
    taskId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  readTaskPage(taskId: string, sessionToken?: string): Promise<{
    readonly body: unknown;
    readonly html: string;
    readonly statusCode: number;
  }>;
  receiveProviderEvent(
    event: TelephoneSessionProviderEvent,
  ): Promise<TelephoneSessionActionResult>;
}

export interface TelephoneBountywellScenarioOptions {
  readonly databasePath: string;
  readonly ids: readonly string[];
  readonly now: string;
  readonly observation: BountywellHealthObservation;
  readonly stateChangingDecisions?: readonly ("accepted" | "queued")[];
}

export async function createTelephoneBountywellScenario(
  options: TelephoneBountywellScenarioOptions,
): Promise<TelephoneBountywellScenario> {
  const ids = [...options.ids];
  const broker = new DeterministicBountywellHealthBroker(options.observation);
  const store = createSqliteDurableTaskStore(options.databasePath);
  await store.registerBountywell(options.now);
  const tasks = createDurableTaskRuntime({
    applicationRegistry: store,
    healthObserver: broker,
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The scenario exhausted its deterministic identifiers");
      }
      return id;
    },
    now: () => options.now,
    store,
  });
  const interpreter: TelephoneTurnInterpreter = {
    async interpret(input) {
      const normalized = input.text.toLocaleLowerCase("en-US");
      const stateChanging =
        normalized.includes("bountywell") &&
        /\b(delete|deploy|fix|restart|start|stop|update)\b/u.test(normalized);
      const bountywellHealthQuestion =
        normalized.includes("bountywell") &&
        /\b(doing|health|healthy|okay|running|status|up)\b/u.test(normalized);
      return {
        durationMs: 24,
        intent: stateChanging
          ? "state-changing"
          : bountywellHealthQuestion
            ? "bountywell-health"
            : "unrelated",
        provider: "deterministic-scenario-coordinator",
      };
    },
  };
  const sessionEvidence: TelephoneConversationEvidenceEvent[] = [];
  const failureNotifications: Array<{
    readonly failureEventId: string;
    readonly occurredAt: string;
  }> = [];
  const stateChangingDecisions = [...(options.stateChangingDecisions ?? [])];
  const coordinator = createTelephoneSessionCoordinator({
    interpreter,
    sessionEvidence: {
      async append(event) {
        sessionEvidence.push(
          telephoneConversationEvidenceEventSchema.parse({
            ...event,
            sequence: sessionEvidence.length + 1,
          }),
        );
      },
      async requestFailureNotification(input) {
        failureNotifications.push(input);
      },
    },
    ...(options.stateChangingDecisions === undefined
      ? {}
      : {
          stateChangingTasks: {
            async claim() {
              const decision = stateChangingDecisions.shift();
              if (decision === "accepted") {
                return {
                  decision,
                  resource: "state-changing-task" as const,
                };
              }
              return {
                decision: "queued" as const,
                position: 1,
                resource: "state-changing-task" as const,
              };
            },
            async release() {
              return {};
            },
          },
        }),
    tasks,
  });
  const api = createTaskApi({
    authentication: {
      async canViewEvidence(sessionToken) {
        return sessionToken === "scenario-trusted-session";
      },
    },
    records: tasks,
  });

  return {
    brokerRequests: broker.requests,
    failureNotifications,
    sessionEvidence,
    async close() {
      await api.close();
      await tasks.close();
    },
    readEvidenceRecord: (taskId) => tasks.getEvidenceRecord(taskId),
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
        html:
          response.statusCode === 200
            ? renderTaskPage(body as EvidenceRecordProjection)
            : "",
        statusCode: response.statusCode,
      };
    },
    receiveProviderEvent: (event) => coordinator.receiveProviderEvent(event),
  };
}

export interface BountywellHealthScenario {
  readonly brokerRequests: readonly BountywellHealthObservationRequest[];
  accept(request: BountywellHealthInquiryRequest): Promise<EvidenceRecordProjection>;
  processNext(): Promise<EvidenceRecordProjection | undefined>;
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
  registerBountywell(): ReturnType<
    ReturnType<typeof createDurableTaskRuntime>["registerBountywell"]
  >;
  close(): Promise<void>;
}

export interface BountywellHealthScenarioOptions {
  readonly databasePath: string;
  readonly now: string;
  readonly ids: readonly string[];
  readonly observation: BountywellHealthObservation;
  readonly rejectedBrokerMaterial?: readonly string[];
  readonly registered?: boolean;
}

export async function createBountywellHealthScenario(
  options: BountywellHealthScenarioOptions,
): Promise<BountywellHealthScenario> {
  const ids = [...options.ids];
  const broker = new DeterministicBountywellHealthBroker(
    options.observation,
    options.rejectedBrokerMaterial,
  );
  const store = createSqliteDurableTaskStore(options.databasePath);
  if (options.registered !== false) {
    await store.registerBountywell(options.now);
  }
  const runtime = createDurableTaskRuntime({
    applicationRegistry: store,
    healthObserver: broker,
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The scenario exhausted its deterministic identifiers");
      }
      return id;
    },
    now: () => options.now,
    store,
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
    accept: (request) => runtime.acceptBountywellHealthInquiry(request),
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
    processNext: () => runtime.processNextBountywellHealthInquiry(),
    registerBountywell: () => runtime.registerBountywell(),
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
