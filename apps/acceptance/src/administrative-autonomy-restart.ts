import {
  administrativeRestartWitnessRecordSchema,
  type AdministrativeRestartWitnessObservation,
  type AdministrativeRestartWitnessRecord,
} from "@voice-agent/contracts";

export type AdministrativeAutonomyRestartRecord =
  AdministrativeRestartWitnessRecord;

export interface AdministrativeAutonomyRestartEvaluation {
  readonly errors: readonly string[];
  readonly observedExecutionManifestFingerprint: string | null;
  readonly observedPolicyRevision: number | null;
  readonly observedPolicyStateVersion: number | null;
  readonly ready: boolean;
}

export function parseAdministrativeAutonomyRestartRecord(
  input: unknown,
): AdministrativeAutonomyRestartRecord {
  return administrativeRestartWitnessRecordSchema.parse(input);
}

export function evaluateAdministrativeAutonomyRestartWitness(
  untrustedRecord: AdministrativeAutonomyRestartRecord,
): AdministrativeAutonomyRestartEvaluation {
  const record = administrativeRestartWitnessRecordSchema.parse(untrustedRecord);
  const errors: string[] = [];
  const baseline = passingObservation(record, "baseline");
  const serviceRestart = passingObservation(record, "service-restart");
  const hostReboot = passingObservation(record, "host-reboot");
  if (baseline === undefined) {
    errors.push("No server-recorded pre-restart policy baseline was recorded.");
  }
  if (serviceRestart === undefined) {
    errors.push("The API and worker service restart has not been witnessed.");
  } else if (!serviceRestart.checks.serviceInstanceChanged) {
    errors.push("The service-restart identity checks did not pass.");
  }
  if (hostReboot === undefined) {
    errors.push("The real Agent Host reboot has not been witnessed.");
  } else if (!hostReboot.checks.bootIdentityChanged) {
    errors.push("The Agent Host boot identity did not change.");
  }
  if (record.status !== "completed") {
    errors.push("The durable Restart Witness campaign is not complete.");
  }
  for (const observation of [serviceRestart, hostReboot]) {
    if (
      baseline !== undefined &&
      observation !== undefined &&
      !sameAuthority(baseline, observation)
    ) {
      errors.push(
        `The ${observation.phase} observation does not match the baseline policy, manifest, and Release.`,
      );
    }
  }
  return {
    errors,
    observedExecutionManifestFingerprint:
      baseline?.policy.executionManifestFingerprint ?? null,
    observedPolicyRevision: baseline?.policy.revision ?? null,
    observedPolicyStateVersion: baseline?.policy.stateVersion ?? null,
    ready: errors.length === 0,
  };
}

function passingObservation<
  Phase extends "baseline" | "host-reboot" | "service-restart",
>(
  record: AdministrativeAutonomyRestartRecord,
  phase: Phase,
):
  | Extract<
      AdministrativeRestartWitnessObservation,
      { outcome: "passed"; phase: Phase }
    >
  | undefined {
  return record.observations.findLast(
    (
      observation,
    ): observation is Extract<
      AdministrativeRestartWitnessObservation,
      { outcome: "passed"; phase: Phase }
    > => observation.phase === phase && observation.outcome === "passed",
  );
}

function sameAuthority(
  baseline: Extract<
    AdministrativeRestartWitnessObservation,
    { outcome: "passed" }
  >,
  observation: Extract<
    AdministrativeRestartWitnessObservation,
    { outcome: "passed" }
  >,
): boolean {
  return (
    baseline.policy.revision === observation.policy.revision &&
    baseline.policy.stateVersion === observation.policy.stateVersion &&
    baseline.policy.status === observation.policy.status &&
    baseline.policy.executionManifestFingerprint ===
      observation.policy.executionManifestFingerprint &&
    baseline.releaseCommit === observation.releaseCommit
  );
}
