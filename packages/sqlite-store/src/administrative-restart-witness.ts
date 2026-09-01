import Database from "better-sqlite3";

import {
  administrativeExecutionManifestFingerprint,
  administrativePolicyRevisionSchema,
  administrativeRestartWitnessApiServiceInstanceFingerprintSchema,
  administrativeRestartWitnessBootIdentityFingerprintSchema,
  administrativeRestartWitnessCampaignIdSchema,
  administrativeRestartWitnessCampaignSchema,
  administrativeRestartWitnessChallengeSchema,
  administrativeRestartWitnessFailureReasonSchema,
  administrativeRestartWitnessHostObservationSchema,
  administrativeRestartWitnessObservationIdentitySchema,
  administrativeRestartWitnessObservationSchema,
  administrativeRestartWitnessObservationResponseSchema,
  administrativeRestartWitnessReleaseCommitSchema,
  administrativeRestartWitnessServiceSchema,
  administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema,
  administrativeTimestampSchema,
  type AdministrativeRestartWitnessCampaign,
  type AdministrativeRestartWitnessFailureReason,
  type AdministrativeRestartWitnessObservation,
  type AdministrativeRestartWitnessObservationResponse,
  type AdministrativeRestartWitnessPhase,
} from "@voice-agent/contracts";
import type { AdministrativeRestartWitnessStore } from "@voice-agent/durable-store";

interface CampaignRow {
  readonly campaign_id: string;
  readonly created_at: string;
  readonly release_commit: string;
}

interface ChallengeRow {
  readonly challenge: string;
  readonly phase: AdministrativeRestartWitnessPhase;
  readonly witness_version: number;
}

interface ObservationRow {
  readonly boot_identity_fingerprint: string | null;
  readonly challenge: string;
  readonly execution_manifest_fingerprint: string | null;
  readonly failure: string | null;
  readonly observed_at: string;
  readonly outcome: "failed" | "passed";
  readonly phase: AdministrativeRestartWitnessPhase;
  readonly policy_revision: number | null;
  readonly policy_state_version: number | null;
  readonly release_commit: string | null;
  readonly sequence: number;
  readonly service_instance_fingerprint: string | null;
  readonly worker_service_instance_fingerprint: string | null;
  readonly witness_version: number;
}

interface ServiceInstanceRow {
  readonly boot_identity_fingerprint: string;
  readonly instance_fingerprint: string;
}

interface AcceptedServiceInstancesRow {
  readonly service_instance_fingerprint: string;
  readonly worker_service_instance_fingerprint: string;
}

interface PolicyAuthorityRow {
  readonly active_revision: number | null;
  readonly definition_json: string | null;
  readonly state_version: number;
  readonly status: "active" | "inactive" | "suspended";
}

const maximumObservationAttempts = 100;
const maximumServiceInstancesPerReleaseAndService = 16;
const orderedPhases = [
  "baseline",
  "service-restart",
  "host-reboot",
] as const;

