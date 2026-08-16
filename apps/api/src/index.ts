import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { AuthenticationLifecycle } from "@voice-agent/auth";
import {
  authenticationStatusSchema,
  bountywellRegistrationSchema,
  bountywellRegistrationStatusSchema,
  csrfRequestSchema,
  evidenceRecordProjectionSchema,
  evidenceRecordSummaryListSchema,
  freshPasskeyActionResponseSchema,
  originSecurityHeaders,
  passkeyAuthenticationResponseRequestSchema,
  passkeyEnrollmentResultSchema,
  passkeyResponseRequestSchema,
  promotionResumeResponseSchema,
  promotionEvidenceRecordProjectionSchema,
  recoveryCodesConfirmationRequestSchema,
  recoveryRequestSchema,
  recoverySessionResponseSchema,
  registerBountywellRequestSchema,
  registrationOptionsRequestSchema,
  submitBountywellHealthRequestSchema,
  trustedBrowserSessionResponseSchema,
  type BountywellRegistration,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
  type VoiceAgentEvidenceRecordProjection,
} from "@voice-agent/contracts";

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
    readonly operations: {
      readonly accepted: number;
      readonly completed: number;
      readonly running: number;
    };
    readonly policyDenials: number;
    readonly storage: {
      readonly databaseBytes: number;
      readonly filesystemAvailableBytes: number;
    };
    readonly tasks: { readonly completed: number; readonly pending: number };
  }>;
  recordPolicyDenial?(): Promise<void>;
}

export interface EvidenceRecordAuthentication {
  canChangeState?(input: {
    readonly csrfToken: string;
    readonly sessionToken: string;
  }): Promise<boolean>;
  canViewEvidence(sessionToken: string): Promise<boolean>;
  hasFreshPasskeyAction?(sessionToken: string): Promise<boolean>;
}

export interface BountywellTaskControls {
  acceptBountywellHealthInquiry(input: {
    readonly question: "Is Bountywell healthy?";
    readonly requestId: string;
  }): Promise<EvidenceRecordProjection>;
  getBountywellRegistration(): Promise<BountywellRegistration | undefined>;
  registerBountywell(): Promise<BountywellRegistration>;
}

export interface TaskApiOptions {
  readonly additionalMetrics?: (() => Promise<string>) | undefined;
  readonly authentication: EvidenceRecordAuthentication;
  readonly controls?: BountywellTaskControls;
  readonly origin?: string;
  readonly promotionControl?: {
    requestResume(): Promise<string>;
  } | undefined;
  readonly records: EvidenceRecordReader;
}

export interface VoiceApiOptions {
  readonly additionalMetrics?: (() => Promise<string>) | undefined;
  readonly authentication: AuthenticationLifecycle;
  readonly controls?: BountywellTaskControls;
  readonly origin: string;
  readonly promotionControl?: {
    requestResume(): Promise<string>;
  } | undefined;
  readonly records: EvidenceRecordReader;
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
      return record.task.kind === "human-merge.promotion"
        ? promotionEvidenceRecordProjectionSchema.parse(record)
        : evidenceRecordProjectionSchema.parse(record);
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
  if (options.promotionControl !== undefined && options.origin !== undefined) {
    registerPromotionControlRoute(api, {
      authentication: options.authentication,
      origin: options.origin,
      promotionControl: options.promotionControl,
      records: options.records,
    });
  }
  return api;
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

function emptyOperationalMetrics(): Awaited<
  ReturnType<NonNullable<EvidenceRecordReader["readOperationalMetrics"]>>
> {
  return {
    bountywellChecks: [],
    operations: { accepted: 0, completed: 0, running: 0 },
    policyDenials: 0,
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
