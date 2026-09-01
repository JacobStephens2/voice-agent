import { readFile, realpath } from "node:fs/promises";

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
      if (
        activeReleasePath !== `/opt/voice-agent/releases/${releaseCommit}`
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
