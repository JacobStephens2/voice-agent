import { z } from "zod";

import { administrativeAutonomyStatusSchema } from "@voice-agent/contracts";

const identifierSchema = z.string().min(1).max(120);
const releaseCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const timestampSchema = z.iso.datetime();

const activePolicyObservationSchema = z
  .object({
    revision: z.number().int().positive(),
    stateVersion: z.number().int().nonnegative(),
    status: z.literal("active"),
  })
  .strict();

const authenticatedApiObservationFields = {
  apiAuthentication: z.literal("trusted-browser-session"),
  apiPath: z.literal("/api/administrative-autonomy"),
  policy: activePolicyObservationSchema,
};

const authenticatedApiResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...authenticatedApiObservationFields,
      outcome: z.literal("passed"),
    })
    .strict(),
  z
    .object({
      failure: z.enum(["authentication", "request", "schema"]),
      outcome: z.literal("failed"),
    })
    .strict(),
]);

const baselineEventSchema = z
  .object({
    ...authenticatedApiObservationFields,
    kind: z.literal("administrative-policy-baseline-observed"),
    recordedAt: timestampSchema,
  })
  .strict();

const serviceRestartEventSchema = z
  .object({
    apiService: z.enum(["active", "inactive"]),
    kind: z.literal("administrative-policy-service-restart-observed"),
    policyApi: authenticatedApiResultSchema,
    recordedAt: timestampSchema,
    workerService: z.enum(["active", "inactive"]),
  })
  .strict();

const hostRebootArmedEventSchema = z
  .object({
    expectedPolicy: activePolicyObservationSchema,
    kind: z.literal("administrative-policy-host-reboot-armed"),
    recordedAt: timestampSchema,
  })
  .strict();

const hostRebootEventSchema = z
  .object({
    agentHostBootIdentityChanged: z.enum(["failed", "passed"]),
    apiService: z.enum(["active", "inactive"]),
    kind: z.literal("administrative-policy-host-reboot-observed"),
    policyApi: authenticatedApiResultSchema,
    recordedAt: timestampSchema,
    workerService: z.enum(["active", "inactive"]),
  })
  .strict();

const administrativeAutonomyRestartEventSchema = z.discriminatedUnion("kind", [
  baselineEventSchema,
  serviceRestartEventSchema,
  hostRebootArmedEventSchema,
  hostRebootEventSchema,
]);

