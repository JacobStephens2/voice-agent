import { expect, test } from "vitest";

import { administrativeUnavailableExecutionManifest } from "@voice-agent/contracts";

import {
  appendAdministrativeAutonomyRestartEvent,
  administrativePolicyObservationFromAuthenticatedApi,
  createAdministrativeAutonomyRestartRecord,
  evaluateAdministrativeAutonomyRestartWitness,
  parseAdministrativeAutonomyRestartRecord,
  type AdministrativeAutonomyRestartRecord,
} from "../src/index.ts";

const releaseCommit = "a".repeat(40);
const baseline = {
  apiAuthentication: "trusted-browser-session" as const,
  apiPath: "/api/administrative-autonomy" as const,
  kind: "administrative-policy-baseline-observed" as const,
  policy: {
    revision: 7,
    stateVersion: 11,
    status: "active" as const,
  },
  recordedAt: "2026-09-01T14:00:00.000Z",
};

test("the witness derives authority from the complete deployed API contract", () => {
  const status = deployedStatus();

  expect(administrativePolicyObservationFromAuthenticatedApi(status)).toEqual(
    baseline.policy,
  );
  expect(() =>
    administrativePolicyObservationFromAuthenticatedApi({
      ...status,
      policy: { activeRevision: null, stateVersion: 11, status: "inactive" },
    }),
  ).toThrow(/not active/u);
  expect(() =>
    administrativePolicyObservationFromAuthenticatedApi({
      ...status,
      untrustedPolicyRevision: 7,
    }),
  ).toThrow();
});

test("an exact authenticated policy survives a real service restart and Agent Host reboot", () => {
  const record = completedWitness();

  expect(evaluateAdministrativeAutonomyRestartWitness(record)).toEqual({
    errors: [],
    observedPolicyRevision: 7,
    observedPolicyStateVersion: 11,
    ready: true,
  });
  expect(
    parseAdministrativeAutonomyRestartRecord(JSON.parse(JSON.stringify(record))),
  ).toEqual(record);
});

test("mismatched service and reboot observations remain visible and fail acceptance", () => {
  let record = createAdministrativeAutonomyRestartRecord({
    campaignId: "issue-83-restart-witness",
    releaseCommit,
  });
  record = appendAdministrativeAutonomyRestartEvent(record, baseline);
  record = appendAdministrativeAutonomyRestartEvent(record, {
    ...serviceRestart(),
    policyApi: {
      ...serviceRestart().policyApi,
      policy: { ...baseline.policy, stateVersion: 12 },
    },
  });
  record = appendAdministrativeAutonomyRestartEvent(record, rebootArmed());
  record = appendAdministrativeAutonomyRestartEvent(record, {
    ...hostReboot(),
    agentHostBootIdentityChanged: "failed",
    policyApi: {
      ...hostReboot().policyApi,
      policy: { ...baseline.policy, revision: 8 },
    },
  });

  expect(evaluateAdministrativeAutonomyRestartWitness(record)).toEqual({
    errors: [
      "The service-restart policy observation does not match the pre-restart authority.",
      "A real Agent Host reboot was not witnessed.",
      "The host-reboot policy observation does not match the pre-restart authority.",
    ],
    observedPolicyRevision: 7,
    observedPolicyStateVersion: 11,
    ready: false,
  });
  expect(record.events).toHaveLength(4);
});

test("a host reboot cannot be recorded without its durable pre-reboot checkpoint", () => {
  let record = createAdministrativeAutonomyRestartRecord({
    campaignId: "issue-83-restart-witness",
    releaseCommit,
  });
  record = appendAdministrativeAutonomyRestartEvent(record, baseline);
  record = appendAdministrativeAutonomyRestartEvent(record, serviceRestart());

  expect(() =>
    appendAdministrativeAutonomyRestartEvent(record, hostReboot()),
  ).toThrow(/must follow the durable pre-reboot checkpoint/u);
});

