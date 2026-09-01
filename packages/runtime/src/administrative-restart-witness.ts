import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  administrativeRestartWitnessChallengeSchema,
  administrativeRestartWitnessApiServiceInstanceFingerprintSchema,
  administrativeRestartWitnessBootIdentityFingerprintSchema,
  administrativeRestartWitnessHostObservationSchema,
  administrativeRestartWitnessObservationIdentitySchema,
  administrativeRestartWitnessObservationResponseSchema,
  administrativeRestartWitnessReleaseCommitSchema,
  administrativeRestartWitnessServiceInstanceIdSchema,
  administrativeRestartWitnessServiceSchema,
  administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema,
  administrativeRestartWitnessWorkerIdentitySchema,
  administrativeTimestampSchema,
  type AdministrativeRestartWitnessApiServiceInstanceFingerprint,
  type AdministrativeRestartWitnessBootIdentityFingerprint,
  type AdministrativeRestartWitnessChallenge,
  type AdministrativeRestartWitnessHostObservation,
  type AdministrativeRestartWitnessObservationIdentity,
  type AdministrativeRestartWitnessObservationResponse,
  type AdministrativeRestartWitnessReleaseCommit,
  type AdministrativeRestartWitnessService,
  type AdministrativeRestartWitnessWorkerServiceInstanceFingerprint,
  type AdministrativeRestartWitnessWorkerIdentity,
} from "@voice-agent/contracts";
import type { AdministrativeRestartWitnessStore } from "@voice-agent/durable-store";

export interface AdministrativeRestartWitnessHost {
  read(): Promise<AdministrativeRestartWitnessHostObservation>;
}

export interface AdministrativeRestartWitnessWorkerHealth {
  requireExact(
    identity: AdministrativeRestartWitnessWorkerIdentity,
  ): Promise<void>;
}

export interface AdministrativeRestartWitnessWorkerReadiness {
  requireAvailable(): Promise<void>;
}

export interface AdministrativeRestartWitnessWorkerIdentityServer {
  close(): Promise<void>;
  start(): Promise<void>;
}

export const administrativeRestartWitnessWorkerIdentitySocketPath =
  "/run/voice-agent-worker/restart-witness.sock";

export interface AdministrativeRestartWitnessRuntime {
  observe(
    input: AdministrativeRestartWitnessObservationIdentity,
  ): Promise<AdministrativeRestartWitnessObservationResponse>;
}

export interface AdministrativeRestartWitnessReleaseProvenance {
  readonly activeReleaseMode: number;
  readonly activeReleaseOwnerUid: number;
  readonly activeReleasePath: string;
  readonly apiEntrypointMode: number;
  readonly apiEntrypointOwnerUid: number;
  readonly apiEntrypointPath: string;
  readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  readonly witnessModuleMode: number;
  readonly witnessModuleOwnerUid: number;
  readonly witnessModulePath: string;
}

export interface AdministrativeRestartWitnessServiceReleaseProvenance {
  readonly activeReleaseMode: number;
  readonly activeReleaseOwnerUid: number;
  readonly activeReleasePath: string;
  readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  readonly service: AdministrativeRestartWitnessService;
  readonly serviceEntrypointMode: number;
  readonly serviceEntrypointOwnerUid: number;
  readonly serviceEntrypointPath: string;
  readonly witnessModuleMode: number;
  readonly witnessModuleOwnerUid: number;
  readonly witnessModulePath: string;
}

export class AdministrativeRestartWitnessWorkerObservationError extends Error {
  constructor() {
    super("The worker service observation is unavailable");
  }
}

/**
 * Proves that the live API and this witness boundary are the root-owned,
 * immutable source in the exact Release named by the active marker.
 */
export function administrativeRestartWitnessReleaseProvenanceIsExact(
  input: AdministrativeRestartWitnessReleaseProvenance,
): boolean {
  return administrativeRestartWitnessServiceReleaseProvenanceIsExact({
    activeReleaseMode: input.activeReleaseMode,
    activeReleaseOwnerUid: input.activeReleaseOwnerUid,
    activeReleasePath: input.activeReleasePath,
    releaseCommit: input.releaseCommit,
    service: "api",
    serviceEntrypointMode: input.apiEntrypointMode,
    serviceEntrypointOwnerUid: input.apiEntrypointOwnerUid,
    serviceEntrypointPath: input.apiEntrypointPath,
    witnessModuleMode: input.witnessModuleMode,
    witnessModuleOwnerUid: input.witnessModuleOwnerUid,
    witnessModulePath: input.witnessModulePath,
  });
}

