import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { AuthenticationLifecycle } from "@voice-agent/auth";
import {
  applyEvidenceRetentionRequestSchema,
  authorizeRawAudioDebugRequestSchema,
  authorizeRawAudioDebugResultSchema,
  authenticationStatusSchema,
  bountywellOutageInjectionSchema,
  bountywellRegistrationSchema,
  bountywellRegistrationStatusSchema,
  changeTelephoneSpendingCeilingRequestSchema,
  changeTelephoneSpendingCeilingResultSchema,
  csrfRequestSchema,
  deploymentAuthorityUpgradeResponseSchema,
  evidenceRecordProjectionSchema,
  evidenceRetentionResultSchema,
  evidenceRecordSummaryListSchema,
  freshPasskeyActionResponseSchema,
  originSecurityHeaders,
  notificationPreferenceSchema,
  notificationPreferenceStatusSchema,
  passkeyAuthenticationResponseRequestSchema,
  passkeyEnrollmentResultSchema,
  passkeyResponseRequestSchema,
  promotionResumeResponseSchema,
  registerTelephoneRequestSchema,
  registeredTelephoneSchema,
  registeredTelephoneStatusSchema,
  recoveryCodesConfirmationRequestSchema,
  recoveryRequestSchema,
  recoverySessionResponseSchema,
  registerBountywellRequestSchema,
  activateKeeploreDeploymentContractRequestSchema,
  activateAdministrativePolicyRequestSchema,
  administrativeTaskAdmissionResponseSchema,
  administrativeTaskIdSchema,
  administrativeTaskLifetimeRequestSchema,
  administrativeTaskLifetimeResponseSchema,
  administrativeTaskPreparationResponseSchema,
  administrativeAutonomyStatusSchema,
  administrativePolicyEvidencePageRequestSchema,
  administrativePolicyEvidencePageSchema,
  administrativePolicyStatusSchema,
  administrativeRestartWitnessObservationRequestSchema,
  administrativeRestartWitnessObservationSchema,
  suspendAdministrativePolicyRequestSchema,
  answerAdministrativeTaskConfirmationRequestSchema,
  prepareAdministrativeTaskConfirmationRequestSchema,
  enrollKeeploreRequestSchema,
  keeploreDeploymentContractSchema,
  keeploreLiveInspectionSchema,
  keeploreRegistrationSchema,
  keeploreRegistrationStatusSchema,
  grantBountywellRestartRequestSchema,
  bountywellDrillControlRequestSchema,
  bountywellDrillNotRegistered,
  bountywellOutageNotPresented,
  bountywellOwnerUnavailable,
  injectBountywellOutageRequestSchema,
  bountywellRecoveryTimerSchema,
  bountywellRecoveryTimerProofSchema,
  registrationOptionsRequestSchema,
  submitBountywellHealthRequestSchema,
  telephoneBoundaryStatusSchema,
  stopTaskRequestSchema,
  trustedBrowserSessionResponseSchema,
  updateNotificationPreferenceRequestSchema,
  voiceAgentEvidenceRecordProjectionSchema,
  type BountywellOutageInjection,
  type BountywellRecoveryTimer,
  type BountywellRecoveryTimerProof,
  type BountywellRegistration,
  type KeeploreDeploymentContract,
  type KeeploreLiveInspection,
  type KeeploreRegistration,
  type KeeploreWorkingTreeReconciliation,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
  type RegisteredTelephone,
  type RegisteredTelephoneInput,
  type NotificationPreference,
  type TelephoneBoundaryStatus,
  type NotificationPreferenceInput,
  type VoiceAgentEvidenceRecordProjection,
  type AdministrativePolicyStatus,
  type AdministrativePolicyActivationExpectation,
  type AdministrativePolicyEvidencePage,
  type AdministrativePolicyEvidencePageRequest,
  type AdministrativePolicySuspensionExpectation,
  type AdministrativeAutonomyStatus,
  type AdministrativeRestartWitnessObservationIdentity,
  type AdministrativeRestartWitnessObservationResponse,
  type AdministrativeRequestedOutcome,
  type AdministrativeTaskAdmissionResponse,
  type AdministrativeTaskId,
  type AdministrativeTaskLifetimeResponse,
  type AdministrativeTaskPreparationResponse,
  type AdministrativeTaskTargetRequest,
} from "@voice-agent/contracts";

import { DeploymentAuthorityChallengeError } from "./deployment-authority-challenge.ts";

export interface EvidenceRecordReader {
  getEvidenceRecord(
    taskId: string,
  ): Promise<VoiceAgentEvidenceRecordProjection | undefined>;
  listEvidenceRecords?(): Promise<readonly EvidenceRecordSummary[]>;
  readOperationalMetrics?(): Promise<{
    readonly bountywellChecks: readonly {
      readonly outcome: "fail" | "pass";
      readonly source:
        | "authentication-boundary"
        | "local-health"
        | "public-health"
        | "resource-health"
        | "service-state";
    }[];
    readonly callbacks?: {
      readonly attempts: number;
      readonly handshakes: {
        readonly authorized: number;
        readonly failed: number;
        readonly pending: number;
      };
    };
    readonly operations: {
      readonly accepted: number;
      readonly completed: number;
      readonly running: number;
    };
    readonly notifications: {
      readonly requested: number;
      readonly sent: number;
    };
    readonly policyDenials: number;
    readonly speech: {
      readonly interruptions: number;
      readonly timings: readonly {
        readonly count: number;
        readonly provider: "assemblyai" | "inworld" | "openai" | "other";
        readonly stage: "coordinator" | "stt" | "tts";
        readonly totalDurationMs: number;
      }[];
      readonly turns: number;
    };
    readonly storage: {
      readonly databaseBytes: number;
      readonly filesystemAvailableBytes: number;
    };
    readonly tasks: { readonly completed: number; readonly pending: number };
  }>;
  recordPolicyDenial?(): Promise<void>;
}

export interface EvidenceRecordAuthentication {
  authenticatedOwnerId?(sessionToken: string): Promise<string | undefined>;
  canChangeState?(input: {
    readonly csrfToken: string;
    readonly sessionToken: string;
  }): Promise<boolean>;
  canViewEvidence(sessionToken: string): Promise<boolean>;
  hasFreshPasskeyAction?(sessionToken: string): Promise<boolean>;
}

export interface DeploymentAuthorityUpgradeChallenge {
  readonly challenge: string;
  readonly commit: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly kind: "authentication" | "enrollment";
  readonly options: unknown;
}

