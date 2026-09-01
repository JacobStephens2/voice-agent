import { realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  agentHostBootIdentitySchema,
  administrativeRestartWitnessChallengeSchema,
  administrativeRestartWitnessHostObservationSchema,
  administrativeRestartWitnessObservationIdentitySchema,
  administrativeRestartWitnessObservationResponseSchema,
  administrativeRestartWitnessReleaseCommitSchema,
  administrativeRestartWitnessServiceInstanceIdSchema,
  administrativeTimestampSchema,
  type AdministrativeRestartWitnessChallenge,
  type AdministrativeRestartWitnessHostObservation,
  type AdministrativeRestartWitnessObservationIdentity,
  type AdministrativeRestartWitnessObservationResponse,
  type AdministrativeRestartWitnessReleaseCommit,
} from "@voice-agent/contracts";
import type { AdministrativeRestartWitnessStore } from "@voice-agent/durable-store";

export interface AdministrativeRestartWitnessHost {
  read(): Promise<AdministrativeRestartWitnessHostObservation>;
}

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

/**
 * Proves that the live API and this witness boundary are the root-owned,
 * immutable source in the exact Release named by the active marker.
 */
export function administrativeRestartWitnessReleaseProvenanceIsExact(
  input: AdministrativeRestartWitnessReleaseProvenance,
): boolean {
  const releasePath = `/opt/voice-agent/releases/${input.releaseCommit}`;
  return (
    input.activeReleasePath === releasePath &&
    input.apiEntrypointPath === `${releasePath}/apps/api/src/server.ts` &&
    input.witnessModulePath ===
      `${releasePath}/packages/runtime/src/administrative-restart-witness.ts` &&
    input.activeReleaseOwnerUid === 0 &&
    input.apiEntrypointOwnerUid === 0 &&
    input.witnessModuleOwnerUid === 0 &&
    (input.activeReleaseMode & 0o170000) === 0o040000 &&
    (input.apiEntrypointMode & 0o170000) === 0o100000 &&
    (input.witnessModuleMode & 0o170000) === 0o100000 &&
    modeIsImmutable(input.activeReleaseMode) &&
    modeIsImmutable(input.apiEntrypointMode) &&
    modeIsImmutable(input.witnessModuleMode)
  );
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
      } catch {
        return administrativeRestartWitnessObservationResponseSchema.parse(
          await options.store.recordHostObservationFailure({
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
  readonly serviceInstanceId: string;
}): AdministrativeRestartWitnessHost {
  const serviceInstanceId =
    administrativeRestartWitnessServiceInstanceIdSchema.parse(
      input.serviceInstanceId,
    );
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
        })
      ) {
        throw new Error("The active immutable Voice Agent Release is invalid");
      }
      return administrativeRestartWitnessHostObservationSchema.parse({
        bootIdentity: agentHostBootIdentitySchema.parse(bootIdentity.trim()),
        releaseCommit,
        serviceInstanceId,
      });
    },
  };
}

function modeIsImmutable(mode: number): boolean {
  return (mode & 0o222) === 0;
}
