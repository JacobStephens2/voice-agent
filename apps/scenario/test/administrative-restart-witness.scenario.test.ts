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
import { createServer } from "node:http";

import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import {
  administrativeRestartWitnessCampaignIdSchema,
  administrativeRestartWitnessChallengeSchema,
  administrativeExecutionManifestFingerprint,
  administrativeRestartWitnessRecord,
  administrativeRestartWitnessHostObservationSchema,
  administrativeRestartWitnessReleaseCommitSchema,
  administrativeTimestampSchema,
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
  administrativeRestartWitnessIdentityFingerprint,
  administrativeRestartWitnessServiceReleaseProvenanceIsExact,
  AdministrativeRestartWitnessWorkerObservationError,
  createAdministrativeRestartWitnessRuntime,
  createNodeAdministrativeRestartWitnessWorkerHealth,
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
  expect(
    (
      await observe(api, {
        ...baselineRequest,
        workerServiceInstanceId: "caller-supplied-worker",
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
  expect(JSON.stringify(baseline.body)).not.toContain(
    fixture.identities.api,
  );
  expect(JSON.stringify(baseline.body)).not.toContain(
    fixture.identities.worker,
  );
  expect(JSON.stringify(baseline.body)).not.toContain(fixture.bootIdentity);
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
    body: { reason: "api-service-instance-unchanged" },
    statusCode: 409,
  });
  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign?.observations.at(-1)).toMatchObject({
    failure: "api-service-instance-unchanged",
    outcome: "failed",
    phase: "service-restart",
  });
  expect(campaign?.nextObservation?.challenge).not.toBe(
    serviceRequest.challenge,
  );
  expect((await observe(api, serviceRequest)).statusCode).toBe(409);

  await restartService(fixture, "worker");
  if (campaign?.nextObservation === null || campaign === undefined) {
    throw new Error("The worker-only retry challenge was not issued");
  }
  expect(await observe(api, requestBody(campaign))).toMatchObject({
    body: { reason: "api-service-instance-unchanged" },
    statusCode: 409,
  });
  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  await restartService(fixture, "api");
  if (campaign?.nextObservation === null || campaign === undefined) {
    throw new Error("The retry challenge was not issued");
  }
  expect(await observe(api, requestBody(campaign))).toMatchObject({
    body: {
      checks: {
        apiServiceInstanceChanged: true,
        authorityUnchanged: true,
        bootIdentityUnchanged: true,
        workerServiceInstanceChanged: true,
      },
      outcome: "passed",
      phase: "service-restart",
    },
    statusCode: 200,
  });

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
  await rebootServices(fixture);
  if (campaign?.nextObservation === null || campaign === undefined) {
    throw new Error("The host-reboot retry challenge was not issued");
  }
  expect(await observe(api, requestBody(campaign))).toMatchObject({
    body: {
      checks: {
        apiServiceInstanceStable: true,
        authorityUnchanged: true,
        bootIdentityChanged: true,
        workerServiceInstanceStable: true,
      },
      outcome: "passed",
      phase: "host-reboot",
    },
    statusCode: 200,
  });

  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign).toMatchObject({
    nextObservation: null,
    status: "completed",
  });
  expect(campaign?.observations.filter(({ outcome }) => outcome === "passed"))
    .toHaveLength(3);
  expect(campaign?.observations).toHaveLength(6);
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

test("service restart requires both API and worker identities to change", async () => {
  for (const unchangedService of ["api", "worker"] as const) {
    const fixture = await createFixture();
    await fixture.runtime.observe(identity(requestBody(fixture.campaign)));
    let campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
    if (campaign === undefined || campaign.nextObservation === null) {
      throw new Error("The service-restart challenge was not issued");
    }
    await restartService(fixture, unchangedService === "api" ? "worker" : "api");

    expect(
      await fixture.runtime.observe({
        campaignId: fixture.campaign.campaignId,
        ...campaign.nextObservation,
      }),
    ).toEqual({
      decision: "denied",
      reason:
        unchangedService === "api"
          ? "api-service-instance-unchanged"
          : "worker-service-instance-unchanged",
    });
    campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
    expect(campaign?.observations.at(-1)).toMatchObject({
      outcome: "failed",
      phase: "service-restart",
    });

    await fixture.store.close();
    await fixture.policyStore.close();
  }
});

test("worker observation failure is append-only, retry-safe, and resumable", async () => {
  const fixture = await createFixture();
  const request = requestBody(fixture.campaign);
  fixture.workerObservationFailure.active = true;

  expect(await fixture.runtime.observe(identity(request))).toEqual({
    decision: "denied",
    reason: "worker-observation-unavailable",
  });
  let campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  expect(campaign?.observations).toEqual([
    expect.objectContaining({
      failure: "worker-observation-unavailable",
      outcome: "failed",
      phase: "baseline",
    }),
  ]);
  expect(await fixture.runtime.observe(identity(request))).toEqual({
    decision: "denied",
    reason: "challenge-consumed",
  });

  await fixture.store.close();
  const restartedStore = createSqliteAdministrativeRestartWitnessStore(
    fixture.databasePath,
  );
  fixture.workerObservationFailure.active = false;
  campaign = await restartedStore.readCampaign(fixture.campaign.campaignId);
  if (campaign === undefined || campaign.nextObservation === null) {
    throw new Error("The worker observation retry challenge was not persisted");
  }
  const restarted = createAdministrativeRestartWitnessRuntime({
    host: restartWitnessHost(fixture, restartedStore),
    identifiers: challengeIdentifiers("worker-observation-restart"),
    now: () => "2026-09-01T14:02:00.000Z",
    store: restartedStore,
  });
  expect(
    await restarted.observe({
      campaignId: fixture.campaign.campaignId,
      ...campaign.nextObservation,
    }),
  ).toMatchObject({ decision: "recorded" });

  await restartedStore.close();
  await fixture.policyStore.close();
});

test("the deployment worker observation requires a live localhost health response", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.end("ready");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The worker health test server did not bind a TCP port");
  }
  const health = createNodeAdministrativeRestartWitnessWorkerHealth({
    port: address.port,
  });
  await expect(health.requireAvailable()).resolves.toBeUndefined();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  await expect(health.requireAvailable()).rejects.toThrow();
});

