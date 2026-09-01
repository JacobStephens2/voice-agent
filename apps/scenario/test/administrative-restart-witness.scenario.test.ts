import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import {
  administrativeRestartWitnessCampaignIdSchema,
  administrativeRestartWitnessChallengeSchema,
  administrativeExecutionManifestFingerprint,
  administrativeRestartWitnessRecord,
  administrativeRestartWitnessHostObservationSchema,
  administrativeRestartWitnessReleaseCommitSchema,
  administrativeRestartWitnessServiceInstanceIdSchema,
  administrativeTimestampSchema,
  agentHostBootIdentitySchema,
  administrativeUnavailableExecutionManifest,
  type AdministrativeRestartWitnessCampaign,
  type AdministrativeRestartWitnessHostObservation,
} from "@voice-agent/contracts";
import { evaluateAdministrativeAutonomyRestartWitness } from "@voice-agent/acceptance";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import { administrativeAutonomyPolicyDefinition } from "@voice-agent/policy";
import {
  administrativeRestartWitnessReleaseProvenanceIsExact,
  administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable,
  createAdministrativeRestartWitnessRuntime,
} from "@voice-agent/runtime";
import {
  createSqliteAdministrativeAutonomyStore,
  createSqliteAdministrativeRestartWitnessStore,
} from "@voice-agent/sqlite-store";

const origin = "https://voice.stephens.page";
const releaseCommit = administrativeRestartWitnessReleaseCommitSchema.parse(
  "a".repeat(40),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("the authenticated API records a single-use, phase-ordered restart campaign", async () => {
  const fixture = await createFixture();
  const api = createTaskApi({
    authentication: {
      async canChangeState({ csrfToken, sessionToken }) {
        return sessionToken === "owner-session" && csrfToken === "owner-csrf";
      },
      async canViewEvidence(sessionToken) {
        return sessionToken === "owner-session";
      },
    },
    origin,
    records: { async getEvidenceRecord() { return undefined; } },
    restartWitnessControls: fixture.runtime,
  });

  const baselineRequest = requestBody(fixture.campaign);
  const otherCampaign = await fixture.store.ensureCampaign({
    campaignId: administrativeRestartWitnessCampaignIdSchema.parse(
      "administrative-restart-campaign-release-b",
    ),
    createdAt: administrativeTimestampSchema.parse(
      "2026-09-01T14:00:02.000Z",
    ),
    initialChallenge: administrativeRestartWitnessChallengeSchema.parse(
      "administrative-restart-challenge-other-campaign",
    ),
    releaseCommit: administrativeRestartWitnessReleaseCommitSchema.parse(
      "b".repeat(40),
    ),
  });
  expect(
    await observe(api, {
      ...baselineRequest,
      challenge: administrativeRestartWitnessChallengeSchema.parse(
        "administrative-restart-challenge-unknown",
      ),
    }),
  ).toMatchObject({
    body: { reason: "challenge-mismatch" },
    statusCode: 409,
  });
  if (otherCampaign.nextObservation === null) {
    throw new Error("The other campaign challenge was not issued");
  }
  expect(
    await observe(api, {
      ...baselineRequest,
      challenge: otherCampaign.nextObservation.challenge,
    }),
  ).toMatchObject({
    body: { reason: "challenge-mismatch" },
    statusCode: 409,
  });
  expect((await observe(api, baselineRequest, null)).statusCode).toBe(401);
  expect(
    (await observe(api, baselineRequest, "wrong-session", "owner-csrf"))
      .statusCode,
  ).toBe(403);
  expect(
    (await observe(api, baselineRequest, "owner-session", "wrong-csrf"))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await observe(api, {
        ...baselineRequest,
        policyRevision: 1,
        releaseCommit,
        serviceInstanceId: "caller-supplied",
      })
    ).statusCode,
  ).toBe(400);

  const baseline = await observe(api, baselineRequest);
  expect(baseline.statusCode).toBe(200);
  expect(baseline.body).toMatchObject({
    outcome: "passed",
    phase: "baseline",
    provenance: "server-recorded-authenticated-api",
    releaseCommit,
  });
  expect(JSON.stringify(baseline.body)).not.toContain("service-baseline");
  expect(JSON.stringify(baseline.body)).not.toContain("boot-baseline");
  expect((await observe(api, baselineRequest)).statusCode).toBe(409);

  let campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign?.nextObservation?.phase).toBe("service-restart");
  if (campaign?.nextObservation === null || campaign === undefined) {
    throw new Error("The service-restart challenge was not issued");
  }
  const serviceRequest = requestBody(campaign);
  const wrongPhase = await observe(api, {
    ...serviceRequest,
    phase: "host-reboot",
  });
  expect(wrongPhase).toMatchObject({
    body: { reason: "phase-out-of-order" },
    statusCode: 409,
  });

  const unchangedService = await observe(api, serviceRequest);
  expect(unchangedService).toMatchObject({
    body: { reason: "service-instance-unchanged" },
    statusCode: 409,
  });
  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign?.observations.at(-1)).toMatchObject({
    failure: "service-instance-unchanged",
    outcome: "failed",
    phase: "service-restart",
  });
  expect(campaign?.nextObservation?.challenge).not.toBe(
    serviceRequest.challenge,
  );
  expect((await observe(api, serviceRequest)).statusCode).toBe(409);

  fixture.host.serviceInstanceId =
    administrativeRestartWitnessServiceInstanceIdSchema.parse(
      "service-after-restart",
    );
  if (campaign?.nextObservation === null || campaign === undefined) {
    throw new Error("The retry challenge was not issued");
  }
  expect((await observe(api, requestBody(campaign))).statusCode).toBe(200);

  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  if (campaign?.nextObservation === null || campaign === undefined) {
    throw new Error("The host-reboot challenge was not issued");
  }
  const hostRequest = requestBody(campaign);
  const unchangedBoot = await observe(api, hostRequest);
  expect(unchangedBoot).toMatchObject({
    body: { reason: "boot-identity-unchanged" },
    statusCode: 409,
  });
  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign?.nextObservation?.challenge).not.toBe(hostRequest.challenge);
  fixture.host.bootIdentity = agentHostBootIdentitySchema.parse(
    "boot-after-reboot",
  );
  if (campaign?.nextObservation === null || campaign === undefined) {
    throw new Error("The host-reboot retry challenge was not issued");
  }
  expect((await observe(api, requestBody(campaign))).statusCode).toBe(200);

  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign).toMatchObject({
    nextObservation: null,
    status: "completed",
  });
  expect(campaign?.observations.filter(({ outcome }) => outcome === "passed"))
    .toHaveLength(3);
  expect(campaign?.observations).toHaveLength(5);
  if (campaign === undefined) {
    throw new Error("The completed campaign was not persisted");
  }
  expect(
    evaluateAdministrativeAutonomyRestartWitness(
      administrativeRestartWitnessRecord(campaign),
    ),
  ).toEqual({
    errors: [],
    observedExecutionManifestFingerprint:
      administrativeExecutionManifestFingerprint(
        administrativeUnavailableExecutionManifest,
      ),
    observedPolicyRevision: 1,
    observedPolicyStateVersion: 1,
    ready: true,
  });

  await api.close();
  await fixture.store.close();
  await fixture.policyStore.close();
});