export interface BountywellTaskControls {
  acceptBountywellHealthInquiry(input: {
    readonly question: "Is Bountywell healthy?";
    readonly requestId: string;
  }): Promise<EvidenceRecordProjection>;
  armBountywellRecoveryTimer?(): Promise<BountywellRecoveryTimer>;
  getBountywellRegistration(): Promise<BountywellRegistration | undefined>;
  grantBountywellRestart?(source: "fresh-passkey"): Promise<
    | { readonly decision: "denied"; readonly reason: string }
    | {
        readonly decision: "granted";
        readonly registration: BountywellRegistration;
      }
  >;
  injectBountywellOutage?(input: {
    readonly ownerAvailable: boolean;
  }): Promise<BountywellOutageInjection>;
  presentBountywellOutage?(): Promise<BountywellOutageInjection | undefined>;
  proveBountywellRecoveryTimer?(): Promise<BountywellRecoveryTimerProof>;
  registerBountywell(): Promise<BountywellRegistration>;
  requestStop?(input: {
    readonly requestId: string;
    readonly taskId: string;
  }): Promise<EvidenceRecordProjection>;
}

/** The Keeplore onboarding surface; every state change requires a Fresh Passkey Action. */
export interface KeeploreOnboardingApiControls {
  activateKeeploreDeploymentContract(input: {
    readonly buildCommand: string;
    readonly health: KeeploreDeploymentContract["health"];
    readonly preflightCommand: string;
    readonly releaseRoot: string;
    readonly retainedReleases: number;
    readonly revision: number;
    readonly source: "fresh-passkey-action";
  }): Promise<
    | { readonly decision: "denied"; readonly reason: string }
    | {
        readonly contract: KeeploreDeploymentContract;
        readonly decision: "activated";
      }
  >;
  enrollKeeplore(input: {
    readonly reconciliation: KeeploreWorkingTreeReconciliation;
    readonly source: "fresh-passkey-action";
  }): Promise<
    | { readonly decision: "denied"; readonly reason: string }
    | {
        readonly decision: "enrolled";
        readonly registration: KeeploreRegistration;
      }
  >;
  getKeeploreActiveContract(): Promise<KeeploreDeploymentContract | undefined>;
  getKeeploreRegistration(): Promise<KeeploreRegistration | undefined>;
  inspectKeeploreLiveCheckout(): Promise<KeeploreLiveInspection>;
}

export interface AdministrativeAutonomyApiControls {
  activatePolicy(input: {
    readonly expectation: AdministrativePolicyActivationExpectation;
    readonly source: "fresh-passkey-action";
  }): Promise<
    | {
        readonly decision: "activated";
        readonly policy: AdministrativePolicyStatus;
      }
    | { readonly decision: "denied"; readonly reason: string }
  >;
  answerTaskConfirmation(input: {
    readonly confirmation: "ambiguous" | "confirmed" | "declined";
    readonly confirmationCapability: string;
    readonly ownerId: string;
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeTaskAdmissionResponse>;
  getStatus(): Promise<AdministrativeAutonomyStatus>;
  getPolicyEvidencePage(
    input: AdministrativePolicyEvidencePageRequest,
  ): Promise<AdministrativePolicyEvidencePage>;
  prepareTaskConfirmation(input: {
    readonly intendedState: string;
    readonly outcome: AdministrativeRequestedOutcome;
    readonly ownerId: string;
    readonly requestId: string;
    readonly target: AdministrativeTaskTargetRequest;
  }): Promise<AdministrativeTaskPreparationResponse>;
  resumeTask(input: {
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeTaskLifetimeResponse>;
  stopTask(input: {
    readonly taskId: AdministrativeTaskId;
  }): Promise<AdministrativeTaskLifetimeResponse>;
  suspendPolicy(input: {
    readonly expectation: AdministrativePolicySuspensionExpectation;
  }): Promise<
    | {
        readonly decision: "suspended";
        readonly policy: AdministrativePolicyStatus;
      }
    | { readonly decision: "denied"; readonly reason: string }
  >;
}

/** Composition-owned witness action; requests carry identity, never observations. */
export interface AdministrativeRestartWitnessApiControls {
  observe(
    input: AdministrativeRestartWitnessObservationIdentity,
  ): Promise<AdministrativeRestartWitnessObservationResponse>;
}

export interface TelephoneControls {
  findRegisteredTelephone(): Promise<RegisteredTelephone | undefined>;
  registerTelephone(input: RegisteredTelephoneInput): Promise<RegisteredTelephone>;
}

export interface CompletionControls {
  applyEvidenceLifecyclePolicy?(): Promise<{ readonly cutoff: string }>;
  configureNotification(
    input: NotificationPreferenceInput,
  ): Promise<NotificationPreference>;
  getNotificationPreference(): Promise<NotificationPreference | undefined>;
}

export interface TelephoneBoundaryControls {
  authorizeRawAudioDebug(input: {
    readonly sessionId: string;
  }): Promise<
    | {
        readonly decision: "accepted";
        readonly expiresAt: string;
        readonly sessionId: string;
      }
    | { readonly decision: "rejected"; readonly reason: string }
  >;
  changeSpendingCeiling(input: {
    readonly ceilingMicrousd: number;
  }): Promise<
    | {
        readonly ceilingMicrousd: number;
        readonly decision: "accepted";
        readonly revision: number;
      }
    | { readonly decision: "rejected"; readonly reason: string }
  >;
  readBoundaryStatus(): Promise<TelephoneBoundaryStatus>;
}

export interface TaskApiOptions {
  readonly additionalMetrics?: (() => Promise<string>) | undefined;
  readonly administrativeControls?:
    | AdministrativeAutonomyApiControls
    | undefined;
  readonly authentication: EvidenceRecordAuthentication;
  readonly boundaryControls?: TelephoneBoundaryControls | undefined;
  readonly controls?: BountywellTaskControls;
  readonly completionControls?: CompletionControls | undefined;
  readonly keeploreControls?: KeeploreOnboardingApiControls | undefined;
  readonly origin?: string;
  readonly promotionControl?: {
    readDeploymentAuthorityUpgradeChallenge(): Promise<DeploymentAuthorityUpgradeChallenge>;
    requestDeploymentAuthorityUpgrade(input: DeploymentAuthorityUpgradeChallenge & {
      readonly response: unknown;
    }): Promise<string>;
    requestResume(): Promise<string>;
  } | undefined;
  readonly records: EvidenceRecordReader;
  readonly restartWitnessControls?:
    | AdministrativeRestartWitnessApiControls
    | undefined;
  readonly telephoneControls?: TelephoneControls | undefined;
}

export interface VoiceApiOptions {
  readonly additionalMetrics?: (() => Promise<string>) | undefined;
  readonly administrativeControls?:
    | AdministrativeAutonomyApiControls
    | undefined;
  readonly authentication: AuthenticationLifecycle;
  readonly boundaryControls?: TelephoneBoundaryControls | undefined;
  readonly controls?: BountywellTaskControls;
  readonly completionControls?: CompletionControls | undefined;
  readonly keeploreControls?: KeeploreOnboardingApiControls | undefined;
  readonly origin: string;
  readonly promotionControl?: {
    readDeploymentAuthorityUpgradeChallenge(): Promise<DeploymentAuthorityUpgradeChallenge>;
    requestDeploymentAuthorityUpgrade(input: DeploymentAuthorityUpgradeChallenge & {
      readonly response: unknown;
    }): Promise<string>;
    requestResume(): Promise<string>;
  } | undefined;
  readonly records: EvidenceRecordReader;
  readonly restartWitnessControls?:
    | AdministrativeRestartWitnessApiControls
    | undefined;
  readonly telephoneControls?: TelephoneControls | undefined;
}

export interface LoginCeremonyAdmission {
  admit(clientKey: string): boolean;
}

export interface LoginCeremonyAdmissionOptions {
  readonly maxAttempts?: number;
  readonly maxTrackedClients?: number;
  readonly now?: () => number;
  readonly windowMs?: number;
}

export const trustedSessionCookieName = "__Host-voice_agent_session";
export const csrfCookieName = "__Host-voice_agent_csrf";

export function createLoginCeremonyAdmission(
  options: LoginCeremonyAdmissionOptions = {},
): LoginCeremonyAdmission {
  const attemptsByClient = new Map<string, number[]>();
  const maxAttempts = options.maxAttempts ?? 3;
  const maxTrackedClients = options.maxTrackedClients ?? 1_000;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 5 * 60 * 1_000;

  return {
    admit(clientKey) {
      const currentTime = now();
      const windowStart = currentTime - windowMs;
      for (const [key, attempts] of attemptsByClient) {
        const activeAttempts = attempts.filter(
          (attempt) => attempt > windowStart,
        );
        if (activeAttempts.length === 0) attemptsByClient.delete(key);
        else attemptsByClient.set(key, activeAttempts);
      }
      const attempts = attemptsByClient.get(clientKey) ?? [];
      if (
        attempts.length >= maxAttempts ||
        (!attemptsByClient.has(clientKey) &&
          attemptsByClient.size >= maxTrackedClients)
      ) {
        return false;
      }
      attemptsByClient.set(clientKey, [...attempts, currentTime]);
      return true;
    },
  };
}

export function createTaskApi(options: TaskApiOptions): FastifyInstance {
  return createApi(options);
}

export function createVoiceApi(options: VoiceApiOptions): FastifyInstance {
  const api = createApi(options);
  registerAuthenticationRoutes(api, options);
  return api;
}

function createApi(options: TaskApiOptions): FastifyInstance {
  const api = Fastify({ logger: false, trustProxy: "127.0.0.1" });
  void api.register(cookie);
  api.addHook("onSend", async (request, reply) => {
    for (const [name, value] of Object.entries(originSecurityHeaders)) {
      reply.header(name, value);
    }
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }
  });
  api.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof Error &&
      (error.name === "ZodError" || error.name === "SyntaxError")
    ) {
      return reply.code(400).send({ error: "Invalid request" });
    }
    return reply.code(500).send({ error: "Request failed" });
  });