/** Binds an API/worker service registration to its immutable active Release. */
export function administrativeRestartWitnessServiceReleaseProvenanceIsExact(
  input: AdministrativeRestartWitnessServiceReleaseProvenance,
): boolean {
  const releasePath = `/opt/voice-agent/releases/${input.releaseCommit}`;
  const entrypoint =
    input.service === "api"
      ? `${releasePath}/apps/api/src/server.ts`
      : `${releasePath}/apps/worker/src/server.ts`;
  return (
    input.activeReleasePath === releasePath &&
    input.serviceEntrypointPath === entrypoint &&
    input.witnessModulePath ===
      `${releasePath}/packages/runtime/src/administrative-restart-witness.ts` &&
    input.activeReleaseOwnerUid === 0 &&
    input.serviceEntrypointOwnerUid === 0 &&
    input.witnessModuleOwnerUid === 0 &&
    (input.activeReleaseMode & 0o170000) === 0o040000 &&
    (input.serviceEntrypointMode & 0o170000) === 0o100000 &&
    (input.witnessModuleMode & 0o170000) === 0o100000 &&
    modeIsImmutable(input.activeReleaseMode) &&
    modeIsImmutable(input.serviceEntrypointMode) &&
    modeIsImmutable(input.witnessModuleMode)
  );
}

