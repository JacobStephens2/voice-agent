import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { promisify } from "node:util";

import {
  bountywellHealthObservationRequestSchema,
  bountywellHealthObservationSchema,
  type BountywellHealthObservation,
  type BountywellHealthObservationRequest,
  type BountywellHealthObserver,
} from "@voice-agent/contracts";

const SAME_HOST_UNCERTAINTY =
  "This same-host inquiry cannot independently detect loss of the Agent Host or its network.";
const INTERRUPTED_OPERATION_UNCERTAINTY =
  "The accepted broker Operation was interrupted; its read-only probes were not repeated after restart.";
const RESOURCE_UNAVAILABLE_UNCERTAINTY =
  "Bounded service resource evidence was unavailable.";
const BOUNTYWELL_UNIT = "bountywell-api.service";
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_TASKS = 128;
const executeFile = promisify(execFile);

interface BountywellUnitProperties {
  readonly ActiveState: string;
  readonly MemoryCurrent: string;
  readonly SubState: string;
  readonly TasksCurrent: string;
}

export function createBountywellHostProbes(
  dependencies: {
    readonly readUnitProperties?: (
      unit: string,
    ) => Promise<BountywellUnitProperties>;
    readonly requestStatus?: (url: string) => Promise<number>;
  } = {},
): BountywellHostProbes {
  const readUnitProperties =
    dependencies.readUnitProperties ?? readSystemdUnitProperties;
  const requestStatus = dependencies.requestStatus ?? requestHttpStatus;

  return {
    readAuthenticationBoundaryStatus: () =>
      requestStatus("https://bountywell.com/api/data"),
    readLocalHealthStatus: () =>
      requestStatus("http://127.0.0.1:3000/api/health"),
    readPublicHealthStatus: () =>
      requestStatus("https://bountywell.com/api/health"),
    async readResourceEvidence() {
      try {
        const properties = await readUnitProperties(BOUNTYWELL_UNIT);
        const memory = parseBoundedInteger(properties.MemoryCurrent);
        const tasks = parseBoundedInteger(properties.TasksCurrent);
        if (memory === undefined || tasks === undefined) {
          return { availability: "unavailable" as const };
        }
        return {
          availability: "available" as const,
          memoryPressure: memory > MAX_MEMORY_BYTES,
          taskPressure: tasks > MAX_TASKS,
        };
      } catch {
        return { availability: "unavailable" as const };
      }
    },
    async readServiceMetadata() {
      try {
        const properties = await readUnitProperties(BOUNTYWELL_UNIT);
        return {
          active: properties.ActiveState === "active",
          subState:
            properties.SubState === "running" ? "running" : "not-running",
        };
      } catch {
        return { active: false, subState: "unavailable" };
      }
    },
  };
}

export interface BountywellHostProbes {
  readAuthenticationBoundaryStatus(): Promise<number>;
  readLocalHealthStatus(): Promise<number>;
  readPublicHealthStatus(): Promise<number>;
  readResourceEvidence(): Promise<
    | {
        readonly availability: "available";
        readonly memoryPressure: boolean;
        readonly taskPressure: boolean;
      }
    | { readonly availability: "unavailable" }
  >;
  readServiceMetadata(): Promise<{
    readonly active: boolean;
    readonly subState: "not-running" | "running" | "unavailable";
  }>;
}

export interface VoiceAgentApplicationProbes {
  readApiHealthStatus(): Promise<number>;
  readBrokerHealthStatus(): Promise<number>;
  readWorkerHealthStatus(): Promise<number>;
}

export async function renderApplicationProbeMetrics(options: {
  readonly bountywell: BountywellHostProbes;
  readonly now?: () => Date;
  readonly voiceAgent: VoiceAgentApplicationProbes;
}): Promise<string> {
  const probes = await Promise.all([
    probe("voice-agent", "api-health", async () =>
      (await options.voiceAgent.readApiHealthStatus()) === 200),
    probe("voice-agent", "worker-health", async () =>
      (await options.voiceAgent.readWorkerHealthStatus()) === 200),
    probe("voice-agent", "broker-health", async () =>
      (await options.voiceAgent.readBrokerHealthStatus()) === 200),
    probe("bountywell", "public-health", async () =>
      (await options.bountywell.readPublicHealthStatus()) === 200),
    probe("bountywell", "authentication-boundary", async () =>
      (await options.bountywell.readAuthenticationBoundaryStatus()) === 401),
    probe("bountywell", "local-health", async () =>
      (await options.bountywell.readLocalHealthStatus()) === 200),
    probe("bountywell", "service-state", async () => {
      const service = await options.bountywell.readServiceMetadata();
      return service.active && service.subState === "running";
    }),
    probe("bountywell", "resource-health", async () => {
      const resources = await options.bountywell.readResourceEvidence();
      return resources.availability === "available" &&
        !resources.memoryPressure && !resources.taskPressure;
    }),
  ]);
  const now = options.now?.() ?? new Date();
  const lines = [
    "# HELP voice_agent_application_probe_success Whether an explicit bounded application or API probe passed.",
    "# TYPE voice_agent_application_probe_success gauge",
    ...probes.map(
      ({ application, name, success }) =>
        `voice_agent_application_probe_success{application="${application}",probe="${name}"} ${success ? 1 : 0}`,
    ),
    "# HELP voice_agent_application_probe_last_run_unixtime_seconds Unix time of the latest explicit probe run.",
    "# TYPE voice_agent_application_probe_last_run_unixtime_seconds gauge",
    `voice_agent_application_probe_last_run_unixtime_seconds ${Math.floor(now.getTime() / 1_000)}`,
    "# HELP voice_agent_monitoring_same_host Monitoring shares the Agent Host failure domain and is not an independent availability signal.",
    "# TYPE voice_agent_monitoring_same_host gauge",
    "voice_agent_monitoring_same_host 1",
  ];
  return `${lines.join("\n")}\n`;
}