  api.get("/healthz", async () => ({ status: "ok" }));
  api.get("/metrics", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    const applicationMetrics =
      options.records.readOperationalMetrics === undefined
        ? emptyOperationalMetrics()
        : await options.records.readOperationalMetrics();
    const additionalMetrics =
      options.additionalMetrics === undefined
        ? ""
        : await options.additionalMetrics();
    return renderOperationalMetrics(applicationMetrics, additionalMetrics);
  });

  api.get("/api/tasks", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (options.records.listEvidenceRecords === undefined) {
      return evidenceRecordSummaryListSchema.parse([]);
    }
    return evidenceRecordSummaryListSchema.parse(
      await options.records.listEvidenceRecords(),
    );
  });

  api.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (request, reply) => {
      if (!(await authorizeEvidence(request, options.authentication))) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const record = await options.records.getEvidenceRecord(
        request.params.taskId,
      );
      if (record === undefined) {
        return reply.code(404).send({ error: "Task not found" });
      }
      return voiceAgentEvidenceRecordProjectionSchema.parse(record);
    },
  );
  if (options.controls !== undefined && options.origin !== undefined) {
    registerBountywellControlRoutes(api, {
      authentication: options.authentication,
      controls: options.controls,
      origin: options.origin,
      records: options.records,
    });
  }
  if (
    options.administrativeControls !== undefined &&
    options.origin !== undefined
  ) {
    registerAdministrativeAutonomyRoutes(api, {
      authentication: options.authentication,
      controls: options.administrativeControls,
      origin: options.origin,
      records: options.records,
    });
  }
  if (
    options.restartWitnessControls !== undefined &&
    options.origin !== undefined
  ) {
    registerAdministrativeRestartWitnessRoute(api, {
      authentication: options.authentication,
      controls: options.restartWitnessControls,
      origin: options.origin,
      records: options.records,
    });
  }
  if (options.keeploreControls !== undefined && options.origin !== undefined) {
    registerKeeploreOnboardingRoutes(api, {
      authentication: options.authentication,
      controls: options.keeploreControls,
      origin: options.origin,
      records: options.records,
    });
  }
  if (options.promotionControl !== undefined && options.origin !== undefined) {
    registerPromotionControlRoute(api, {
      authentication: options.authentication,
      origin: options.origin,
      promotionControl: options.promotionControl,
      records: options.records,
    });
  }
  if (options.telephoneControls !== undefined && options.origin !== undefined) {
    registerTelephoneControlRoutes(api, {
      authentication: options.authentication,
      controls: options.telephoneControls,
      origin: options.origin,
      records: options.records,
    });
  }
  if (options.boundaryControls !== undefined && options.origin !== undefined) {
    registerTelephoneBoundaryRoutes(api, {
      authentication: options.authentication,
      controls: options.boundaryControls,
      origin: options.origin,
      records: options.records,
    });
  }
  if (options.completionControls !== undefined && options.origin !== undefined) {
    registerCompletionControlRoutes(api, {
      authentication: options.authentication,
      controls: options.completionControls,
      origin: options.origin,
      records: options.records,
    });
  }
  return api;
}