test("phase challenges and authenticated observations survive process restart", async () => {
  const fixture = await createFixture();
  const baselineRequest = requestBody(fixture.campaign);
  expect((await fixture.runtime.observe(identity(baselineRequest))).decision).toBe(
    "recorded",
  );
  const serviceChallenge = (
    await fixture.store.readCampaign(fixture.campaign.campaignId)
  )?.nextObservation;
  await fixture.store.close();

  const restartedStore = createSqliteAdministrativeRestartWitnessStore(
    fixture.databasePath,
  );
  const restartedRuntime = createAdministrativeRestartWitnessRuntime({
    host: { async read() { return fixture.host; } },
    identifiers: challengeIdentifiers("restart"),
    now: () => "2026-09-01T14:05:00.000Z",
    store: restartedStore,
  });
  if (serviceChallenge === null || serviceChallenge === undefined) {
    throw new Error("The service challenge was not persisted");
  }
  fixture.host.serviceInstanceId =
    administrativeRestartWitnessServiceInstanceIdSchema.parse(
      "service-after-process-restart",
    );
  expect(
    (
      await restartedRuntime.observe({
        campaignId: fixture.campaign.campaignId,
        ...serviceChallenge,
      })
    ).decision,
  ).toBe("recorded");
  expect(
    (
      await restartedRuntime.observe({
        campaignId: fixture.campaign.campaignId,
        ...serviceChallenge,
      })
    ).decision,
  ).toBe("denied");

  await restartedStore.close();
  await fixture.policyStore.close();
});

