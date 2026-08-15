import cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { AuthenticationLifecycle } from "@voice-agent/auth";
import {
  authenticationStatusSchema,
  csrfRequestSchema,
  evidenceRecordProjectionSchema,
  evidenceRecordSummaryListSchema,
  freshPasskeyActionResponseSchema,
  originSecurityHeaders,
  passkeyAuthenticationResponseRequestSchema,
  passkeyEnrollmentResultSchema,
  passkeyResponseRequestSchema,
  recoveryCodesConfirmationRequestSchema,
  recoveryRequestSchema,
  recoverySessionResponseSchema,
  registrationOptionsRequestSchema,
  trustedBrowserSessionResponseSchema,
  type EvidenceRecordProjection,
  type EvidenceRecordSummary,
} from "@voice-agent/contracts";

export interface EvidenceRecordReader {
  getEvidenceRecord(taskId: string): Promise<EvidenceRecordProjection | undefined>;
  listEvidenceRecords?(): Promise<readonly EvidenceRecordSummary[]>;
}

export interface EvidenceRecordAuthentication {
  canViewEvidence(sessionToken: string): Promise<boolean>;
}

export interface TaskApiOptions {
  readonly authentication: EvidenceRecordAuthentication;
  readonly records: EvidenceRecordReader;
}

export interface VoiceApiOptions {
  readonly authentication: AuthenticationLifecycle;
  readonly origin: string;
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
      return evidenceRecordProjectionSchema.parse(record);
    },
  );
  return api;
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