function registerAdministrativeAutonomyRoutes(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly controls: AdministrativeAutonomyApiControls;
    readonly origin: string;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.get("/api/administrative-autonomy", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return administrativeAutonomyStatusSchema.parse(
      await options.controls.getStatus(),
    );
  });

  api.get(
    "/api/administrative-autonomy/policy-evidence",
    async (request, reply) => {
      if (!(await authorizeEvidence(request, options.authentication))) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const pageRequest = administrativePolicyEvidencePageRequestSchema.parse(
        request.query,
      );
      return administrativePolicyEvidencePageSchema.parse(
        await options.controls.getPolicyEvidencePage(pageRequest),
      );
    },
  );

  api.post(
    "/api/administrative-autonomy/task-confirmations",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = prepareAdministrativeTaskConfirmationRequestSchema.parse(
        request.body,
      );
      const ownerId = await authorizeAdministrativeOwner(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (ownerId === undefined) return;
      const result = administrativeTaskPreparationResponseSchema.parse(
        await options.controls.prepareTaskConfirmation({
          intendedState: body.intendedState,
          outcome: body.outcome,
          ownerId,
          requestId: body.requestId,
          target: body.target,
        }),
      );
      return result.decision === "denied"
        ? reply.code(409).send(result)
        : result;
    },
  );

  api.post<{ Params: { taskId: string } }>(
    "/api/administrative-autonomy/task-confirmations/:taskId",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = answerAdministrativeTaskConfirmationRequestSchema.parse(
        request.body,
      );
      const ownerId = await authorizeAdministrativeOwner(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (ownerId === undefined) return;
      const result = administrativeTaskAdmissionResponseSchema.parse(
        await options.controls.answerTaskConfirmation({
          confirmation: body.confirmation,
          confirmationCapability: body.confirmationCapability,
          ownerId,
          taskId: administrativeTaskIdSchema.parse(request.params.taskId),
        }),
      );
      return result.decision === "denied"
        ? reply.code(409).send(result)
        : result;
    },
  );

  api.post("/api/administrative-autonomy/activate", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = activateAdministrativePolicyRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    if (
      options.authentication.hasFreshPasskeyAction === undefined ||
      !(await options.authentication.hasFreshPasskeyAction(sessionToken))
    ) {
      await options.records.recordPolicyDenial?.();
      return reply.code(403).send({ error: "Fresh Passkey Action required" });
    }
    const result = await options.controls.activatePolicy({
      expectation: body.expectation,
      source: "fresh-passkey-action",
    });
    if (result.decision === "denied") {
      await options.records.recordPolicyDenial?.();
      return reply.code(409).send({ error: result.reason });
    }
    return administrativePolicyStatusSchema.parse(result.policy);
  });

  for (const action of ["stop", "resume"] as const) {
    api.post<{ readonly Params: { readonly taskId: string } }>(
      `/api/administrative-autonomy/tasks/:taskId/${action}`,
      async (request, reply) => {
        if (!requireOrigin(request, reply, options.origin)) return;
        const body = administrativeTaskLifetimeRequestSchema.parse(request.body);
        const sessionToken = await authorizeStateChange(
          request,
          reply,
          options.authentication,
          body.csrfToken,
          options.records,
        );
        if (sessionToken === undefined) return;
        const taskId = administrativeTaskIdSchema.parse(request.params.taskId);
        const result = administrativeTaskLifetimeResponseSchema.parse(
          action === "stop"
            ? await options.controls.stopTask({ taskId })
            : await options.controls.resumeTask({ taskId }),
        );
        return result.decision === "denied"
          ? reply.code(409).send(result)
          : result;
      },
    );
  }

  api.post("/api/administrative-autonomy/suspend", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = suspendAdministrativePolicyRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    const result = await options.controls.suspendPolicy({
      expectation: body.expectation,
    });
    if (result.decision === "denied") {
      await options.records.recordPolicyDenial?.();
      return reply.code(409).send({ error: result.reason });
    }
    return administrativePolicyStatusSchema.parse(result.policy);
  });
}

function registerAdministrativeRestartWitnessRoute(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly controls: AdministrativeRestartWitnessApiControls;
    readonly origin: string;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.post(
    "/api/administrative-autonomy/restart-witness/observations",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = administrativeRestartWitnessObservationRequestSchema.parse(
        request.body,
      );
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      const result = await options.controls.observe({
        campaignId: body.campaignId,
        challenge: body.challenge,
        phase: body.phase,
      });
      if (result.decision === "denied") {
        return reply.code(409).send({ reason: result.reason });
      }
      return administrativeRestartWitnessObservationSchema.parse(
        result.observation,
      );
    },
  );
}

function registerKeeploreOnboardingRoutes(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly controls: KeeploreOnboardingApiControls;
    readonly origin: string;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.get("/api/applications/keeplore", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return keeploreRegistrationStatusSchema.parse({
      registration: (await options.controls.getKeeploreRegistration()) ?? null,
    });
  });

  api.get("/api/applications/keeplore/live-inspection", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return keeploreLiveInspectionSchema.parse(
      await options.controls.inspectKeeploreLiveCheckout(),
    );
  });

  api.post("/api/applications/keeplore/registration", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = enrollKeeploreRequestSchema.parse(request.body);
    const sessionToken = await authorizeFreshAction(
      request,
      reply,
      options,
      body.csrfToken,
    );
    if (sessionToken === undefined) return;
    const enrolled = await options.controls.enrollKeeplore({
      reconciliation: body.reconciliation,
      source: "fresh-passkey-action",
    });
    if (enrolled.decision !== "enrolled") {
      await options.records.recordPolicyDenial?.();
      return reply.code(403).send({ error: enrolled.reason });
    }
    return keeploreRegistrationSchema.parse(enrolled.registration);
  });

  api.post(
    "/api/applications/keeplore/deployment-contract",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = activateKeeploreDeploymentContractRequestSchema.parse(
        request.body,
      );
      const sessionToken = await authorizeFreshAction(
        request,
        reply,
        options,
        body.csrfToken,
      );
      if (sessionToken === undefined) return;
      const activated = await options.controls.activateKeeploreDeploymentContract({
        buildCommand: body.buildCommand,
        health: body.health,
        preflightCommand: body.preflightCommand,
        releaseRoot: body.releaseRoot,
        retainedReleases: body.retainedReleases,
        revision: body.revision,
        source: "fresh-passkey-action",
      });
      if (activated.decision !== "activated") {
        await options.records.recordPolicyDenial?.();
        return reply.code(403).send({ error: activated.reason });
      }
      return keeploreDeploymentContractSchema.parse(activated.contract);
    },
  );
}