test("host reboot requires the accepted API and worker identities to remain stable", async () => {
  const fixture = await createFixture();
  await fixture.runtime.observe(identity(requestBody(fixture.campaign)));
  await restartService(fixture, "api");
  await restartService(fixture, "worker");
  let campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  if (campaign === undefined || campaign.nextObservation === null) {
    throw new Error("The service-restart challenge was not issued");
  }
  await fixture.runtime.observe({
    campaignId: fixture.campaign.campaignId,
    ...campaign.nextObservation,
  });
  await rebootServices(fixture);
  await restartService(fixture, "worker");
  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  if (campaign === undefined || campaign.nextObservation === null) {
    throw new Error("The host-reboot challenge was not issued");
  }

  expect(
    await fixture.runtime.observe({
      campaignId: fixture.campaign.campaignId,
      ...campaign.nextObservation,
    }),
  ).toEqual({
    decision: "denied",
    reason: "worker-service-instance-changed-during-host-reboot",
  });

  await fixture.store.close();
  await fixture.policyStore.close();
});

test("host reboot carries the accepted service identities past later same-boot restarts", async () => {
  const fixture = await createFixture();
  await fixture.runtime.observe(identity(requestBody(fixture.campaign)));
  await restartService(fixture, "api");
  await restartService(fixture, "worker");
  let campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  if (campaign === undefined || campaign.nextObservation === null) {
    throw new Error("The service-restart challenge was not issued");
  }
  await fixture.runtime.observe({
    campaignId: fixture.campaign.campaignId,
    ...campaign.nextObservation,
  });
  await restartService(fixture, "api");
  await restartService(fixture, "worker");
  await rebootServices(fixture);
  campaign = await fixture.store.readCampaign(fixture.campaign.campaignId);
  if (campaign === undefined || campaign.nextObservation === null) {
    throw new Error("The host-reboot challenge was not issued");
  }

  expect(
    await fixture.runtime.observe({
      campaignId: fixture.campaign.campaignId,
      ...campaign.nextObservation,
    }),
  ).toMatchObject({ decision: "recorded" });

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
    host: restartWitnessHost(fixture, restartedStore),
    identifiers: challengeIdentifiers("restart"),
    now: () => "2026-09-01T14:05:00.000Z",
    store: restartedStore,
  });
  if (serviceChallenge === null || serviceChallenge === undefined) {
    throw new Error("The service challenge was not persisted");
  }
  await restartService(fixture, "api", restartedStore);
  await restartService(fixture, "worker", restartedStore);
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