test("an unavailable composition observation is durable and consumes its challenge", async () => {
  const fixture = await createFixture();
  const original = requestBody(fixture.campaign);
  fixture.hostReadFailure.active = true;

  expect(await fixture.runtime.observe(identity(original))).toEqual({
    decision: "denied",
    reason: "host-observation-unavailable",
  });
  const campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign?.observations).toEqual([
    expect.objectContaining({
      failure: "host-observation-unavailable",
      outcome: "failed",
      phase: "baseline",
    }),
  ]);
  expect(campaign?.nextObservation?.challenge).not.toBe(original.challenge);
  fixture.hostReadFailure.active = false;
  expect(await fixture.runtime.observe(identity(original))).toEqual({
    decision: "denied",
    reason: "challenge-consumed",
  });

  await fixture.store.close();
  await fixture.policyStore.close();
});

test("the host observation rejects a stale or non-root API process", () => {
  const activeReleasePath = `/opt/voice-agent/releases/${releaseCommit}`;
  const exact = {
    activeReleaseMode: 0o40555,
    activeReleaseOwnerUid: 0,
    activeReleasePath,
    apiEntrypointMode: 0o100444,
    apiEntrypointOwnerUid: 0,
    apiEntrypointPath: `${activeReleasePath}/apps/api/src/server.ts`,
    releaseCommit,
    witnessModuleMode: 0o100444,
    witnessModuleOwnerUid: 0,
    witnessModulePath:
      `${activeReleasePath}/packages/runtime/src/administrative-restart-witness.ts`,
  };

  expect(administrativeRestartWitnessReleaseProvenanceIsExact(exact)).toBe(
    true,
  );
  for (const mutation of [
    {
      apiEntrypointPath:
        `/opt/voice-agent/releases/${"c".repeat(40)}/apps/api/src/server.ts`,
    },
    { activeReleaseOwnerUid: 501 },
    { apiEntrypointOwnerUid: 501 },
    { witnessModuleOwnerUid: 501 },
    { activeReleaseMode: 0o40755 },
    { apiEntrypointMode: 0o100664 },
    { witnessModuleMode: 0o100644 },
  ]) {
    expect(
      administrativeRestartWitnessReleaseProvenanceIsExact({
        ...exact,
        ...mutation,
      }),
    ).toBe(false);
  }
});

test("the host observation rejects mutable or unowned transitive Release files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "voice-agent-api-release-"));
  temporaryDirectories.push(parent);
  await mkdir(join(parent, "release"));
  const release = await realpath(join(parent, "release"));
  const transitiveModule = join(release, "transitive-store-module.ts");
  await writeFile(transitiveModule, "export {};\n");
  await chmod(transitiveModule, 0o444);
  await chmod(release, 0o555);
  const ownerUid = process.getuid?.() ?? 0;

  try {
    await expect(
      administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
        release,
        ownerUid,
      ),
    ).resolves.toBe(true);
    await chmod(transitiveModule, 0o644);
    await expect(
      administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
        release,
        ownerUid,
      ),
    ).resolves.toBe(false);
    await chmod(transitiveModule, 0o444);
    await expect(
      administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
        release,
        ownerUid + 1,
      ),
    ).resolves.toBe(false);
  } finally {
    await chmod(release, 0o700);
  }
});