export function createSqliteAdministrativeRestartWitnessStore(
  databasePath: string,
): AdministrativeRestartWitnessStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createSchema(database);

  const findCampaign = database.prepare<[campaignId: string], CampaignRow>(`
    SELECT campaign_id, created_at, release_commit
    FROM administrative_restart_witness_campaigns
    WHERE campaign_id = ?
  `);
  const findCampaignForRelease = database.prepare<
    [releaseCommit: string],
    CampaignRow
  >(`
    SELECT campaign_id, created_at, release_commit
    FROM administrative_restart_witness_campaigns
    WHERE release_commit = ?
  `);
  const insertCampaign = database.prepare(`
    INSERT INTO administrative_restart_witness_campaigns (
      campaign_id, created_at, release_commit
    ) VALUES (?, ?, ?)
  `);
  const insertChallenge = database.prepare(`
    INSERT INTO administrative_restart_witness_challenges (
      campaign_id, challenge, phase, issued_at, witness_version
    ) VALUES (?, ?, ?, ?, 3)
  `);
  const readCurrentChallenge = database.prepare<
    [campaignId: string],
    ChallengeRow
  >(`
    SELECT challenges.challenge, challenges.phase, challenges.witness_version
    FROM administrative_restart_witness_challenges AS challenges
    LEFT JOIN administrative_restart_witness_observations AS observations
      ON observations.challenge = challenges.challenge
    WHERE challenges.campaign_id = ?
      AND challenges.witness_version = 3
      AND observations.challenge IS NULL
    ORDER BY challenges.sequence DESC
    LIMIT 1
  `);
  const readChallenge = database.prepare<
    [campaignId: string, challenge: string],
    ChallengeRow
  >(`
    SELECT challenge, phase, witness_version
    FROM administrative_restart_witness_challenges
    WHERE campaign_id = ? AND challenge = ? AND witness_version = 3
  `);
  const challengeWasConsumed = database.prepare<
    [campaignId: string, challenge: string],
    { readonly consumed: number }
  >(`
    SELECT EXISTS(
      SELECT 1 FROM administrative_restart_witness_observations
      WHERE campaign_id = ? AND challenge = ?
    ) AS consumed
  `);
  const readObservations = database.prepare<
    [campaignId: string],
    ObservationRow
  >(`
    SELECT observations.sequence, observations.challenge, observations.phase,
      observations.outcome, observations.failure, observations.observed_at,
      observations.policy_revision, observations.policy_state_version,
      observations.execution_manifest_fingerprint,
      observations.release_commit, observations.service_instance_fingerprint,
      observations.worker_service_instance_fingerprint,
      observations.boot_identity_fingerprint,
      challenges.witness_version
    FROM administrative_restart_witness_observations AS observations
    JOIN administrative_restart_witness_challenges AS challenges
      ON challenges.challenge = observations.challenge
    WHERE observations.campaign_id = ?
    ORDER BY observations.sequence
  `);
  const readPolicyAuthority = database.prepare<[], PolicyAuthorityRow>(`
    SELECT state.status, state.active_revision, state.state_version,
      revisions.definition_json
    FROM administrative_policy_state AS state
    LEFT JOIN administrative_policy_revisions AS revisions
      ON revisions.revision = state.active_revision
    WHERE state.singleton = 1
  `);
  const insertObservation = database.prepare(`
    INSERT INTO administrative_restart_witness_observations (
      campaign_id, sequence, challenge, phase, outcome, failure, observed_at,
      policy_revision, policy_state_version, execution_manifest_fingerprint,
      release_commit, service_instance_fingerprint,
      worker_service_instance_fingerprint, boot_identity_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const readLatestServiceInstance = database.prepare<
    [releaseCommit: string, service: string],
    ServiceInstanceRow
  >(`
    SELECT boot_identity_fingerprint, instance_fingerprint
    FROM administrative_restart_witness_service_instances
    WHERE release_commit = ? AND service = ?
    ORDER BY sequence DESC
    LIMIT 1
  `);
  const readAcceptedServiceInstances = database.prepare<
    [releaseCommit: string],
    AcceptedServiceInstancesRow
  >(`
    SELECT observations.service_instance_fingerprint,
      observations.worker_service_instance_fingerprint
    FROM administrative_restart_witness_observations AS observations
    JOIN administrative_restart_witness_campaigns AS campaigns
      ON campaigns.campaign_id = observations.campaign_id
    JOIN administrative_restart_witness_challenges AS challenges
      ON challenges.challenge = observations.challenge
    WHERE campaigns.release_commit = ?
      AND observations.phase = 'service-restart'
      AND observations.outcome = 'passed'
      AND challenges.witness_version = 3
      AND observations.service_instance_fingerprint IS NOT NULL
      AND observations.worker_service_instance_fingerprint IS NOT NULL
    ORDER BY observations.sequence DESC
    LIMIT 1
  `);
  const insertServiceInstance = database.prepare(`
    INSERT INTO administrative_restart_witness_service_instances (
      release_commit, service, instance_fingerprint,
      boot_identity_fingerprint, registered_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const pruneSupersededServiceInstances = database.prepare(`
    DELETE FROM administrative_restart_witness_service_instances
    WHERE sequence IN (
      SELECT sequence
      FROM administrative_restart_witness_service_instances
      WHERE release_commit = ? AND service = ?
      ORDER BY sequence DESC
      LIMIT -1 OFFSET ${maximumServiceInstancesPerReleaseAndService}
    )
  `);
  const pruneInactiveReleaseServiceInstances = database.prepare(`
    DELETE FROM administrative_restart_witness_service_instances
    WHERE release_commit != ?
  `);

  function projectCampaign(row: CampaignRow): AdministrativeRestartWitnessCampaign {
    const allObservations = readObservations.all(row.campaign_id);
    const observations = allObservations
      .slice(-maximumObservationAttempts)
      .map(projectObservation);
    const currentChallenge = readCurrentChallenge.get(row.campaign_id);
    const nextObservation =
      currentChallenge === undefined
        ? null
        : {
            challenge: currentChallenge.challenge,
            phase: currentChallenge.phase,
          };
    const currentPassedCount = allObservations.filter(
      (observation) =>
        observation.witness_version === 3 &&
        observation.outcome === "passed",
    ).length;
    const status =
      nextObservation !== null
        ? "pending"
        : currentPassedCount === orderedPhases.length
          ? "completed"
          : "migration-required";
    return administrativeRestartWitnessCampaignSchema.parse({
      campaignId: row.campaign_id,
      createdAt: row.created_at,
      nextObservation,
      observations,
      releaseCommit: row.release_commit,
      schemaVersion: 3,
      status,
    });
  }

  function projectObservation(row: ObservationRow): AdministrativeRestartWitnessObservation {
    const common = {
      observedAt: row.observed_at,
      phase: row.phase,
      provenance: "server-recorded-authenticated-api" as const,
      sequence: row.sequence,
    };
    if (row.outcome === "failed") {
      return administrativeRestartWitnessObservationSchema.parse({
        ...common,
        failure: administrativeRestartWitnessFailureReasonSchema.parse(
          row.failure,
        ) as Extract<
          AdministrativeRestartWitnessObservation,
          { readonly outcome: "failed" }
        >["failure"],
        outcome: "failed",
      });
    }
    if (
      row.policy_revision === null ||
      row.policy_state_version === null ||
      row.execution_manifest_fingerprint === null ||
      row.release_commit === null ||
      row.service_instance_fingerprint === null ||
      row.boot_identity_fingerprint === null
    ) {
      throw new Error("A passing restart observation has incomplete authority");
    }
    const legacy =
      row.witness_version < 3 ||
      row.worker_service_instance_fingerprint === null;
    const checks =
      row.phase === "baseline"
        ? { authorityCaptured: true as const }
        : row.phase === "service-restart"
          ? legacy
            ? {
                authorityUnchanged: true as const,
                bootIdentityUnchanged: true as const,
                serviceInstanceChanged: true as const,
              }
            : {
              apiServiceInstanceChanged: true as const,
              authorityUnchanged: true as const,
              bootIdentityUnchanged: true as const,
              workerServiceInstanceChanged: true as const,
            }
          : legacy
            ? {
                authorityUnchanged: true as const,
                bootIdentityChanged: true as const,
              }
            : {
              apiServiceInstanceStable: true as const,
              authorityUnchanged: true as const,
              bootIdentityChanged: true as const,
              workerServiceInstanceStable: true as const,
            };
    return administrativeRestartWitnessObservationSchema.parse({
      ...common,
      checks,
      outcome: "passed",
      policy: {
        executionManifestFingerprint: row.execution_manifest_fingerprint,
        revision: row.policy_revision,
        stateVersion: row.policy_state_version,
        status: "active",
      },
      releaseCommit: row.release_commit,
    });
  }

  const ensureCampaignTransaction = database.transaction(
    (input: Parameters<AdministrativeRestartWitnessStore["ensureCampaign"]>[0]) => {
      const campaignId = administrativeRestartWitnessCampaignIdSchema.parse(
        input.campaignId,
      );
      const createdAt = administrativeTimestampSchema.parse(input.createdAt);
      const initialChallenge = administrativeRestartWitnessChallengeSchema.parse(
        input.initialChallenge,
      );
      const releaseCommit = administrativeRestartWitnessReleaseCommitSchema.parse(
        input.releaseCommit,
      );
      const existing = findCampaignForRelease.get(releaseCommit);
      if (existing !== undefined) {
        const rows = readObservations.all(existing.campaign_id);
        const currentChallenge = readCurrentChallenge.get(existing.campaign_id);
        const currentPassed = rows.filter(
          (row) => row.witness_version === 3 && row.outcome === "passed",
        );
        if (currentChallenge === undefined && currentPassed.length === 0) {
          insertChallenge.run(
            existing.campaign_id,
            initialChallenge,
            "baseline",
            createdAt,
          );
        }
        return projectCampaign(existing);
      }
      const identityCollision = findCampaign.get(campaignId);
      if (identityCollision !== undefined) {
        throw new Error("Restart Witness campaign identity is already in use");
      }
      insertCampaign.run(campaignId, createdAt, releaseCommit);
      insertChallenge.run(campaignId, initialChallenge, "baseline", createdAt);
      return projectCampaign(requireCampaign(campaignId));
    },
  );

  function admitObservation(
    untrustedIdentity: Parameters<
      AdministrativeRestartWitnessStore["observe"]
    >[0]["identity"],
  ) {
    const identity =
      administrativeRestartWitnessObservationIdentitySchema.parse(
        untrustedIdentity,
      );
    const campaign = findCampaign.get(identity.campaignId);
    if (campaign === undefined) return denied("campaign-unavailable");
    const rows = readObservations.all(identity.campaignId);
    const currentRows = rows.filter((row) => row.witness_version === 3);
    if (currentRows.length >= maximumObservationAttempts) {
      return denied("campaign-attempt-limit");
    }
    const passedRows = currentRows.filter((row) => row.outcome === "passed");
    if (passedRows.length === orderedPhases.length) {
      return denied("campaign-completed");
    }
    const knownChallenge = readChallenge.get(
      identity.campaignId,
      identity.challenge,
    );
    if (knownChallenge === undefined) return denied("challenge-mismatch");
    if (
      challengeWasConsumed.get(identity.campaignId, identity.challenge)
        ?.consumed === 1
    ) {
      return denied("challenge-consumed");
    }
    const currentChallenge = readCurrentChallenge.get(identity.campaignId);
    if (
      currentChallenge === undefined ||
      currentChallenge.challenge !== identity.challenge
    ) {
      return denied("challenge-mismatch");
    }
    const phase = orderedPhases[passedRows.length];
    if (
      phase === undefined ||
      currentChallenge.phase !== phase ||
      identity.phase !== phase
    ) {
      return denied("phase-out-of-order");
    }
    return {
      campaign,
      decision: "admitted" as const,
      identity,
      passedRows,
      nextSequence: (rows.at(-1)?.sequence ?? 0) + 1,
      phase,
      rows,
    };
  }

  const observeTransaction = database.transaction(
    (input: Parameters<AdministrativeRestartWitnessStore["observe"]>[0]) => {
      const nextChallenge = administrativeRestartWitnessChallengeSchema.parse(
        input.nextChallenge,
      );
      const observedAt = administrativeTimestampSchema.parse(input.observedAt);
      const host = administrativeRestartWitnessHostObservationSchema.parse(
        input.observation,
      );
      const admission = admitObservation(input.identity);
      if (admission.decision === "denied") return admission;

      const authority = readPolicyAuthority.get();
      const baseline = admission.passedRows[0];
      const serviceRestart = admission.passedRows.find(
        (row) => row.phase === "service-restart",
      );
      const failure = evaluateObservation({
        authority,
        baseline,
        campaign: admission.campaign,
        host,
        phase: admission.phase,
        serviceRestart,
      });
      const sequence = admission.nextSequence;
      if (failure !== undefined) {
        insertObservation.run(
          admission.identity.campaignId,
          sequence,
          admission.identity.challenge,
          admission.phase,
          "failed",
          failure,
          observedAt,
          null,
          null,
          null,
          host.releaseCommit,
          null,
          null,
          null,
        );
        insertChallenge.run(
          admission.identity.campaignId,
          nextChallenge,
          admission.phase,
          observedAt,
        );
        return denied(failure);
      }
      if (
        authority === undefined ||
        authority.active_revision === null ||
        authority.definition_json === null
      ) {
        throw new Error("Passing Restart Witness authority is unavailable");
      }
      const revision = administrativePolicyRevisionSchema.parse(
        JSON.parse(authority.definition_json),
      );
      insertObservation.run(
        admission.identity.campaignId,
        sequence,
        admission.identity.challenge,
        admission.phase,
        "passed",
        null,
        observedAt,
        authority.active_revision,
        authority.state_version,
        administrativeExecutionManifestFingerprint(revision.executionManifest),
        host.releaseCommit,
        host.apiServiceInstanceFingerprint,
        host.workerServiceInstanceFingerprint,
        host.bootIdentityFingerprint,
      );
      const nextPhase = orderedPhases[admission.passedRows.length + 1];
      if (nextPhase !== undefined) {
        insertChallenge.run(
          admission.identity.campaignId,
          nextChallenge,
          nextPhase,
          observedAt,
        );
      }
      const inserted = readObservations
        .all(admission.identity.campaignId)
        .at(-1);
      if (inserted === undefined) {
        throw new Error("Restart Witness observation was not persisted");
      }
      return administrativeRestartWitnessObservationResponseSchema.parse({
        decision: "recorded",
        observation: projectObservation(inserted),
      });
    },
  );

  const recordHostObservationFailureTransaction = database.transaction(
    (
      input: Parameters<
        AdministrativeRestartWitnessStore["recordHostObservationFailure"]
      >[0],
    ) => {
      const nextChallenge = administrativeRestartWitnessChallengeSchema.parse(
        input.nextChallenge,
      );
      const observedAt = administrativeTimestampSchema.parse(input.observedAt);
      const admission = admitObservation(input.identity);
      if (admission.decision === "denied") return admission;
      insertObservation.run(
        admission.identity.campaignId,
        admission.nextSequence,
        admission.identity.challenge,
        admission.phase,
        "failed",
        input.failure,
        observedAt,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
      insertChallenge.run(
        admission.identity.campaignId,
        nextChallenge,
        admission.phase,
        observedAt,
      );
      return denied(input.failure);
    },
  );

  const registerServiceInstanceTransaction = database.transaction(
    (
      input: Parameters<
        AdministrativeRestartWitnessStore["registerServiceInstance"]
      >[0],
    ) => {
      const bootIdentityFingerprint =
        administrativeRestartWitnessBootIdentityFingerprintSchema.parse(
          input.bootIdentityFingerprint,
        );
      const registeredAt = administrativeTimestampSchema.parse(
        input.registeredAt,
      );
      const releaseCommit = administrativeRestartWitnessReleaseCommitSchema.parse(
        input.releaseCommit,
      );
      const service = administrativeRestartWitnessServiceSchema.parse(
        input.service,
      );
      const candidateInstanceFingerprint =
        service === "api"
          ? administrativeRestartWitnessApiServiceInstanceFingerprintSchema.parse(
              input.candidateInstanceFingerprint,
            )
          : administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema.parse(
              input.candidateInstanceFingerprint,
            );
      const previous = readLatestServiceInstance.get(releaseCommit, service);
      const accepted = readAcceptedServiceInstances.get(releaseCommit);
      const acceptedFingerprint =
        service === "api"
          ? accepted?.service_instance_fingerprint
          : accepted?.worker_service_instance_fingerprint;
      const instanceFingerprint =
        previous !== undefined &&
        previous.boot_identity_fingerprint !== bootIdentityFingerprint
          ? service === "api"
            ? administrativeRestartWitnessApiServiceInstanceFingerprintSchema.parse(
                acceptedFingerprint ?? previous.instance_fingerprint,
              )
            : administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema.parse(
                acceptedFingerprint ?? previous.instance_fingerprint,
              )
          : candidateInstanceFingerprint;
      insertServiceInstance.run(
        releaseCommit,
        service,
        instanceFingerprint,
        bootIdentityFingerprint,
        registeredAt,
      );
      pruneInactiveReleaseServiceInstances.run(releaseCommit);
      pruneSupersededServiceInstances.run(releaseCommit, service);
      return instanceFingerprint;
    },
  );

  function requireCampaign(campaignId: string): CampaignRow {
    const row = findCampaign.get(campaignId);
    if (row === undefined) throw new Error("Restart Witness campaign is unavailable");
    return row;
  }

  return {
    async close() {
      database.close();
    },
    async ensureCampaign(input) {
      return ensureCampaignTransaction.immediate(input);
    },
    async observe(input) {
      return observeTransaction.immediate(input);
    },
    async recordHostObservationFailure(input) {
      return recordHostObservationFailureTransaction.immediate(input);
    },
    async readCampaign(campaignId) {
      const parsed = administrativeRestartWitnessCampaignIdSchema.parse(campaignId);
      const row = findCampaign.get(parsed);
      return row === undefined ? undefined : projectCampaign(row);
    },
    async readCampaignForRelease(releaseCommit) {
      const parsed = administrativeRestartWitnessReleaseCommitSchema.safeParse(
        releaseCommit,
      );
      if (!parsed.success) return undefined;
      const row = findCampaignForRelease.get(parsed.data);
      return row === undefined ? undefined : projectCampaign(row);
    },
    async readServiceInstances(input) {
      const release = administrativeRestartWitnessReleaseCommitSchema.parse(
        input.releaseCommit,
      );
      const boot =
        administrativeRestartWitnessBootIdentityFingerprintSchema.parse(
          input.bootIdentityFingerprint,
        );
      const api = readLatestServiceInstance.get(release, "api");
      const worker = readLatestServiceInstance.get(release, "worker");
      return {
        ...(api?.boot_identity_fingerprint === boot
          ? {
              api: administrativeRestartWitnessApiServiceInstanceFingerprintSchema.parse(
                api.instance_fingerprint,
              ),
            }
          : {}),
        ...(worker?.boot_identity_fingerprint === boot
          ? {
              worker:
                administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema.parse(
                  worker.instance_fingerprint,
                ),
            }
          : {}),
      };
    },
    async registerServiceInstance(input) {
      return registerServiceInstanceTransaction.immediate(input);
    },
  };
}

function evaluateObservation(input: {
  readonly authority: PolicyAuthorityRow | undefined;
  readonly baseline: ObservationRow | undefined;
  readonly campaign: CampaignRow;
  readonly host: ReturnType<
    typeof administrativeRestartWitnessHostObservationSchema.parse
  >;
  readonly phase: AdministrativeRestartWitnessPhase;
  readonly serviceRestart: ObservationRow | undefined;
}): AdministrativeRestartWitnessFailureReason | undefined {
  if (
    input.authority === undefined ||
    input.authority.status !== "active" ||
    input.authority.active_revision === null ||
    input.authority.definition_json === null
  ) {
    return "policy-inactive";
  }
  if (
    input.host.releaseCommit !== input.campaign.release_commit
  ) {
    return "release-changed";
  }
  const revision = administrativePolicyRevisionSchema.safeParse(
    parseJson(input.authority.definition_json),
  );
  if (!revision.success) return "authority-changed";
  const manifestFingerprint = administrativeExecutionManifestFingerprint(
    revision.data.executionManifest,
  );
  if (input.phase === "baseline") return undefined;
  if (
    input.baseline === undefined ||
    input.baseline.policy_revision !== input.authority.active_revision ||
    input.baseline.policy_state_version !== input.authority.state_version ||
    input.baseline.execution_manifest_fingerprint !== manifestFingerprint ||
    input.baseline.release_commit !== input.host.releaseCommit ||
    input.baseline.service_instance_fingerprint === null ||
    input.baseline.worker_service_instance_fingerprint === null ||
    input.baseline.boot_identity_fingerprint === null
  ) {
    return "authority-changed";
  }
  if (input.phase === "service-restart") {
    if (
      input.baseline.service_instance_fingerprint ===
      input.host.apiServiceInstanceFingerprint
    ) {
      return "api-service-instance-unchanged";
    }
    if (
      input.baseline.worker_service_instance_fingerprint ===
      input.host.workerServiceInstanceFingerprint
    ) {
      return "worker-service-instance-unchanged";
    }
    if (
      input.baseline.boot_identity_fingerprint !==
      input.host.bootIdentityFingerprint
    ) {
      return "boot-identity-changed-during-service-restart";
    }
    return undefined;
  }
  if (
    input.serviceRestart === undefined ||
    input.serviceRestart.service_instance_fingerprint === null ||
    input.serviceRestart.worker_service_instance_fingerprint === null
  ) {
    return "authority-changed";
  }
  if (
    input.serviceRestart.service_instance_fingerprint !==
    input.host.apiServiceInstanceFingerprint
  ) {
    return "api-service-instance-changed-during-host-reboot";
  }
  if (
    input.serviceRestart.worker_service_instance_fingerprint !==
    input.host.workerServiceInstanceFingerprint
  ) {
    return "worker-service-instance-changed-during-host-reboot";
  }
  return input.baseline.boot_identity_fingerprint ===
    input.host.bootIdentityFingerprint
    ? "boot-identity-unchanged"
    : undefined;
}

function denied(
  reason: AdministrativeRestartWitnessFailureReason,
): Extract<
  AdministrativeRestartWitnessObservationResponse,
  { readonly decision: "denied" }
> {
  const response = administrativeRestartWitnessObservationResponseSchema.parse({
    decision: "denied",
    reason,
  });
  if (response.decision !== "denied") {
    throw new Error("Restart Witness denial parsing changed unexpectedly");
  }
  return response;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS administrative_restart_witness_campaigns (
      campaign_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      release_commit TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS administrative_restart_witness_challenges (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      challenge TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK (
        phase IN ('baseline', 'service-restart', 'host-reboot')
      ),
      issued_at TEXT NOT NULL,
      witness_version INTEGER NOT NULL DEFAULT 3 CHECK (
        witness_version IN (2, 3)
      ),
      FOREIGN KEY (campaign_id)
        REFERENCES administrative_restart_witness_campaigns(campaign_id)
    );

    CREATE TABLE IF NOT EXISTS administrative_restart_witness_observations (
      campaign_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      challenge TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK (
        phase IN ('baseline', 'service-restart', 'host-reboot')
      ),
      outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
      failure TEXT,
      observed_at TEXT NOT NULL,
      policy_revision INTEGER,
      policy_state_version INTEGER,
      execution_manifest_fingerprint TEXT,
      release_commit TEXT,
      service_instance_fingerprint TEXT,
      worker_service_instance_fingerprint TEXT,
      boot_identity_fingerprint TEXT,
      PRIMARY KEY (campaign_id, sequence),
      FOREIGN KEY (campaign_id)
        REFERENCES administrative_restart_witness_campaigns(campaign_id),
      FOREIGN KEY (challenge)
        REFERENCES administrative_restart_witness_challenges(challenge),
      CHECK (
        (outcome = 'failed' AND failure IS NOT NULL AND
          policy_revision IS NULL AND policy_state_version IS NULL AND
          execution_manifest_fingerprint IS NULL) OR
        (outcome = 'passed' AND failure IS NULL AND
          policy_revision IS NOT NULL AND policy_state_version IS NOT NULL AND
          execution_manifest_fingerprint IS NOT NULL AND
          release_commit IS NOT NULL AND
          service_instance_fingerprint IS NOT NULL AND
          worker_service_instance_fingerprint IS NOT NULL AND
          boot_identity_fingerprint IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS administrative_restart_witness_service_instances (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      release_commit TEXT NOT NULL,
      service TEXT NOT NULL CHECK (service IN ('api', 'worker')),
      instance_fingerprint TEXT NOT NULL,
      boot_identity_fingerprint TEXT NOT NULL,
      registered_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS administrative_restart_campaigns_no_update
    BEFORE UPDATE ON administrative_restart_witness_campaigns
    BEGIN
      SELECT RAISE(ABORT, 'Restart Witness campaigns are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_restart_campaigns_no_delete
    BEFORE DELETE ON administrative_restart_witness_campaigns
    BEGIN
      SELECT RAISE(ABORT, 'Restart Witness campaigns are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_restart_challenges_no_update
    BEFORE UPDATE ON administrative_restart_witness_challenges
    BEGIN
      SELECT RAISE(ABORT, 'Restart Witness challenges are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_restart_challenges_no_delete
    BEFORE DELETE ON administrative_restart_witness_challenges
    BEGIN
      SELECT RAISE(ABORT, 'Restart Witness challenges are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_restart_observations_no_update
    BEFORE UPDATE ON administrative_restart_witness_observations
    BEGIN
      SELECT RAISE(ABORT, 'Restart Witness observations are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_restart_observations_no_delete
    BEFORE DELETE ON administrative_restart_witness_observations
    BEGIN
      SELECT RAISE(ABORT, 'Restart Witness observations are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS administrative_restart_service_instances_no_update
    BEFORE UPDATE ON administrative_restart_witness_service_instances
    BEGIN
      SELECT RAISE(ABORT, 'Restart Witness service instances are immutable');
    END;

    DROP TRIGGER IF EXISTS administrative_restart_service_instances_no_delete;
    DROP TRIGGER IF EXISTS administrative_restart_service_instances_retention_delete_only;

    CREATE TRIGGER administrative_restart_service_instances_retention_delete_only
    BEFORE DELETE ON administrative_restart_witness_service_instances
    WHEN (
      OLD.release_commit = (
        SELECT latest.release_commit
        FROM administrative_restart_witness_service_instances AS latest
        ORDER BY latest.sequence DESC
        LIMIT 1
      )
      AND (
        SELECT COUNT(*)
        FROM administrative_restart_witness_service_instances AS newer
        WHERE newer.release_commit = OLD.release_commit
          AND newer.service = OLD.service
          AND newer.sequence > OLD.sequence
      ) < ${maximumServiceInstancesPerReleaseAndService}
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'Restart Witness current service instances are retained'
      );
    END;
  `);
  const observationColumns = database
    .prepare("PRAGMA table_info(administrative_restart_witness_observations)")
    .all() as ReadonlyArray<{ readonly name: string }>;
  if (
    !observationColumns.some(
      ({ name }) => name === "worker_service_instance_fingerprint",
    )
  ) {
    database.exec(`
      ALTER TABLE administrative_restart_witness_observations
      ADD COLUMN worker_service_instance_fingerprint TEXT
    `);
  }
  const challengeColumns = database
    .prepare("PRAGMA table_info(administrative_restart_witness_challenges)")
    .all() as ReadonlyArray<{ readonly name: string }>;
  if (!challengeColumns.some(({ name }) => name === "witness_version")) {
    // Existing challenges are V2 evidence: they never observed the worker.
    database.exec(`
      ALTER TABLE administrative_restart_witness_challenges
      ADD COLUMN witness_version INTEGER NOT NULL DEFAULT 2
    `);
  }
}