test("worker service identity rejects stale, mutable, or unowned deployment provenance", () => {
  const activeReleasePath = `/opt/voice-agent/releases/${releaseCommit}`;
  const exact = {
    activeReleaseMode: 0o40555,
    activeReleaseOwnerUid: 0,
    activeReleasePath,
    releaseCommit,
    service: "worker" as const,
    serviceEntrypointMode: 0o100444,
    serviceEntrypointOwnerUid: 0,
    serviceEntrypointPath: `${activeReleasePath}/apps/worker/src/server.ts`,
    witnessModuleMode: 0o100444,
    witnessModuleOwnerUid: 0,
    witnessModulePath:
      `${activeReleasePath}/packages/runtime/src/administrative-restart-witness.ts`,
  };

  expect(
    administrativeRestartWitnessServiceReleaseProvenanceIsExact(exact),
  ).toBe(true);
  for (const mutation of [
    {
      serviceEntrypointPath:
        `/opt/voice-agent/releases/${"c".repeat(40)}/apps/worker/src/server.ts`,
    },
    { serviceEntrypointOwnerUid: 501 },
    { serviceEntrypointMode: 0o100644 },
    { activeReleaseOwnerUid: 501 },
    { activeReleaseMode: 0o40755 },
  ]) {
    expect(
      administrativeRestartWitnessServiceReleaseProvenanceIsExact({
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
    reason: "api-service-instance-unchanged",
  });
  expect(
    await fixture.store.readServiceInstances({
      bootIdentityFingerprint: fingerprint(
        "agent-host-boot",
        fixture.bootIdentity,
      ),
      releaseCommit: administrativeRestartWitnessReleaseCommitSchema.parse(
        "b".repeat(40),
      ),
    }),
  ).toEqual({});
  await fixture.store.close();
  const database = new Database(fixture.databasePath);

  const columns = database
    .prepare("PRAGMA table_info(administrative_restart_witness_observations)")
    .all() as ReadonlyArray<{ readonly name: string }>;
  expect(columns.map(({ name }) => name)).toContain(
    "service_instance_fingerprint",
  );
  expect(columns.map(({ name }) => name)).toContain(
    "worker_service_instance_fingerprint",
  );
  expect(columns.map(({ name }) => name)).toContain("boot_identity_fingerprint");
  expect(columns.map(({ name }) => name)).not.toContain("service_instance_id");
  expect(columns.map(({ name }) => name)).not.toContain("boot_identity");
  const privateComparisons = database
    .prepare(
      `SELECT service_instance_fingerprint,
        worker_service_instance_fingerprint, boot_identity_fingerprint
       FROM administrative_restart_witness_observations
       ORDER BY sequence`,
    )
    .all() as ReadonlyArray<{
    readonly boot_identity_fingerprint: string | null;
    readonly service_instance_fingerprint: string | null;
    readonly worker_service_instance_fingerprint: string | null;
  }>;
  expect(privateComparisons[0]?.service_instance_fingerprint).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(privateComparisons[0]?.boot_identity_fingerprint).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(privateComparisons[0]?.worker_service_instance_fingerprint).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(privateComparisons[1]).toEqual({
    boot_identity_fingerprint: null,
    service_instance_fingerprint: null,
    worker_service_instance_fingerprint: null,
  });
  expect(JSON.stringify(privateComparisons)).not.toContain(
    fixture.identities.api,
  );
  expect(JSON.stringify(privateComparisons)).not.toContain(
    fixture.identities.worker,
  );
  expect(JSON.stringify(privateComparisons)).not.toContain(fixture.bootIdentity);
  const serviceInstanceColumns = database
    .prepare(
      "PRAGMA table_info(administrative_restart_witness_service_instances)",
    )
    .all() as ReadonlyArray<{ readonly name: string }>;
  expect(serviceInstanceColumns.map(({ name }) => name)).toContain(
    "instance_fingerprint",
  );
  expect(serviceInstanceColumns.map(({ name }) => name)).not.toContain(
    "instance_id",
  );
  expect(serviceInstanceColumns.map(({ name }) => name)).not.toContain(
    "boot_identity",
  );
  const serviceInstances = database
    .prepare(
      `SELECT service, instance_fingerprint, boot_identity_fingerprint
       FROM administrative_restart_witness_service_instances
       ORDER BY sequence`,
    )
    .all();
  expect(serviceInstances).toHaveLength(2);
  expect(JSON.stringify(serviceInstances)).not.toContain(fixture.identities.api);
  expect(JSON.stringify(serviceInstances)).not.toContain(
    fixture.identities.worker,
  );
  expect(() =>
    database
      .prepare(
        `UPDATE administrative_restart_witness_service_instances
         SET instance_fingerprint = ?`,
      )
      .run("f".repeat(64)),
  ).toThrow(/service instances are immutable/u);
  expect(() =>
    database
      .prepare("DELETE FROM administrative_restart_witness_service_instances")
      .run(),
  ).toThrow(/current service instances are retained/u);

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

test("superseded service startup fingerprints retain a bounded current projection", async () => {
  const fixture = await createFixture();
  for (let restart = 0; restart < 24; restart += 1) {
    await restartService(fixture, "api");
    await restartService(fixture, "worker");
  }
  const current = await fixture.store.readServiceInstances({
    bootIdentityFingerprint: fingerprint(
      "agent-host-boot",
      fixture.bootIdentity,
    ),
    releaseCommit,
  });
  expect(current).toEqual({
    api: fingerprint("api-service-instance", fixture.identities.api),
    worker: fingerprint("worker-service-instance", fixture.identities.worker),
  });
  await fixture.store.close();
  const database = new Database(fixture.databasePath);
  expect(
    database
      .prepare(
        `SELECT service, COUNT(*) AS count
         FROM administrative_restart_witness_service_instances
         GROUP BY service ORDER BY service`,
      )
      .all(),
  ).toEqual([
    { count: 16, service: "api" },
    { count: 16, service: "worker" },
  ]);
  database.close();
  await fixture.policyStore.close();
});

test("a V2 campaign remains readable and resumes with a worker-bound V3 baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-restart-v2-"));
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
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE administrative_restart_witness_campaigns (
      campaign_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      release_commit TEXT NOT NULL UNIQUE
    );
    CREATE TABLE administrative_restart_witness_challenges (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      challenge TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL,
      issued_at TEXT NOT NULL
    );
    CREATE TABLE administrative_restart_witness_observations (
      campaign_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      challenge TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL,
      outcome TEXT NOT NULL,
      failure TEXT,
      observed_at TEXT NOT NULL,
      policy_revision INTEGER,
      policy_state_version INTEGER,
      execution_manifest_fingerprint TEXT,
      release_commit TEXT,
      service_instance_fingerprint TEXT,
      boot_identity_fingerprint TEXT,
      PRIMARY KEY (campaign_id, sequence)
    );
  `);
  const legacyCampaignId = "administrative-restart-campaign-legacy-v2";
  const legacyChallenge = "administrative-restart-challenge-legacy-v2";
  legacy
    .prepare(
      `INSERT INTO administrative_restart_witness_campaigns
       (campaign_id, created_at, release_commit) VALUES (?, ?, ?)`,
    )
    .run(legacyCampaignId, "2026-09-01T13:00:00.000Z", releaseCommit);
  legacy
    .prepare(
      `INSERT INTO administrative_restart_witness_challenges
       (campaign_id, challenge, phase, issued_at) VALUES (?, ?, ?, ?)`,
    )
    .run(
      legacyCampaignId,
      legacyChallenge,
      "baseline",
      "2026-09-01T13:00:00.000Z",
    );
  legacy
    .prepare(
      `INSERT INTO administrative_restart_witness_observations
       (campaign_id, sequence, challenge, phase, outcome, failure, observed_at,
        policy_revision, policy_state_version, execution_manifest_fingerprint,
        release_commit, service_instance_fingerprint, boot_identity_fingerprint)
       VALUES (?, 1, ?, 'baseline', 'passed', NULL, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(
      legacyCampaignId,
      legacyChallenge,
      "2026-09-01T13:01:00.000Z",
      administrativeExecutionManifestFingerprint(
        administrativeUnavailableExecutionManifest,
      ),
      releaseCommit,
      "1".repeat(64),
      "2".repeat(64),
    );
  legacy.close();

  const store = createSqliteAdministrativeRestartWitnessStore(databasePath);
  expect(
    (await store.readCampaign(
      administrativeRestartWitnessCampaignIdSchema.parse(legacyCampaignId),
    ))?.status,
  ).toBe("migration-required");
  const campaign = await store.ensureCampaign({
    campaignId: administrativeRestartWitnessCampaignIdSchema.parse(
      legacyCampaignId,
    ),
    createdAt: administrativeTimestampSchema.parse(
      "2026-09-01T14:00:00.000Z",
    ),
    initialChallenge: administrativeRestartWitnessChallengeSchema.parse(
      "administrative-restart-challenge-v3-baseline",
    ),
    releaseCommit,
  });
  expect(campaign.observations[0]).toMatchObject({
    checks: { authorityCaptured: true },
    outcome: "passed",
    phase: "baseline",
  });
  expect(campaign.nextObservation).toMatchObject({ phase: "baseline" });
  if (campaign.nextObservation === null) {
    throw new Error("The V3 baseline challenge was not issued");
  }
  expect(
    await store.observe({
      identity: {
        campaignId: campaign.campaignId,
        ...campaign.nextObservation,
      },
      nextChallenge: administrativeRestartWitnessChallengeSchema.parse(
        "administrative-restart-challenge-v3-service",
      ),
      observedAt: administrativeTimestampSchema.parse(
        "2026-09-01T14:01:00.000Z",
      ),
      observation: administrativeRestartWitnessHostObservationSchema.parse({
        apiServiceInstanceFingerprint: fingerprint(
          "api-service-instance",
          "v3-api",
        ),
        bootIdentityFingerprint: fingerprint("agent-host-boot", "v3-boot"),
        releaseCommit,
        workerServiceInstanceFingerprint: fingerprint(
          "worker-service-instance",
          "v3-worker",
        ),
      }),
    }),
  ).toMatchObject({ decision: "recorded" });
  await store.close();

  const evidence = new Database(databasePath);
  const challenges = evidence
    .prepare(
      `SELECT challenge, witness_version
       FROM administrative_restart_witness_challenges ORDER BY sequence`,
    )
    .all();
  expect(challenges).toEqual([
    { challenge: legacyChallenge, witness_version: 2 },
    {
      challenge: "administrative-restart-challenge-v3-baseline",
      witness_version: 3,
    },
    {
      challenge: "administrative-restart-challenge-v3-service",
      witness_version: 3,
    },
  ]);
  const observations = evidence
    .prepare(
      `SELECT challenge, worker_service_instance_fingerprint
       FROM administrative_restart_witness_observations ORDER BY sequence`,
    )
    .all();
  expect(observations).toEqual([
    {
      challenge: legacyChallenge,
      worker_service_instance_fingerprint: null,
    },
    {
      challenge: "administrative-restart-challenge-v3-baseline",
      worker_service_instance_fingerprint: fingerprint(
        "worker-service-instance",
        "v3-worker",
      ),
    },
  ]);
  evidence.close();
  await policyStore.close();
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
  const bootState = { raw: "boot-baseline" };
  const identities = {
    api: "api-service-baseline",
    worker: "worker-service-baseline",
  };
  const serviceSequence = { api: 0, worker: 0 };
  await store.registerServiceInstance({
    bootIdentityFingerprint: fingerprint("agent-host-boot", bootState.raw),
    candidateInstanceFingerprint: fingerprint(
      "api-service-instance",
      identities.api,
    ),
    registeredAt: administrativeTimestampSchema.parse(
      "2026-09-01T14:00:00.000Z",
    ),
    releaseCommit,
    service: "api",
  });
  await store.registerServiceInstance({
    bootIdentityFingerprint: fingerprint("agent-host-boot", bootState.raw),
    candidateInstanceFingerprint: fingerprint(
      "worker-service-instance",
      identities.worker,
    ),
    registeredAt: administrativeTimestampSchema.parse(
      "2026-09-01T14:00:00.000Z",
    ),
    releaseCommit,
    service: "worker",
  });
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
  const hostReadFailure = { active: false };
  const workerObservationFailure = { active: false };
  const fixtureState = {
    bootState,
    databasePath,
    hostReadFailure,
    identities,
    policyStore,
    releaseCommit,
    serviceSequence,
    store,
    workerObservationFailure,
  };
  const runtimeHost = restartWitnessHost(fixtureState, store);
  const runtime = createAdministrativeRestartWitnessRuntime({
    host: runtimeHost,
    identifiers: challengeIdentifiers("first-process"),
    now: () => "2026-09-01T14:01:00.000Z",
    store,
  });
  return {
    campaign,
    bootState,
    get bootIdentity() {
      return bootState.raw;
    },
    databasePath,
    hostReadFailure,
    identities,
    policyStore,
    runtime,
    runtimeHost,
    serviceSequence,
    store,
    workerObservationFailure,
  };
}

type RestartWitnessStore = ReturnType<
  typeof createSqliteAdministrativeRestartWitnessStore
>;
interface RestartWitnessServiceState {
  readonly bootState: { raw: string };
  readonly hostReadFailure: { active: boolean };
  readonly identities: { api: string; worker: string };
  readonly serviceSequence: { api: number; worker: number };
  readonly store: RestartWitnessStore;
  readonly workerObservationFailure: { active: boolean };
}

function restartWitnessHost(
  fixture: Pick<
    RestartWitnessServiceState,
    "bootState" | "hostReadFailure" | "workerObservationFailure"
  >,
  store: RestartWitnessStore,
) {
  return {
    async read(): Promise<AdministrativeRestartWitnessHostObservation> {
      if (fixture.hostReadFailure.active) {
        throw new Error("host read unavailable");
      }
      if (fixture.workerObservationFailure.active) {
        throw new AdministrativeRestartWitnessWorkerObservationError();
      }
      const serviceInstances = await store.readServiceInstances({
        bootIdentityFingerprint: fingerprint(
          "agent-host-boot",
          fixture.bootState.raw,
        ),
        releaseCommit,
      });
      if (serviceInstances.worker === undefined) {
        throw new AdministrativeRestartWitnessWorkerObservationError();
      }
      if (serviceInstances.api === undefined) {
        throw new Error("API service observation unavailable");
      }
      return administrativeRestartWitnessHostObservationSchema.parse({
        apiServiceInstanceFingerprint: serviceInstances.api,
        bootIdentityFingerprint: fingerprint(
          "agent-host-boot",
          fixture.bootState.raw,
        ),
        releaseCommit,
        workerServiceInstanceFingerprint: serviceInstances.worker,
      });
    },
  };
}

async function restartService(
  fixture: RestartWitnessServiceState,
  service: "api" | "worker",
  store: RestartWitnessStore = fixture.store,
): Promise<void> {
  fixture.serviceSequence[service] += 1;
  fixture.identities[service] =
    `${service}-service-restart-${fixture.serviceSequence[service]}`;
  const common = {
    bootIdentityFingerprint: fingerprint(
      "agent-host-boot",
      fixture.bootState.raw,
    ),
    registeredAt: administrativeTimestampSchema.parse(
      "2026-09-01T14:03:00.000Z",
    ),
    releaseCommit,
  };
  await (service === "api"
    ? store.registerServiceInstance({
        ...common,
        candidateInstanceFingerprint: fingerprint(
          "api-service-instance",
          fixture.identities.api,
        ),
        service,
      })
    : store.registerServiceInstance({
        ...common,
        candidateInstanceFingerprint: fingerprint(
          "worker-service-instance",
          fixture.identities.worker,
        ),
        service,
      }));
}

async function rebootServices(
  fixture: RestartWitnessServiceState,
): Promise<void> {
  fixture.bootState.raw = "boot-after-reboot";
  await restartService(fixture, "api");
  await restartService(fixture, "worker");
}

function fingerprint(
  kind: "agent-host-boot",
  raw: string,
): AdministrativeRestartWitnessHostObservation["bootIdentityFingerprint"];
function fingerprint(
  kind: "api-service-instance",
  raw: string,
): AdministrativeRestartWitnessHostObservation["apiServiceInstanceFingerprint"];
function fingerprint(
  kind: "worker-service-instance",
  raw: string,
): AdministrativeRestartWitnessHostObservation["workerServiceInstanceFingerprint"];
function fingerprint(
  kind:
    | "agent-host-boot"
    | "api-service-instance"
    | "worker-service-instance",
  raw: string,
):
  | AdministrativeRestartWitnessHostObservation["apiServiceInstanceFingerprint"]
  | AdministrativeRestartWitnessHostObservation["bootIdentityFingerprint"]
  | AdministrativeRestartWitnessHostObservation["workerServiceInstanceFingerprint"] {
  return administrativeRestartWitnessIdentityFingerprint(kind, raw);
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