async function probe(
  application: "bountywell" | "voice-agent",
  name: "api-health" | "authentication-boundary" | "broker-health" |
    "local-health" | "public-health" | "resource-health" | "service-state" |
    "worker-health",
  check: () => Promise<boolean>,
): Promise<{
  readonly application: "bountywell" | "voice-agent";
  readonly name: typeof name;
  readonly success: boolean;
}> {
  try {
    return { application, name, success: await check() };
  } catch {
    return { application, name, success: false };
  }
}

export interface BrokerOperationStore {
  begin(
    request: BountywellHealthObservationRequest,
    acceptedAt: string,
  ): Promise<
    | { readonly kind: "completed"; readonly observation: BountywellHealthObservation }
    | { readonly kind: "execute" }
    | { readonly acceptedAt: string; readonly kind: "interrupted" }
  >;
  close(): Promise<void>;
  complete(
    request: BountywellHealthObservationRequest,
    observation: BountywellHealthObservation,
  ): Promise<BountywellHealthObservation>;
}

export interface OperationsBrokerServer {
  close(): Promise<void>;
  listen(socketPath: string): Promise<void>;
}

export function createOperationsBrokerServer(options: {
  readonly observer: BountywellHealthObserver;
}): OperationsBrokerServer {
  let activeSocketPath: string | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200);
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/bountywell/health") {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      const body = await readBoundedBody(request, 4_096);
      const operationRequest = bountywellHealthObservationRequestSchema.parse(
        JSON.parse(body),
      );
      const observation = bountywellHealthObservationSchema.parse(
        await options.observer.observe(operationRequest),
      );
      response.writeHead(200);
      response.end(JSON.stringify(observation));
    } catch {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "Invalid broker request" }));
    }
  });

  return {
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
      if (activeSocketPath !== undefined) {
        await unlink(activeSocketPath).catch((error: unknown) => {
          if (!isMissingFile(error)) throw error;
        });
      }
    },
    async listen(socketPath) {
      await unlink(socketPath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(socketPath, () => {
          server.off("error", failed);
          activeSocketPath = socketPath;
          resolve();
        });
      });
    },
  };
}

export function createUnixSocketBountywellObserver(
  socketPath: string,
): BountywellHealthObserver {
  return {
    async observe(rawRequest) {
      const operationRequest =
        bountywellHealthObservationRequestSchema.parse(rawRequest);
      const body = JSON.stringify(operationRequest);
      const responseBody = await new Promise<string>((resolve, reject) => {
        const request = requestHttp(
          {
            headers: {
              "Content-Length": Buffer.byteLength(body),
              "Content-Type": "application/json",
            },
            method: "POST",
            path: "/v1/bountywell/health",
            socketPath,
            timeout: 10_000,
          },
          (response) => {
            readBoundedBody(response, 64 * 1_024)
              .then((responseBody) => {
                if (response.statusCode !== 200) {
                  reject(new Error("Operations Broker rejected the inquiry"));
                  return;
                }
                resolve(responseBody);
              })
              .catch(reject);
          },
        );
        request.on("error", reject);
        request.on("timeout", () => {
          request.destroy(new Error("Operations Broker timed out"));
        });
        request.end(body);
      });
      return bountywellHealthObservationSchema.parse(JSON.parse(responseBody));
    },
  };
}