/** Validates every entry in the active immutable Release without following it. */
export async function administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
  releaseRoot: string,
  expectedOwnerUid: number,
): Promise<boolean> {
  try {
    if (!isAbsolute(releaseRoot)) return false;
    const canonicalRoot = await realpath(releaseRoot);
    if (canonicalRoot !== releaseRoot) return false;
    const pending = [canonicalRoot];
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined) return false;
      const metadata = await lstat(path);
      if (metadata.uid !== expectedOwnerUid) return false;
      if (metadata.isSymbolicLink()) {
        const target = await realpath(path);
        if (!releasePathIsWithin(canonicalRoot, target)) return false;
        continue;
      }
      if ((metadata.mode & 0o222) !== 0) return false;
      if (metadata.isDirectory()) {
        const entries = await readdir(path);
        pending.push(...entries.map((entry) => join(path, entry)));
      } else if (!metadata.isFile()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Records only composition-owned observations. The authenticated request can
 * identify its single-use challenge, but cannot supply policy, Release,
 * process, boot, database, or filesystem authority.
 */
export function createAdministrativeRestartWitnessRuntime(options: {
  readonly host: AdministrativeRestartWitnessHost;
  readonly identifiers: {
    nextChallenge(): AdministrativeRestartWitnessChallenge;
  };
  readonly now: () => string;
  readonly store: AdministrativeRestartWitnessStore;
}): AdministrativeRestartWitnessRuntime {
  return {
    async observe(input) {
      const identity =
        administrativeRestartWitnessObservationIdentitySchema.parse(input);
      const nextChallenge = administrativeRestartWitnessChallengeSchema.parse(
        options.identifiers.nextChallenge(),
      );
      const observedAt = administrativeTimestampSchema.parse(options.now());
      let observation: AdministrativeRestartWitnessHostObservation;
      try {
        observation = administrativeRestartWitnessHostObservationSchema.parse(
          await options.host.read(),
        );
      } catch (error) {
        return administrativeRestartWitnessObservationResponseSchema.parse(
          await options.store.recordHostObservationFailure({
            failure:
              error instanceof AdministrativeRestartWitnessWorkerObservationError
                ? "worker-observation-unavailable"
                : "host-observation-unavailable",
            identity,
            nextChallenge,
            observedAt,
          }),
        );
      }
      return administrativeRestartWitnessObservationResponseSchema.parse(
        await options.store.observe({
          identity,
          nextChallenge,
          observedAt,
          observation,
        }),
      );
    },
  };
}

/** Reads the real Agent Host identities from fixed deployment-owned paths. */
export function createNodeAdministrativeRestartWitnessHost(input: {
  readonly readApiServiceInstanceFingerprint: () => unknown;
  readonly services: Pick<
    AdministrativeRestartWitnessStore,
    "readServiceInstances"
  >;
  readonly workerHealth: AdministrativeRestartWitnessWorkerHealth;
}): AdministrativeRestartWitnessHost {
  const apiEntrypoint = process.argv[1];
  if (apiEntrypoint === undefined) {
    throw new Error("The running Voice Agent API entrypoint is unavailable");
  }
  // Capture the executing modules at process composition. Resolving argv after
  // Promotion would follow /opt/voice-agent/current to the new Release even
  // though this process still has the old module bytes loaded.
  const apiEntrypointPath = realpathSync(apiEntrypoint);
  const witnessModulePath = realpathSync(fileURLToPath(import.meta.url));
  const apiEntrypointMetadata = statSync(apiEntrypointPath);
  const witnessModuleMetadata = statSync(witnessModulePath);
  return {
    async read() {
      const apiServiceInstanceFingerprint =
        administrativeRestartWitnessApiServiceInstanceFingerprintSchema.parse(
          input.readApiServiceInstanceFingerprint(),
        );
      const [bootIdentity, marker, activeReleasePath] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile("/opt/voice-agent/current/.voice-agent-release", "utf8"),
        realpath("/opt/voice-agent/current"),
      ]);
      const releaseCommit = administrativeRestartWitnessReleaseCommitSchema.parse(
        marker.trim(),
      );
      const activeReleaseMetadata = await stat(activeReleasePath);
      if (
        !administrativeRestartWitnessReleaseProvenanceIsExact({
          activeReleaseMode: activeReleaseMetadata.mode,
          activeReleaseOwnerUid: activeReleaseMetadata.uid,
          activeReleasePath,
          apiEntrypointMode: apiEntrypointMetadata.mode,
          apiEntrypointOwnerUid: apiEntrypointMetadata.uid,
          apiEntrypointPath,
          releaseCommit,
          witnessModuleMode: witnessModuleMetadata.mode,
          witnessModuleOwnerUid: witnessModuleMetadata.uid,
          witnessModulePath,
        }) ||
        !(await administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
          activeReleasePath,
          0,
        ))
      ) {
        throw new Error("The active immutable Voice Agent Release is invalid");
      }
      const bootIdentityFingerprint = administrativeRestartWitnessIdentityFingerprint(
        "agent-host-boot",
        bootIdentity.trim(),
      );
      const serviceInstances = await input.services.readServiceInstances({
        bootIdentityFingerprint,
        releaseCommit,
      });
      if (serviceInstances.api !== apiServiceInstanceFingerprint) {
        throw new Error("The API service observation changed concurrently");
      }
      if (serviceInstances.worker === undefined) {
        throw new AdministrativeRestartWitnessWorkerObservationError();
      }
      try {
        await input.workerHealth.requireExact({
          releaseCommit,
          workerServiceInstanceFingerprint: serviceInstances.worker,
        });
      } catch {
        throw new AdministrativeRestartWitnessWorkerObservationError();
      }
      return administrativeRestartWitnessHostObservationSchema.parse({
        apiServiceInstanceFingerprint,
        bootIdentityFingerprint,
        releaseCommit,
        workerServiceInstanceFingerprint: serviceInstances.worker,
      });
    },
  };
}

/** Readiness probe used before the worker exposes its exact identity seam. */
export function createNodeAdministrativeRestartWitnessWorkerReadiness(input: {
  readonly port: number;
}): AdministrativeRestartWitnessWorkerReadiness {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("The worker health port is invalid");
  }
  const url = `http://127.0.0.1:${input.port}/`;
  return {
    async requireAvailable() {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        throw new Error("The worker health response was not successful");
      }
    },
  };
}