test("the sanitized witness contract rejects session secrets and raw boot identities", () => {
  expect(() =>
    appendAdministrativeAutonomyRestartEvent(
      createAdministrativeAutonomyRestartRecord({
        campaignId: "issue-83-restart-witness",
        releaseCommit,
      }),
      { ...baseline, sessionCookie: "secret" },
    ),
  ).toThrow();

  const record = appendAdministrativeAutonomyRestartEvent(
    createAdministrativeAutonomyRestartRecord({
      campaignId: "issue-83-restart-witness",
      releaseCommit,
    }),
    baseline,
  );
  expect(() =>
    appendAdministrativeAutonomyRestartEvent(record, {
      ...rebootArmed(),
      bootId: "host-boot-identity",
    }),
  ).toThrow();
});

test("failed authenticated observations remain append-only while later retries can satisfy the witness", () => {
  let record = createAdministrativeAutonomyRestartRecord({
    campaignId: "issue-83-restart-witness",
    releaseCommit,
  });
  record = appendAdministrativeAutonomyRestartEvent(record, baseline);
  record = appendAdministrativeAutonomyRestartEvent(record, {
    ...serviceRestart(),
    policyApi: { failure: "request", outcome: "failed" },
  });
  record = appendAdministrativeAutonomyRestartEvent(record, {
    ...serviceRestart(),
    recordedAt: "2026-09-01T14:05:30.000Z",
  });
  record = appendAdministrativeAutonomyRestartEvent(record, rebootArmed());
  record = appendAdministrativeAutonomyRestartEvent(record, {
    ...hostReboot(),
    policyApi: { failure: "schema", outcome: "failed" },
  });
  record = appendAdministrativeAutonomyRestartEvent(record, {
    ...hostReboot(),
    recordedAt: "2026-09-01T14:16:00.000Z",
  });

  expect(evaluateAdministrativeAutonomyRestartWitness(record).ready).toBe(true);
  expect(record.events).toHaveLength(6);
  expect(
    record.events.filter(
      (event) =>
        "policyApi" in event && event.policyApi.outcome === "failed",
    ),
  ).toHaveLength(2);
});

function completedWitness(): AdministrativeAutonomyRestartRecord {
  let record = createAdministrativeAutonomyRestartRecord({
    campaignId: "issue-83-restart-witness",
    releaseCommit,
  });
  record = appendAdministrativeAutonomyRestartEvent(record, baseline);
  record = appendAdministrativeAutonomyRestartEvent(record, serviceRestart());
  record = appendAdministrativeAutonomyRestartEvent(record, rebootArmed());
  return appendAdministrativeAutonomyRestartEvent(record, hostReboot());
}

function serviceRestart() {
  return {
    apiService: "active" as const,
    kind: "administrative-policy-service-restart-observed" as const,
    policyApi: {
      apiAuthentication: baseline.apiAuthentication,
      apiPath: baseline.apiPath,
      outcome: "passed" as const,
      policy: baseline.policy,
    },
    recordedAt: "2026-09-01T14:05:00.000Z",
    workerService: "active" as const,
  };
}

function rebootArmed() {
  return {
    expectedPolicy: baseline.policy,
    kind: "administrative-policy-host-reboot-armed" as const,
    recordedAt: "2026-09-01T14:06:00.000Z",
  };
}

function hostReboot() {
  return {
    agentHostBootIdentityChanged: "passed" as const,
    apiService: "active" as const,
    kind: "administrative-policy-host-reboot-observed" as const,
    policyApi: {
      apiAuthentication: baseline.apiAuthentication,
      apiPath: baseline.apiPath,
      outcome: "passed" as const,
      policy: baseline.policy,
    },
    recordedAt: "2026-09-01T14:15:00.000Z",
    workerService: "active" as const,
  };
}

function deployedStatus() {
  return {
    policy: {
      activatedAt: "2026-09-01T13:55:00.000Z",
      activatedBy: "fresh-passkey-action",
      executionManifest: administrativeUnavailableExecutionManifest,
      ...baseline.policy,
    },
    policyEvidence: { events: [], totalCount: 0, truncated: false },
    taskExecution: {
      executionManifest: administrativeUnavailableExecutionManifest,
      reason: "An executable Administrative Execution Manifest is not present.",
      status: "unavailable",
    },
  };
}