function registerTelephoneBoundaryRoutes(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly controls: TelephoneBoundaryControls;
    readonly origin: string;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.get("/api/telephone/boundaries", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return telephoneBoundaryStatusSchema.parse(
      await options.controls.readBoundaryStatus(),
    );
  });

  api.post("/api/telephone/spending-ceiling", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = changeTelephoneSpendingCeilingRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    if (
      options.authentication.hasFreshPasskeyAction === undefined ||
      !(await options.authentication.hasFreshPasskeyAction(sessionToken))
    ) {
      await options.records.recordPolicyDenial?.();
      return reply.code(403).send({ error: "Fresh Passkey Action required" });
    }
    const result = await options.controls.changeSpendingCeiling({
      ceilingMicrousd: body.ceilingMicrousd,
    });
    if (result.decision === "rejected") {
      await options.records.recordPolicyDenial?.();
      return reply.code(409).send({ error: result.reason });
    }
    return changeTelephoneSpendingCeilingResultSchema.parse(result);
  });

  api.post<{ Params: { sessionId: string } }>(
    "/api/telephone/sessions/:sessionId/raw-audio-debug",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = authorizeRawAudioDebugRequestSchema.parse(request.body);
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (
        options.authentication.hasFreshPasskeyAction === undefined ||
        !(await options.authentication.hasFreshPasskeyAction(sessionToken))
      ) {
        await options.records.recordPolicyDenial?.();
        return reply.code(403).send({ error: "Fresh Passkey Action required" });
      }
      const result = await options.controls.authorizeRawAudioDebug({
        sessionId: request.params.sessionId,
      });
      if (result.decision === "rejected") {
        await options.records.recordPolicyDenial?.();
        return reply.code(409).send({ error: result.reason });
      }
      return authorizeRawAudioDebugResultSchema.parse(result);
    },
  );
}

function registerCompletionControlRoutes(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly controls: CompletionControls;
    readonly origin: string;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.get("/api/notifications/preference", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return notificationPreferenceStatusSchema.parse({
      preference:
        (await options.controls.getNotificationPreference()) ?? null,
    });
  });
  api.post("/api/notifications/preference", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = updateNotificationPreferenceRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    if (
      options.authentication.hasFreshPasskeyAction === undefined ||
      !(await options.authentication.hasFreshPasskeyAction(sessionToken))
    ) {
      await options.records.recordPolicyDenial?.();
      return reply.code(403).send({ error: "Fresh Passkey Action required" });
    }
    return notificationPreferenceSchema.parse(
      await options.controls.configureNotification({
        email: body.email,
        from: body.from,
        notificationSubdomain: body.notificationSubdomain,
      }),
    );
  });
  api.post("/api/evidence/retention", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = applyEvidenceRetentionRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    if (
      options.controls.applyEvidenceLifecyclePolicy === undefined ||
      options.authentication.hasFreshPasskeyAction === undefined ||
      !(await options.authentication.hasFreshPasskeyAction(sessionToken))
    ) {
      await options.records.recordPolicyDenial?.();
      return reply.code(403).send({ error: "Fresh Passkey Action required" });
    }
    return evidenceRetentionResultSchema.parse(
      await options.controls.applyEvidenceLifecyclePolicy(),
    );
  });
}

function registerTelephoneControlRoutes(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly controls: TelephoneControls;
    readonly origin: string;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.get("/api/telephone/registration", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    return registeredTelephoneStatusSchema.parse({
      registration: (await options.controls.findRegisteredTelephone()) ?? null,
    });
  });

  api.post("/api/telephone/registration", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = registerTelephoneRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    if (
      options.authentication.hasFreshPasskeyAction === undefined ||
      !(await options.authentication.hasFreshPasskeyAction(sessionToken))
    ) {
      await options.records.recordPolicyDenial?.();
      return reply.code(403).send({ error: "Fresh Passkey Action required" });
    }
    return registeredTelephoneSchema.parse(
      await options.controls.registerTelephone({
        livekitInboundTrunkId: body.livekitInboundTrunkId,
        livekitOutboundTrunkId: body.livekitOutboundTrunkId,
        telephoneNumber: body.telephoneNumber,
        telnyxNumber: body.telnyxNumber,
      }),
    );
  });
}

/**
 * Read the challenge for a route, answering the owner instead of failing bare.
 *
 * Both deployment-authority routes need the same answer to the same question,
 * and an unanswered expiry during an attended ceremony was indistinguishable
 * from a server fault, so the mapping lives in one place.
 */
async function readUpgradeChallenge(
  reply: FastifyReply,
  promotionControl: NonNullable<TaskApiOptions["promotionControl"]>,
): Promise<DeploymentAuthorityUpgradeChallenge | undefined> {
  try {
    return await promotionControl.readDeploymentAuthorityUpgradeChallenge();
  } catch (error) {
    if (rejectDeploymentAuthorityChallenge(reply, error)) return undefined;
    throw error;
  }
}

/**
 * Log every refused challenge, and answer the routine ones.
 *
 * Returns whether the reply was sent: a routine rejection is the owner's to
 * act on and carries its message and reason, while an unexpected challenge
 * file stays a server fault whose detail never leaves the journal.
 */
function rejectDeploymentAuthorityChallenge(
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (!(error instanceof DeploymentAuthorityChallengeError)) return false;
  writeOperatorLogLine({
    level: error.routine ? 40 : 50,
    msg: "deployment-authority upgrade challenge rejected",
    reason: error.reason,
    routine: error.routine,
  });
  if (!error.routine) return false;
  void reply.code(409).send({ error: error.message, reason: error.reason });
  return true;
}

/**
 * One bounded line per rejection, shaped like the worker's operator lines so
 * one journal holds one log format.
 */
function writeOperatorLogLine(entry: {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}): void {
  process.stderr.write(`${JSON.stringify({ time: Date.now(), ...entry })}\n`);
}