/** Reads and verifies the exact identity owned by the live worker process. */
export function createNodeAdministrativeRestartWitnessWorkerHealth(input: {
  readonly socketPath?: string;
} = {}): AdministrativeRestartWitnessWorkerHealth {
  const socketPath =
    input.socketPath ?? administrativeRestartWitnessWorkerIdentitySocketPath;
  return {
    async requireExact(untrustedIdentity) {
      const expected =
        administrativeRestartWitnessWorkerIdentitySchema.parse(
          untrustedIdentity,
        );
      const observed = await readWorkerIdentity(socketPath);
      if (
        observed.releaseCommit !== expected.releaseCommit ||
        observed.workerServiceInstanceFingerprint !==
          expected.workerServiceInstanceFingerprint
      ) {
        throw new Error("The live worker identity does not match its registration");
      }
    },
  };
}

/** Serves only the sanitized Release-bound identity of this worker process. */
export function createNodeAdministrativeRestartWitnessWorkerIdentityServer(input: {
  readonly identity: AdministrativeRestartWitnessWorkerIdentity;
  readonly socketPath?: string;
}): AdministrativeRestartWitnessWorkerIdentityServer {
  const identity = administrativeRestartWitnessWorkerIdentitySchema.parse(
    input.identity,
  );
  const socketPath =
    input.socketPath ?? administrativeRestartWitnessWorkerIdentitySocketPath;
  const server = createServer((connection) => {
    connection.end(`${JSON.stringify(identity)}\n`);
  });
  return {
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        });
      }
      await unlink(socketPath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    },
    async start() {
      await unlink(socketPath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o660);
    },
  };
}

/**
 * Registers one concrete service startup after validating the executing bytes.
 * Only domain-separated hashes cross into the bounded durable projection.
 */
type RegisterRestartWitnessServiceInput = {
  readonly nextServiceInstanceId: () => string;
  readonly now: () => string;
  readonly service: AdministrativeRestartWitnessService;
  readonly store: Pick<
    AdministrativeRestartWitnessStore,
    "registerServiceInstance"
  >;
};

export function registerNodeAdministrativeRestartWitnessServiceInstance(
  input: RegisterRestartWitnessServiceInput & { readonly service: "api" },
): Promise<{
  readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  readonly serviceInstanceFingerprint: AdministrativeRestartWitnessApiServiceInstanceFingerprint;
}>;
export function registerNodeAdministrativeRestartWitnessServiceInstance(
  input: RegisterRestartWitnessServiceInput & { readonly service: "worker" },
): Promise<{
  readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  readonly serviceInstanceFingerprint: AdministrativeRestartWitnessWorkerServiceInstanceFingerprint;
}>;
export async function registerNodeAdministrativeRestartWitnessServiceInstance(
  input: RegisterRestartWitnessServiceInput,
): Promise<
  | {
      readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
      readonly serviceInstanceFingerprint: AdministrativeRestartWitnessApiServiceInstanceFingerprint;
    }
  | {
      readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
      readonly serviceInstanceFingerprint: AdministrativeRestartWitnessWorkerServiceInstanceFingerprint;
    }
> {
  const service = administrativeRestartWitnessServiceSchema.parse(input.service);
  const serviceInstanceId =
    administrativeRestartWitnessServiceInstanceIdSchema.parse(
      input.nextServiceInstanceId(),
    );
  const serviceEntrypoint = process.argv[1];
  if (serviceEntrypoint === undefined) {
    throw new Error(`The running Voice Agent ${service} entrypoint is unavailable`);
  }
  const serviceEntrypointPath = realpathSync(serviceEntrypoint);
  const witnessModulePath = realpathSync(fileURLToPath(import.meta.url));
  const serviceEntrypointMetadata = statSync(serviceEntrypointPath);
  const witnessModuleMetadata = statSync(witnessModulePath);
  const [bootIdentity, marker, activeReleasePath] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/opt/voice-agent/current/.voice-agent-release", "utf8"),
    realpath("/opt/voice-agent/current"),
  ]);
  const releaseCommit = administrativeRestartWitnessReleaseCommitSchema.parse(
    marker.trim(),
  );
  const activeReleaseMetadata = await stat(activeReleasePath);
  if (
    !administrativeRestartWitnessServiceReleaseProvenanceIsExact({
      activeReleaseMode: activeReleaseMetadata.mode,
      activeReleaseOwnerUid: activeReleaseMetadata.uid,
      activeReleasePath,
      releaseCommit,
      service,
      serviceEntrypointMode: serviceEntrypointMetadata.mode,
      serviceEntrypointOwnerUid: serviceEntrypointMetadata.uid,
      serviceEntrypointPath,
      witnessModuleMode: witnessModuleMetadata.mode,
      witnessModuleOwnerUid: witnessModuleMetadata.uid,
      witnessModulePath,
    }) ||
    !(await administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
      activeReleasePath,
      0,
    ))
  ) {
    throw new Error(
      `The ${service} service cannot register mutable or unowned Release provenance`,
    );
  }
  const common = {
    bootIdentityFingerprint: administrativeRestartWitnessIdentityFingerprint(
      "agent-host-boot",
      bootIdentity.trim(),
    ),
    registeredAt: administrativeTimestampSchema.parse(input.now()),
    releaseCommit,
  };
  if (service === "api") {
    const registered = await input.store.registerServiceInstance({
      ...common,
      candidateInstanceFingerprint: administrativeRestartWitnessIdentityFingerprint(
        "api-service-instance",
        serviceInstanceId,
      ),
      service,
    });
    return {
      releaseCommit,
      serviceInstanceFingerprint:
        administrativeRestartWitnessApiServiceInstanceFingerprintSchema.parse(
          registered,
        ),
    };
  }
  const registered = await input.store.registerServiceInstance({
    ...common,
    candidateInstanceFingerprint: administrativeRestartWitnessIdentityFingerprint(
      "worker-service-instance",
      serviceInstanceId,
    ),
    service,
  });
  return {
    releaseCommit,
    serviceInstanceFingerprint:
      administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema.parse(
        registered,
      ),
  };
}