const administrativeAutonomyRestartRecordSchema = z
  .object({
    campaignId: identifierSchema,
    events: z.array(administrativeAutonomyRestartEventSchema).max(100),
    releaseCommit: releaseCommitSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

export type AdministrativeAutonomyRestartRecord = z.infer<
  typeof administrativeAutonomyRestartRecordSchema
>;

export interface AdministrativeAutonomyRestartEvaluation {
  readonly errors: readonly string[];
  readonly observedPolicyRevision: number | null;
  readonly observedPolicyStateVersion: number | null;
  readonly ready: boolean;
}

export function administrativePolicyObservationFromAuthenticatedApi(
  input: unknown,
): z.infer<typeof activePolicyObservationSchema> {
  const status = administrativeAutonomyStatusSchema.parse(input);
  if (status.policy.status !== "active") {
    throw new Error("The deployed Administrative Autonomy Policy is not active");
  }
  return activePolicyObservationSchema.parse({
    revision: status.policy.revision,
    stateVersion: status.policy.stateVersion,
    status: status.policy.status,
  });
}

export function createAdministrativeAutonomyRestartRecord(input: {
  readonly campaignId: string;
  readonly releaseCommit: string;
}): AdministrativeAutonomyRestartRecord {
  return administrativeAutonomyRestartRecordSchema.parse({
    ...input,
    events: [],
    schemaVersion: 1,
  });
}

export function parseAdministrativeAutonomyRestartRecord(
  input: unknown,
): AdministrativeAutonomyRestartRecord {
  return administrativeAutonomyRestartRecordSchema.parse(input);
}

export function appendAdministrativeAutonomyRestartEvent(
  untrustedRecord: AdministrativeAutonomyRestartRecord,
  untrustedEvent: unknown,
): AdministrativeAutonomyRestartRecord {
  const record =
    administrativeAutonomyRestartRecordSchema.parse(untrustedRecord);
  const event = administrativeAutonomyRestartEventSchema.parse(untrustedEvent);
  const previous = record.events.at(-1);
  if (
    previous !== undefined &&
    event.recordedAt.localeCompare(previous.recordedAt) < 0
  ) {
    throw new Error(
      "Restart Witness Events must be appended in recorded-time order",
    );
  }
  if (event.kind === "administrative-policy-baseline-observed") {
    if (record.events.length > 0) {
      throw new Error("The pre-restart policy baseline must be the first Event");
    }
  } else if (
    record.events[0]?.kind !== "administrative-policy-baseline-observed"
  ) {
    throw new Error("Restart observations require a pre-restart policy baseline");
  }
  if (event.kind === "administrative-policy-host-reboot-armed") {
    const baseline = record.events[0];
    if (
      baseline?.kind !== "administrative-policy-baseline-observed" ||
      !samePolicy(baseline.policy, event.expectedPolicy)
    ) {
      throw new Error(
        "The reboot checkpoint must retain the exact baseline authority",
      );
    }
  }
  if (event.kind === "administrative-policy-host-reboot-observed") {
    const checkpointIndex = record.events.findLastIndex(
      (candidate) =>
        candidate.kind === "administrative-policy-host-reboot-armed",
    );
    if (checkpointIndex < 0) {
      throw new Error(
        "The host-reboot observation must follow the durable pre-reboot checkpoint",
      );
    }
  }
  return administrativeAutonomyRestartRecordSchema.parse({
    ...record,
    events: [...record.events, event],
  });
}

export function evaluateAdministrativeAutonomyRestartWitness(
  untrustedRecord: AdministrativeAutonomyRestartRecord,
): AdministrativeAutonomyRestartEvaluation {
  const record =
    administrativeAutonomyRestartRecordSchema.parse(untrustedRecord);
  const errors: string[] = [];
  const baseline = record.events.find(
    (event) => event.kind === "administrative-policy-baseline-observed",
  );
  if (baseline === undefined) {
    errors.push("No authenticated pre-restart policy baseline was recorded.");
  }
  const serviceRestart = record.events.findLast(
    (event) => event.kind === "administrative-policy-service-restart-observed",
  );
  if (serviceRestart === undefined) {
    errors.push("The API and worker service restart has not been witnessed.");
  } else {
    if (serviceRestart.apiService !== "active") {
      errors.push("The API service was not active after restart.");
    }
    if (serviceRestart.workerService !== "active") {
      errors.push("The worker service was not active after restart.");
    }
    if (serviceRestart.policyApi.outcome !== "passed") {
      errors.push("The authenticated policy API failed after service restart.");
    } else if (
      baseline !== undefined &&
      !samePolicy(baseline.policy, serviceRestart.policyApi.policy)
    ) {
      errors.push(
        "The service-restart policy observation does not match the pre-restart authority.",
      );
    }
  }
  const hostReboot = record.events.findLast(
    (event) => event.kind === "administrative-policy-host-reboot-observed",
  );
  if (hostReboot === undefined) {
    errors.push("The real Agent Host reboot has not been witnessed.");
  } else {
    if (hostReboot.agentHostBootIdentityChanged !== "passed") {
      errors.push("A real Agent Host reboot was not witnessed.");
    }
    if (hostReboot.apiService !== "active") {
      errors.push("The API service was not active after Agent Host reboot.");
    }
    if (hostReboot.workerService !== "active") {
      errors.push("The worker service was not active after Agent Host reboot.");
    }
    if (hostReboot.policyApi.outcome !== "passed") {
      errors.push("The authenticated policy API failed after Agent Host reboot.");
    } else if (
      baseline !== undefined &&
      !samePolicy(baseline.policy, hostReboot.policyApi.policy)
    ) {
      errors.push(
        "The host-reboot policy observation does not match the pre-restart authority.",
      );
    }
  }
  return {
    errors,
    observedPolicyRevision: baseline?.policy.revision ?? null,
    observedPolicyStateVersion: baseline?.policy.stateVersion ?? null,
    ready: errors.length === 0,
  };
}

function samePolicy(
  left: z.infer<typeof activePolicyObservationSchema>,
  right: z.infer<typeof activePolicyObservationSchema>,
): boolean {
  return (
    left.status === right.status &&
    left.revision === right.revision &&
    left.stateVersion === right.stateVersion
  );
}