function registerPromotionControlRoute(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly origin: string;
    readonly promotionControl: NonNullable<TaskApiOptions["promotionControl"]>;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.post(
    "/api/operations/deployment-authority/upgrade-authorization/options",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = csrfRequestSchema.parse(request.body);
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      const authorization = await readUpgradeChallenge(
        reply,
        options.promotionControl,
      );
      if (authorization === undefined) return reply;
      return { kind: authorization.kind, options: authorization.options };
    },
  );

  api.post(
    "/api/operations/deployment-authority/upgrade-authorization/verify",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = passkeyAuthenticationResponseRequestSchema.parse(request.body);
      if (!(await authorizeEvidence(request, options.authentication))) {
        await options.records.recordPolicyDenial?.();
        return reply.code(401).send({ error: "Authentication required" });
      }
      const authorization = await readUpgradeChallenge(
        reply,
        options.promotionControl,
      );
      if (authorization === undefined) return reply;
      if (body.ceremonyId !== authorization.challenge) {
        await options.records.recordPolicyDenial?.();
        return reply.code(403).send({ error: "Fresh Passkey Action required" });
      }
      let commit: string;
      try {
        commit = await options.promotionControl.requestDeploymentAuthorityUpgrade({
          ...authorization,
          response: body.response,
        });
      } catch (error) {
        if (rejectDeploymentAuthorityChallenge(reply, error)) return reply;
        throw error;
      }
      return reply.code(202).send(
        deploymentAuthorityUpgradeResponseSchema.parse({
          commit,
          status: "submitted",
        }),
      );
    },
  );

  api.post("/api/operations/promotions/resume", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = csrfRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    if (
      options.authentication.hasFreshPasskeyAction === undefined ||
      !(await options.authentication.hasFreshPasskeyAction(sessionToken))
    ) {
      await options.records.recordPolicyDenial?.();
      return reply.code(403).send({ error: "Fresh Passkey Action required" });
    }
    try {
      const commit = await options.promotionControl.requestResume();
      return reply.code(202).send(
        promotionResumeResponseSchema.parse({ commit, status: "queued" }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "No open Deployment Circuit Breaker"
      ) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });
}

function registerBountywellControlRoutes(
  api: FastifyInstance,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly controls: BountywellTaskControls;
    readonly origin: string;
    readonly records: EvidenceRecordReader;
  },
): void {
  api.get("/api/applications/bountywell", async (request, reply) => {
    if (!(await authorizeEvidence(request, options.authentication))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const registration = await options.controls.getBountywellRegistration();
    return bountywellRegistrationStatusSchema.parse({
      registration: registration ?? null,
    });
  });

  api.post(
    "/api/applications/bountywell/registration",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = registerBountywellRequestSchema.parse(request.body);
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (
        options.authentication.hasFreshPasskeyAction === undefined ||
        !(await options.authentication.hasFreshPasskeyAction(sessionToken))
      ) {
        await options.records.recordPolicyDenial?.();
        return reply.code(403).send({ error: "Fresh Passkey Action required" });
      }
      return bountywellRegistrationSchema.parse(
        await options.controls.registerBountywell(),
      );
    },
  );

  api.post(
    "/api/applications/bountywell/restart-authority",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = grantBountywellRestartRequestSchema.parse(request.body);
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (
        options.authentication.hasFreshPasskeyAction === undefined ||
        !(await options.authentication.hasFreshPasskeyAction(sessionToken))
      ) {
        await options.records.recordPolicyDenial?.();
        return reply.code(403).send({ error: "Fresh Passkey Action required" });
      }
      if (options.controls.grantBountywellRestart === undefined) {
        return reply.code(409).send({ error: "Bountywell restart grant is unavailable" });
      }
      const granted = await options.controls.grantBountywellRestart("fresh-passkey");
      if (granted.decision !== "granted") {
        await options.records.recordPolicyDenial?.();
        return reply.code(403).send({ error: granted.reason });
      }
      return bountywellRegistrationSchema.parse(granted.registration);
    },
  );

  api.post(
    "/api/operations/bountywell-outage-drill/arm-timer",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = bountywellDrillControlRequestSchema.parse(request.body);
      // Arming uses the already-enrolled Standing Autonomy Policy; only
      // enrolling the restart capability expands authority.
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (options.controls.armBountywellRecoveryTimer === undefined) {
        return reply.code(409).send({ error: "Recovery timer control is unavailable" });
      }
      return bountywellRecoveryTimerSchema.parse(
        await options.controls.armBountywellRecoveryTimer(),
      );
    },
  );

  api.post(
    "/api/operations/bountywell-outage-drill/prove-timer",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = bountywellDrillControlRequestSchema.parse(request.body);
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (options.controls.proveBountywellRecoveryTimer === undefined) {
        return reply.code(409).send({ error: "Recovery timer proof is unavailable" });
      }
      return bountywellRecoveryTimerProofSchema.parse(
        await options.controls.proveBountywellRecoveryTimer(),
      );
    },
  );

  api.post(
    "/api/operations/bountywell-outage-drill/inject",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const parsed = injectBountywellOutageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: bountywellOwnerUnavailable });
      }
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        parsed.data.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (options.controls.injectBountywellOutage === undefined) {
        return reply.code(409).send({ error: "Outage drill control is unavailable" });
      }
      try {
        const injected = await options.controls.injectBountywellOutage({
          ownerAvailable: parsed.data.ownerAvailable,
        });
        return reply.code(202).send(bountywellOutageInjectionSchema.parse(injected));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (error.message === bountywellOwnerUnavailable) {
          await options.records.recordPolicyDenial?.();
          return reply.code(400).send({ error: error.message });
        }
        // The guarded drill refuses to stop the registered unit until its
        // independent backstop is armed.
        if (error.message === "Recovery timer is not armed") {
          return reply.code(409).send({ error: error.message });
        }
        if (error.message === bountywellDrillNotRegistered) {
          return reply.code(403).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  api.post(
    "/api/operations/bountywell-outage-drill/present",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = bountywellDrillControlRequestSchema.parse(request.body);
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (options.controls.presentBountywellOutage === undefined) {
        return reply.code(409).send({ error: "Outage drill control is unavailable" });
      }
      let presented;
      try {
        presented = await options.controls.presentBountywellOutage();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === bountywellDrillNotRegistered
        ) {
          return reply.code(403).send({ error: error.message });
        }
        throw error;
      }
      if (presented === undefined) {
        return reply.code(409).send({ error: bountywellOutageNotPresented });
      }
      // The Voice Agent is handed this sentence and nothing else about the drill.
      return reply
        .code(202)
        .send(bountywellOutageInjectionSchema.parse(presented));
    },
  );

  api.post("/api/tasks/bountywell-health", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = submitBountywellHealthRequestSchema.parse(request.body);
    const sessionToken = await authorizeStateChange(
      request,
      reply,
      options.authentication,
      body.csrfToken,
      options.records,
    );
    if (sessionToken === undefined) return;
    try {
      const record = await options.controls.acceptBountywellHealthInquiry({
        question: "Is Bountywell healthy?",
        requestId: body.requestId,
      });
      return reply.code(202).send(evidenceRecordProjectionSchema.parse(record));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Bountywell is not registered"
      ) {
        await options.records.recordPolicyDenial?.();
        return reply.code(409).send({ error: "Bountywell is not registered" });
      }
      if (
        error instanceof Error &&
        error.message === "Evidence Record retention expired"
      ) {
        return reply.code(410).send({ error: "Evidence Record expired" });
      }
      throw error;
    }
  });
  api.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/stop",
    async (request, reply) => {
      if (!requireOrigin(request, reply, options.origin)) return;
      const body = stopTaskRequestSchema.parse(request.body);
      const sessionToken = await authorizeStateChange(
        request,
        reply,
        options.authentication,
        body.csrfToken,
        options.records,
      );
      if (sessionToken === undefined) return;
      if (options.controls.requestStop === undefined) {
        return reply.code(409).send({ error: "Task cancellation is unavailable" });
      }
      return evidenceRecordProjectionSchema.parse(
        await options.controls.requestStop({
          requestId: body.requestId,
          taskId: request.params.taskId,
        }),
      );
    },
  );
}