async function readWorkerIdentity(
  socketPath: string,
): Promise<AdministrativeRestartWitnessWorkerIdentity> {
  return await new Promise((resolve, reject) => {
    const connection = createConnection(socketPath);
    let payload = "";
    connection.setEncoding("utf8");
    connection.setTimeout(2_000, () => {
      connection.destroy(new Error("The worker identity observation timed out"));
    });
    connection.on("data", (chunk: string) => {
      payload += chunk;
      if (payload.length > 2_000) {
        connection.destroy(new Error("The worker identity response is too large"));
      }
    });
    connection.once("error", reject);
    connection.once("end", () => {
      try {
        resolve(
          administrativeRestartWitnessWorkerIdentitySchema.parse(
            JSON.parse(payload),
          ),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function modeIsImmutable(mode: number): boolean {
  return (mode & 0o222) === 0;
}

function releasePathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

export function administrativeRestartWitnessIdentityFingerprint(
  kind: "agent-host-boot",
  identity: string,
): AdministrativeRestartWitnessBootIdentityFingerprint;
export function administrativeRestartWitnessIdentityFingerprint(
  kind: "api-service-instance",
  identity: string,
): AdministrativeRestartWitnessApiServiceInstanceFingerprint;
export function administrativeRestartWitnessIdentityFingerprint(
  kind: "worker-service-instance",
  identity: string,
): AdministrativeRestartWitnessWorkerServiceInstanceFingerprint;
export function administrativeRestartWitnessIdentityFingerprint(
  kind: "agent-host-boot" | "api-service-instance" | "worker-service-instance",
  identity: string,
):
  | AdministrativeRestartWitnessApiServiceInstanceFingerprint
  | AdministrativeRestartWitnessBootIdentityFingerprint
  | AdministrativeRestartWitnessWorkerServiceInstanceFingerprint;
export function administrativeRestartWitnessIdentityFingerprint(
  kind: "agent-host-boot" | "api-service-instance" | "worker-service-instance",
  identity: string,
):
  | AdministrativeRestartWitnessApiServiceInstanceFingerprint
  | AdministrativeRestartWitnessBootIdentityFingerprint
  | AdministrativeRestartWitnessWorkerServiceInstanceFingerprint {
  const fingerprint = createHash("sha256")
    .update(`voice-agent:administrative-restart-witness:${kind}:v1\0`)
    .update(identity)
    .digest("hex");
  return kind === "agent-host-boot"
    ? administrativeRestartWitnessBootIdentityFingerprintSchema.parse(fingerprint)
    : kind === "api-service-instance"
      ? administrativeRestartWitnessApiServiceInstanceFingerprintSchema.parse(
          fingerprint,
        )
      : administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema.parse(
          fingerprint,
        );
}