export function createBountywellOperationsBroker(options: {
  readonly now: () => string;
  readonly probes: BountywellHostProbes;
  readonly store: BrokerOperationStore;
}): BountywellHealthObserver {
  const inFlight = new Map<
    string,
    {
      readonly promise: Promise<BountywellHealthObservation>;
      readonly taskId: string;
    }
  >();

  return {
    async observe(rawRequest) {
      const request = bountywellHealthObservationRequestSchema.parse(rawRequest);
      const active = inFlight.get(request.operationId);
      if (active !== undefined) {
        if (active.taskId !== request.taskId) {
          throw new Error(
            "Broker Operation identity belongs to another Durable Task",
          );
        }
        return active.promise;
      }

      const observation = observeDurably(options, request);
      inFlight.set(request.operationId, {
        promise: observation,
        taskId: request.taskId,
      });
      try {
        return await observation;
      } finally {
        inFlight.delete(request.operationId);
      }
    },
  };
}

async function observeDurably(
  options: {
    readonly now: () => string;
    readonly probes: BountywellHostProbes;
    readonly store: BrokerOperationStore;
  },
  request: BountywellHealthObservationRequest,
): Promise<BountywellHealthObservation> {
  const begun = await options.store.begin(request, options.now());
  if (begun.kind === "completed") return begun.observation;
  if (begun.kind === "interrupted") {
    return options.store.complete(
      request,
      createInterruptedObservation(options.now()),
    );
  }
  return options.store.complete(request, await observeOnce(options));
}

async function observeOnce(options: {
  readonly now: () => string;
  readonly probes: BountywellHostProbes;
}): Promise<BountywellHealthObservation> {
  const [publicStatus, authenticationStatus, localStatus, service, resources] =
    await Promise.all([
      options.probes.readPublicHealthStatus(),
      options.probes.readAuthenticationBoundaryStatus(),
      options.probes.readLocalHealthStatus(),
      options.probes.readServiceMetadata(),
      options.probes.readResourceEvidence(),
    ]);
  const serviceHealthy = service.active && service.subState === "running";
  const resourcesHealthy =
    resources.availability === "available" &&
    !resources.memoryPressure &&
    !resources.taskPressure;

  return bountywellHealthObservationSchema.parse({
    checks: [
      {
        facts: { statusCode: publicStatus },
        outcome: publicStatus === 200 ? "pass" : "fail",
        provenance: "bountywell-public:/api/health",
        source: "public-health",
        summary:
          publicStatus === 200
            ? "The public health endpoint returned the required 200 status."
            : "The public health endpoint did not return the required 200 status.",
      },
      {
        facts: { statusCode: authenticationStatus },
        outcome: authenticationStatus === 401 ? "pass" : "fail",
        provenance: "bountywell-public:/api/data",
        source: "authentication-boundary",
        summary:
          authenticationStatus === 401
            ? "The protected data endpoint preserved its 401 boundary."
            : "The protected data endpoint did not preserve its 401 boundary.",
      },
      {
        facts: { statusCode: localStatus },
        outcome: localStatus === 200 ? "pass" : "fail",
        provenance: "bountywell-local:/api/health",
        source: "local-health",
        summary:
          localStatus === 200
            ? "The registered local health endpoint returned 200."
            : "The registered local health endpoint did not return 200.",
      },
      {
        facts: service,
        outcome: serviceHealthy ? "pass" : "fail",
        provenance: "systemd:bountywell-api.service",
        source: "service-state",
        summary: serviceHealthy
          ? "The registered systemd unit is active and running."
          : "The registered systemd unit is not active and running.",
      },
      {
        facts: resources,
        outcome: resourcesHealthy ? "pass" : "fail",
        provenance: "systemd:bountywell-api.service:cgroup",
        source: "resource-health",
        summary:
          resources.availability === "unavailable"
            ? "Bounded service resource evidence was unavailable."
            : resourcesHealthy
              ? "Bounded service resource thresholds are not under pressure."
              : "A bounded service resource threshold is under pressure.",
      },
    ],
    observedAt: options.now(),
    rejectedEvidenceCount: 0,
    uncertainty:
      resources.availability === "unavailable"
        ? `${SAME_HOST_UNCERTAINTY} ${RESOURCE_UNAVAILABLE_UNCERTAINTY}`
        : SAME_HOST_UNCERTAINTY,
  });
}

function createInterruptedObservation(
  observedAt: string,
): BountywellHealthObservation {
  return bountywellHealthObservationSchema.parse({
    checks: [
      {
        facts: { statusCode: 599 },
        outcome: "fail",
        provenance: "bountywell-public:/api/health",
        source: "public-health",
        summary: "The interrupted Operation did not retain a public health observation.",
      },
      {
        facts: { statusCode: 599 },
        outcome: "fail",
        provenance: "bountywell-public:/api/data",
        source: "authentication-boundary",
        summary: "The interrupted Operation did not retain authentication-boundary evidence.",
      },
      {
        facts: { statusCode: 599 },
        outcome: "fail",
        provenance: "bountywell-local:/api/health",
        source: "local-health",
        summary: "The interrupted Operation did not retain a local health observation.",
      },
      {
        facts: { active: false, subState: "unavailable" },
        outcome: "fail",
        provenance: "systemd:bountywell-api.service",
        source: "service-state",
        summary: "The interrupted Operation did not retain service-state evidence.",
      },
      {
        facts: { availability: "unavailable" },
        outcome: "fail",
        provenance: "systemd:bountywell-api.service:cgroup",
        source: "resource-health",
        summary: "The interrupted Operation did not retain resource evidence.",
      },
    ],
    observedAt,
    rejectedEvidenceCount: 0,
    uncertainty: `${SAME_HOST_UNCERTAINTY} ${INTERRUPTED_OPERATION_UNCERTAINTY}`,
  });
}