function registerAuthenticationRoutes(
  api: FastifyInstance,
  options: VoiceApiOptions,
): void {
  const loginAdmission = createLoginCeremonyAdmission();
  api.get("/api/auth/status", async () =>
    authenticationStatusSchema.parse(await options.authentication.status()),
  );

  api.post("/api/auth/registration/options", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = registrationOptionsRequestSchema.parse(request.body);
    try {
      if (body.mode === "bootstrap") {
        return await options.authentication.beginBootstrapRegistration(body);
      }
      return await options.authentication.beginRecoveryRegistration({
        csrfToken: body.csrfToken,
        label: body.label,
        sessionToken: requireSessionToken(request),
      });
    } catch {
      return authenticationFailed(reply);
    }
  });

  api.post("/api/auth/registration/verify", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = passkeyResponseRequestSchema.parse(request.body);
    try {
      const sessionToken = request.cookies[trustedSessionCookieName];
      const result = await options.authentication.finishRegistration(
        sessionToken === undefined
          ? { response: body.response }
          : { response: body.response, sessionToken },
      );
      if (sessionToken !== undefined) clearSessionCookies(reply);
      return passkeyEnrollmentResultSchema.parse(result);
    } catch {
      return authenticationFailed(reply);
    }
  });

  api.post("/api/auth/login/options", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    if (!loginAdmission.admit(request.ip)) {
      return reply.code(429).send({ error: "Login ceremony rate limit reached" });
    }
    try {
      return await options.authentication.beginLogin();
    } catch {
      return authenticationFailed(reply);
    }
  });

  api.post("/api/auth/login/verify", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = passkeyAuthenticationResponseRequestSchema.parse(request.body);
    try {
      const session = await options.authentication.finishLogin(body);
      setSessionCookies(
        reply,
        session.sessionToken,
        session.csrfToken,
        session.expiresAt,
      );
      return trustedBrowserSessionResponseSchema.parse({
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
        freshUntil: session.freshUntil,
      });
    } catch {
      return authenticationFailed(reply);
    }
  });

  api.post("/api/auth/fresh/options", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = csrfRequestSchema.parse(request.body);
    try {
      return await options.authentication.beginFreshPasskeyAction({
        csrfToken: body.csrfToken,
        sessionToken: requireSessionToken(request),
      });
    } catch {
      return csrfFailed(reply);
    }
  });

  api.post("/api/auth/fresh/verify", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = passkeyAuthenticationResponseRequestSchema.parse(request.body);
    try {
      return freshPasskeyActionResponseSchema.parse(
        await options.authentication.finishFreshPasskeyAction({
          ceremonyId: body.ceremonyId,
          response: body.response,
          sessionToken: requireSessionToken(request),
        }),
      );
    } catch {
      return authenticationFailed(reply);
    }
  });

  api.post("/api/auth/recovery", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = recoveryRequestSchema.parse(request.body);
    try {
      const session = await options.authentication.recover(body.recoveryCode);
      setSessionCookies(
        reply,
        session.sessionToken,
        session.csrfToken,
        session.expiresAt,
      );
      return recoverySessionResponseSchema.parse({
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      });
    } catch {
      return authenticationFailed(reply);
    }
  });

  api.post("/api/auth/recovery-codes/confirm", async (request, reply) => {
    if (!requireOrigin(request, reply, options.origin)) return;
    const body = recoveryCodesConfirmationRequestSchema.parse(request.body);
    try {
      return authenticationStatusSchema.parse(
        await options.authentication.confirmRecoveryCodes(body),
      );
    } catch {
      return authenticationFailed(reply);
    }
  });
}

async function authorizeEvidence(
  request: FastifyRequest,
  authentication: EvidenceRecordAuthentication,
): Promise<boolean> {
  const sessionToken = request.cookies[trustedSessionCookieName];
  return (
    sessionToken !== undefined &&
    (await authentication.canViewEvidence(sessionToken))
  );
}

async function authorizeStateChange(
  request: FastifyRequest,
  reply: FastifyReply,
  authentication: EvidenceRecordAuthentication,
  csrfToken: string,
  records: EvidenceRecordReader,
): Promise<string | undefined> {
  const sessionToken = request.cookies[trustedSessionCookieName];
  if (sessionToken === undefined) {
    await records.recordPolicyDenial?.();
    void reply.code(401).send({ error: "Authentication required" });
    return undefined;
  }
  if (
    authentication.canChangeState === undefined ||
    !(await authentication.canChangeState({ csrfToken, sessionToken }))
  ) {
    await records.recordPolicyDenial?.();
    void reply.code(403).send({ error: "CSRF validation failed" });
    return undefined;
  }
  return sessionToken;
}

async function authorizeAdministrativeOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  authentication: EvidenceRecordAuthentication,
  csrfToken: string,
  records: EvidenceRecordReader,
): Promise<string | undefined> {
  const sessionToken = await authorizeStateChange(
    request,
    reply,
    authentication,
    csrfToken,
    records,
  );
  if (sessionToken === undefined) return undefined;
  const ownerId = await authentication.authenticatedOwnerId?.(sessionToken);
  if (ownerId === undefined) {
    await records.recordPolicyDenial?.();
    void reply.code(403).send({ error: "Owner session required" });
    return undefined;
  }
  return ownerId;
}

async function authorizeFreshAction(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    readonly authentication: EvidenceRecordAuthentication;
    readonly records: EvidenceRecordReader;
  },
  csrfToken: string,
): Promise<string | undefined> {
  const sessionToken = await authorizeStateChange(
    request,
    reply,
    options.authentication,
    csrfToken,
    options.records,
  );
  if (sessionToken === undefined) return undefined;
  if (
    options.authentication.hasFreshPasskeyAction === undefined ||
    !(await options.authentication.hasFreshPasskeyAction(sessionToken))
  ) {
    await options.records.recordPolicyDenial?.();
    void reply.code(403).send({ error: "Fresh Passkey Action required" });
    return undefined;
  }
  return sessionToken;
}