test("campaign challenges and observations remain append-only after restart", async () => {
  const fixture = await createFixture();
  await fixture.runtime.observe(identity(requestBody(fixture.campaign)));
  const afterBaseline = await fixture.store.readCampaign(
    fixture.campaign.campaignId,
  );
  if (afterBaseline === undefined || afterBaseline.nextObservation === null) {
    throw new Error("The service-restart challenge was not issued");
  }
  expect(
    await fixture.runtime.observe({
      campaignId: fixture.campaign.campaignId,
      ...afterBaseline.nextObservation,
    }),
  ).toEqual({
    decision: "denied",
    reason: "service-instance-unchanged",
  });
  await fixture.store.close();
  const database = new Database(fixture.databasePath);

  const columns = database
    .prepare("PRAGMA table_info(administrative_restart_witness_observations)")
    .all() as ReadonlyArray<{ readonly name: string }>;
  expect(columns.map(({ name }) => name)).toContain(
    "service_instance_fingerprint",
  );
  expect(columns.map(({ name }) => name)).toContain("boot_identity_fingerprint");
  expect(columns.map(({ name }) => name)).not.toContain("service_instance_id");
  expect(columns.map(({ name }) => name)).not.toContain("boot_identity");
  const privateComparisons = database
    .prepare(
      `SELECT service_instance_fingerprint, boot_identity_fingerprint
       FROM administrative_restart_witness_observations
       ORDER BY sequence`,
    )
    .all() as ReadonlyArray<{
    readonly boot_identity_fingerprint: string | null;
    readonly service_instance_fingerprint: string | null;
  }>;
  expect(privateComparisons[0]?.service_instance_fingerprint).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(privateComparisons[0]?.boot_identity_fingerprint).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(privateComparisons[1]).toEqual({
    boot_identity_fingerprint: null,
    service_instance_fingerprint: null,
  });
  expect(JSON.stringify(privateComparisons)).not.toContain("service-baseline");
  expect(JSON.stringify(privateComparisons)).not.toContain("boot-baseline");

  expect(() =>
    database
      .prepare(
        "UPDATE administrative_restart_witness_observations SET outcome = 'failed'",
      )
      .run(),
  ).toThrow(/observations are immutable/u);
  expect(() =>
    database
      .prepare("DELETE FROM administrative_restart_witness_observations")
      .run(),
  ).toThrow(/observations are append-only/u);
  expect(() =>
    database
      .prepare("DELETE FROM administrative_restart_witness_challenges")
      .run(),
  ).toThrow(/challenges are append-only/u);
  database.close();

  const restarted = createSqliteAdministrativeRestartWitnessStore(
    fixture.databasePath,
  );
  expect(
    (await restarted.readCampaign(fixture.campaign.campaignId))?.observations,
  ).toHaveLength(2);
  await restarted.close();
  await fixture.policyStore.close();
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-restart-witness-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const policyStore = createSqliteAdministrativeAutonomyStore(databasePath);
  await policyStore.activatePolicy({
    expectation: {
      expectedActiveRevision: null,
      expectedExecutionManifestFingerprint:
        administrativeExecutionManifestFingerprint(
          administrativeUnavailableExecutionManifest,
        ),
      expectedStateVersion: 0,
    },
    revision: {
      activatedAt: administrativeTimestampSchema.parse(
        "2026-09-01T14:00:00.000Z",
      ),
      activatedBy: "fresh-passkey-action",
      definition: administrativeAutonomyPolicyDefinition,
      executionManifest: administrativeUnavailableExecutionManifest,
      revision: 1,
    },
    stateVersion: 1,
  });
  const store = createSqliteAdministrativeRestartWitnessStore(databasePath);
  const campaign = await store.ensureCampaign({
    campaignId: administrativeRestartWitnessCampaignIdSchema.parse(
      "administrative-restart-campaign-release-a",
    ),
    createdAt: administrativeTimestampSchema.parse(
      "2026-09-01T14:00:01.000Z",
    ),
    initialChallenge: administrativeRestartWitnessChallengeSchema.parse(
      "administrative-restart-challenge-baseline",
    ),
    releaseCommit,
  });
  const host: AdministrativeRestartWitnessHostObservation = administrativeRestartWitnessHostObservationSchema.parse({
    bootIdentity: agentHostBootIdentitySchema.parse("boot-baseline"),
    releaseCommit,
    serviceInstanceId: administrativeRestartWitnessServiceInstanceIdSchema.parse(
      "service-baseline",
    ),
  });
  const hostReadFailure = { active: false };
  const runtime = createAdministrativeRestartWitnessRuntime({
    host: {
      async read() {
        if (hostReadFailure.active) throw new Error("host read unavailable");
        return host;
      },
    },
    identifiers: challengeIdentifiers("first-process"),
    now: () => "2026-09-01T14:01:00.000Z",
    store,
  });
  return {
    campaign,
    databasePath,
    host,
    hostReadFailure,
    policyStore,
    runtime,
    store,
  };
}

function challengeIdentifiers(prefix: string) {
  let sequence = 0;
  return {
    nextChallenge: () =>
      administrativeRestartWitnessChallengeSchema.parse(
        `administrative-restart-challenge-${prefix}-${++sequence}`,
      ),
  };
}

function requestBody(campaign: AdministrativeRestartWitnessCampaign) {
  if (campaign.nextObservation === null) {
    throw new Error("The restart campaign has no pending observation");
  }
  return {
    campaignId: campaign.campaignId,
    challenge: campaign.nextObservation.challenge,
    csrfToken: "owner-csrf",
    phase: campaign.nextObservation.phase,
  };
}

function identity(input: ReturnType<typeof requestBody>) {
  return {
    campaignId: input.campaignId,
    challenge: input.challenge,
    phase: input.phase,
  };
}

async function observe(
  api: ReturnType<typeof createTaskApi>,
  body: Record<string, unknown>,
  session: string | null = "owner-session",
  csrfToken = "owner-csrf",
) {
  const response = await api.inject({
    headers: {
      ...(session === null
        ? {}
        : { cookie: `${trustedSessionCookieName}=${session}` }),
      origin,
    },
    method: "POST",
    payload: { ...body, csrfToken },
    url: "/api/administrative-autonomy/restart-witness/observations",
  });
  return { body: response.json() as unknown, statusCode: response.statusCode };
}