export function createSqliteBrokerOperationStore(
  databasePath: string,
): BrokerOperationStore {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS broker_operations (
      operation_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
  `);
  const findOperation = database.prepare<
    [operationId: string],
    { readonly result_json: string; readonly task_id: string }
  >(`
    SELECT task_id, result_json
    FROM broker_operations
    WHERE operation_id = ?
  `);
  const insertOperation = database.prepare(`
    INSERT INTO broker_operations (operation_id, task_id, result_json)
    VALUES (?, ?, ?)
  `);
  const updateOperation = database.prepare(`
    UPDATE broker_operations
    SET result_json = ?
    WHERE operation_id = ? AND task_id = ?
  `);

  const beginTransaction = database.transaction(
    (
      request: BountywellHealthObservationRequest,
      acceptedAt: string,
    ) => {
      const row = findOperation.get(request.operationId);
      if (row === undefined) {
        insertOperation.run(
          request.operationId,
          request.taskId,
          JSON.stringify({ acceptedAt, status: "accepted" }),
        );
        return { kind: "execute" as const };
      }
      requireMatchingBrokerTask(row.task_id, request.taskId);
      const state = parseStoredBrokerOperation(row.result_json);
      return state.kind === "completed"
        ? state
        : {
            acceptedAt: state.acceptedAt,
            kind: "interrupted" as const,
          };
    },
  );

  const completeTransaction = database.transaction(
    (
      request: BountywellHealthObservationRequest,
      observation: BountywellHealthObservation,
    ): BountywellHealthObservation => {
      const row = findOperation.get(request.operationId);
      if (row === undefined) {
        throw new Error("Broker Operation was not accepted before completion");
      }
      requireMatchingBrokerTask(row.task_id, request.taskId);
      const state = parseStoredBrokerOperation(row.result_json);
      if (state.kind === "completed") return state.observation;
      updateOperation.run(
        JSON.stringify(observation),
        request.operationId,
        request.taskId,
      );
      return observation;
    },
  );

  return {
    async begin(request, acceptedAt) {
      return beginTransaction.immediate(request, acceptedAt);
    },
    async close() {
      database.close();
    },
    async complete(request, observation) {
      return completeTransaction.immediate(request, observation);
    },
  };
}

function parseStoredBrokerOperation(resultJson: string):
  | { readonly acceptedAt: string; readonly kind: "accepted" }
  | {
      readonly kind: "completed";
      readonly observation: BountywellHealthObservation;
    } {
  const value = JSON.parse(resultJson) as unknown;
  const completed = bountywellHealthObservationSchema.safeParse(value);
  if (completed.success) {
    return { kind: "completed", observation: completed.data };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "accepted" &&
    "acceptedAt" in value &&
    typeof value.acceptedAt === "string" &&
    !Number.isNaN(Date.parse(value.acceptedAt))
  ) {
    return { acceptedAt: value.acceptedAt, kind: "accepted" };
  }
  throw new Error("Broker Operation state is invalid");
}

function requireMatchingBrokerTask(actualTaskId: string, taskId: string): void {
  if (actualTaskId !== taskId) {
    throw new Error("Broker Operation identity belongs to another Durable Task");
  }
}

async function requestHttpStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 599;
  }
}

async function readSystemdUnitProperties(
  unit: string,
): Promise<BountywellUnitProperties> {
  if (unit !== BOUNTYWELL_UNIT) {
    throw new Error("Unsupported systemd unit");
  }
  const { stdout } = await executeFile("systemctl", [
    "show",
    BOUNTYWELL_UNIT,
    "--no-pager",
    "--property=ActiveState,SubState,MemoryCurrent,TasksCurrent",
  ], { timeout: 5_000 });
  const properties = Object.fromEntries(
    stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return {
    ActiveState: properties.ActiveState ?? "",
    MemoryCurrent: properties.MemoryCurrent ?? "",
    SubState: properties.SubState ?? "",
    TasksCurrent: properties.TasksCurrent ?? "",
  };
}

function parseBoundedInteger(value: string): number | undefined {
  if (!/^\d{1,16}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedBody(
  stream: AsyncIterable<Uint8Array | string>,
  maximumBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error("Broker body exceeded its limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