function emptyOperationalMetrics(): Awaited<
  ReturnType<NonNullable<EvidenceRecordReader["readOperationalMetrics"]>>
> {
  return {
    bountywellChecks: [],
    notifications: { requested: 0, sent: 0 },
    operations: { accepted: 0, completed: 0, running: 0 },
    policyDenials: 0,
    speech: { interruptions: 0, timings: [], turns: 0 },
    storage: { databaseBytes: 0, filesystemAvailableBytes: 0 },
    tasks: { completed: 0, pending: 0 },
  };
}

function renderOperationalMetrics(
  metrics: Awaited<
    ReturnType<NonNullable<EvidenceRecordReader["readOperationalMetrics"]>>
  >,
  additionalMetrics: string,
): string {
  const lines = [
    "# HELP voice_agent_durable_tasks Current Durable Tasks by status.",
    "# TYPE voice_agent_durable_tasks gauge",
    `voice_agent_durable_tasks{status="pending"} ${metrics.tasks.pending}`,
    `voice_agent_durable_tasks{status="completed"} ${metrics.tasks.completed}`,
    "# HELP voice_agent_operations Current Operations by status.",
    "# TYPE voice_agent_operations gauge",
    `voice_agent_operations{status="accepted"} ${metrics.operations.accepted}`,
    `voice_agent_operations{status="running"} ${metrics.operations.running}`,
    `voice_agent_operations{status="completed"} ${metrics.operations.completed}`,
    "# HELP voice_agent_policy_denials_total State-changing requests denied by policy.",
    "# TYPE voice_agent_policy_denials_total counter",
    `voice_agent_policy_denials_total ${metrics.policyDenials}`,
    "# HELP voice_agent_sqlite_database_bytes Bytes used by the SQLite database and WAL files.",
    "# TYPE voice_agent_sqlite_database_bytes gauge",
    `voice_agent_sqlite_database_bytes ${metrics.storage.databaseBytes}`,
    "# HELP voice_agent_sqlite_filesystem_available_bytes Bytes available on the SQLite filesystem.",
    "# TYPE voice_agent_sqlite_filesystem_available_bytes gauge",
    `voice_agent_sqlite_filesystem_available_bytes ${metrics.storage.filesystemAvailableBytes}`,
    "# HELP voice_agent_bountywell_check_pass Whether the latest bounded check passed.",
    "# TYPE voice_agent_bountywell_check_pass gauge",
    ...metrics.bountywellChecks.map(
      (check) =>
        `voice_agent_bountywell_check_pass{source="${check.source}"} ${check.outcome === "pass" ? 1 : 0}`,
    ),
    "# HELP voice_agent_callback_handshakes Current Callback Handshakes by outcome.",
    "# TYPE voice_agent_callback_handshakes gauge",
    `voice_agent_callback_handshakes{outcome="pending"} ${metrics.callbacks?.handshakes.pending ?? 0}`,
    `voice_agent_callback_handshakes{outcome="authorized"} ${metrics.callbacks?.handshakes.authorized ?? 0}`,
    `voice_agent_callback_handshakes{outcome="failed"} ${metrics.callbacks?.handshakes.failed ?? 0}`,
    "# HELP voice_agent_callback_attempts Callback attempts retained in the live evidence window.",
    "# TYPE voice_agent_callback_attempts gauge",
    `voice_agent_callback_attempts ${metrics.callbacks?.attempts ?? 0}`,
    "# HELP voice_agent_notifications Silent Notification lifecycle events retained in the Evidence window.",
    "# TYPE voice_agent_notifications gauge",
    `voice_agent_notifications{outcome="requested"} ${metrics.notifications.requested}`,
    `voice_agent_notifications{outcome="sent"} ${metrics.notifications.sent}`,
    "# HELP voice_agent_telephone_turns Sanitized finalized Telephone Session turns retained in the Evidence window.",
    "# TYPE voice_agent_telephone_turns gauge",
    `voice_agent_telephone_turns ${metrics.speech.turns}`,
    "# HELP voice_agent_telephone_interruptions Interrupted semantic responses retained in the Evidence window.",
    "# TYPE voice_agent_telephone_interruptions gauge",
    `voice_agent_telephone_interruptions ${metrics.speech.interruptions}`,
    "# HELP voice_agent_speech_stage_duration_ms_sum Sum of sanitized provider timing retained by bounded speech stage and provider.",
    "# TYPE voice_agent_speech_stage_duration_ms_sum gauge",
    "# HELP voice_agent_speech_stage_duration_ms_count Count of sanitized provider timing retained by bounded speech stage and provider.",
    "# TYPE voice_agent_speech_stage_duration_ms_count gauge",
    ...metrics.speech.timings.flatMap((timing) => {
      const labels = `stage="${timing.stage}",provider="${timing.provider}"`;
      return [
        `voice_agent_speech_stage_duration_ms_sum{${labels}} ${timing.totalDurationMs}`,
        `voice_agent_speech_stage_duration_ms_count{${labels}} ${timing.count}`,
      ];
    }),
  ];
  if (additionalMetrics.trim().length > 0) {
    lines.push(additionalMetrics.trim());
  }
  return `${lines.join("\n")}\n`;
}

function requireOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedOrigin: string,
): boolean {
  if (request.headers.origin !== expectedOrigin) {
    void reply.code(403).send({ error: "Origin validation failed" });
    return false;
  }
  return true;
}

function requireSessionToken(request: FastifyRequest): string {
  const value = request.cookies[trustedSessionCookieName];
  if (value === undefined) throw new Error("Authentication required");
  return value;
}

function setSessionCookies(
  reply: FastifyReply,
  sessionToken: string,
  csrfToken: string,
  expiresAt: string,
): void {
  const cookieOptions: CookieSerializeOptions = {
    expires: new Date(expiresAt),
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: true,
  };
  reply.setCookie(trustedSessionCookieName, sessionToken, cookieOptions);
  reply.setCookie(csrfCookieName, csrfToken, {
    ...cookieOptions,
    httpOnly: false,
  });
}

function clearSessionCookies(reply: FastifyReply): void {
  const options: CookieSerializeOptions = {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: true,
  };
  reply.clearCookie(trustedSessionCookieName, options);
  reply.clearCookie(csrfCookieName, { ...options, httpOnly: false });
}

function authenticationFailed(reply: FastifyReply) {
  return reply.code(401).send({ error: "Authentication failed" });
}

function csrfFailed(reply: FastifyReply) {
  return reply.code(403).send({ error: "CSRF validation failed" });
}
