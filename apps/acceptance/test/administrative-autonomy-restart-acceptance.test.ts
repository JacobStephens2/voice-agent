import { expect, test } from "vitest";

import {
  administrativeRestartWitnessCampaignIdSchema,
  administrativeRestartWitnessReleaseCommitSchema,
  administrativeTimestampSchema,
  type AdministrativeRestartWitnessRecord,
} from "@voice-agent/contracts";

import {
  evaluateAdministrativeAutonomyRestartWitness,
  parseAdministrativeAutonomyRestartRecord,
} from "../src/index.ts";

const releaseCommit = administrativeRestartWitnessReleaseCommitSchema.parse(
  "a".repeat(40),
);
const campaignId = administrativeRestartWitnessCampaignIdSchema.parse(
  "administrative-restart-campaign-release-a",
);
const policy = {
  executionManifestFingerprint:
    '{"operationAdapters":[],"provider":{"kind":"unavailable"},"schemaVersion":1}',
  revision: 7,
  stateVersion: 11,
  status: "active" as const,
};

test("a server-recorded three-phase campaign satisfies the restart witness", () => {
  const record = completedWitness();

  expect(evaluateAdministrativeAutonomyRestartWitness(record)).toEqual({
    errors: [],
    observedExecutionManifestFingerprint:
      policy.executionManifestFingerprint,
    observedPolicyRevision: 7,
    observedPolicyStateVersion: 11,
    ready: true,
  });
  expect(
    parseAdministrativeAutonomyRestartRecord(JSON.parse(JSON.stringify(record))),
  ).toEqual(record);
});

test("the immutable Release commit is a validated witness identity", () => {
  expect(
    administrativeRestartWitnessReleaseCommitSchema.safeParse("a".repeat(40))
      .success,
  ).toBe(true);
  expect(
    administrativeRestartWitnessReleaseCommitSchema.safeParse(
      `${"a".repeat(40)}-dirty`,
    ).success,
  ).toBe(false);
});

test("the acceptance contract rejects caller provenance, challenges, and raw host identities", () => {
  const record = completedWitness();
  for (const injected of [
    { apiAuthentication: "trusted-browser-session" },
    { bootIdentity: "raw-boot-id" },
    { challenge: "administrative-restart-challenge-replayed" },
    { serviceInstanceId: "raw-process-id" },
    { sessionCookie: "secret" },
  ]) {
    expect(() =>
      parseAdministrativeAutonomyRestartRecord({
        ...record,
        observations: [{ ...record.observations[0], ...injected }],
      }),
    ).toThrow();
  }
});

test("changed policy, manifest, or Release evidence fails acceptance", () => {
  const record = completedWitness();
  const mutations = [
    { policy: { ...policy, revision: 8 } },
    {
      policy: {
        ...policy,
        executionManifestFingerprint: '{"provider":{"kind":"changed"}}',
      },
    },
    { releaseCommit: "b".repeat(40) },
  ];
  for (const mutation of mutations) {
    const changed = {
      ...record,
      observations: record.observations.map((observation) =>
        observation.phase === "service-restart" && observation.outcome === "passed"
          ? { ...observation, ...mutation }
          : observation,
      ),
    } as AdministrativeRestartWitnessRecord;
    expect(evaluateAdministrativeAutonomyRestartWitness(changed).ready).toBe(
      false,
    );
  }
});

test("durable failed attempts remain visible without replacing later server-recorded proof", () => {
  const record = completedWitness();
  const withFailures = parseAdministrativeAutonomyRestartRecord({
    ...record,
    observations: [
      record.observations[0],
      {
        failure: "service-instance-unchanged",
        observedAt: "2026-09-01T14:04:00.000Z",
        outcome: "failed",
        phase: "service-restart",
        provenance: "server-recorded-authenticated-api",
        sequence: 2,
      },
      ...record.observations.slice(1).map((observation, index) => ({
        ...observation,
        sequence: index + 3,
      })),
    ],
  });

  expect(evaluateAdministrativeAutonomyRestartWitness(withFailures).ready).toBe(
    true,
  );
  expect(withFailures.observations).toHaveLength(4);
});

function completedWitness(): AdministrativeRestartWitnessRecord {
  return parseAdministrativeAutonomyRestartRecord({
    campaignId,
    createdAt: "2026-09-01T14:00:00.000Z",
    observations: [
      passingObservation("baseline", 1, "2026-09-01T14:01:00.000Z"),
      passingObservation(
        "service-restart",
        2,
        "2026-09-01T14:05:00.000Z",
      ),
      passingObservation("host-reboot", 3, "2026-09-01T14:15:00.000Z"),
    ],
    releaseCommit,
    schemaVersion: 2,
    status: "completed",
  });
}

function passingObservation(
  phase: "baseline" | "host-reboot" | "service-restart",
  sequence: number,
  observedAt: string,
) {
  const checks =
    phase === "baseline"
      ? { authorityCaptured: true as const }
      : phase === "service-restart"
        ? {
            authorityUnchanged: true as const,
            bootIdentityUnchanged: true as const,
            serviceInstanceChanged: true as const,
          }
        : {
            authorityUnchanged: true as const,
            bootIdentityChanged: true as const,
          };
  return {
    checks,
    observedAt: administrativeTimestampSchema.parse(observedAt),
    outcome: "passed" as const,
    phase,
    policy,
    provenance: "server-recorded-authenticated-api" as const,
    releaseCommit,
    sequence,
  };
}
