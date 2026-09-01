import Database from "better-sqlite3";

import {
  administrativeExecutionManifestFingerprint,
  administrativePolicyRevisionSchema,
  administrativeRestartWitnessCampaignIdSchema,
  administrativeRestartWitnessCampaignSchema,
  administrativeRestartWitnessChallengeSchema,
  administrativeRestartWitnessFailureReasonSchema,
  administrativeRestartWitnessHostObservationSchema,
  administrativeRestartWitnessObservationIdentitySchema,
  administrativeRestartWitnessObservationSchema,
  administrativeRestartWitnessObservationResponseSchema,
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
}

interface ObservationRow {
  readonly boot_identity: string | null;
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
  readonly service_instance_id: string | null;
}

interface PolicyAuthorityRow {
  readonly active_revision: number | null;
  readonly definition_json: string | null;
  readonly state_version: number;
  readonly status: "active" | "inactive" | "suspended";
}

const releaseCommitPattern = /^[0-9a-f]{40}$/u;
const maximumObservationAttempts = 100;
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
      campaign_id, challenge, phase, issued_at
    ) VALUES (?, ?, ?, ?)
  `);
  const readCurrentChallenge = database.prepare<
    [campaignId: string],
    ChallengeRow
  >(`
    SELECT challenges.challenge, challenges.phase
    FROM administrative_restart_witness_challenges AS challenges
    LEFT JOIN administrative_restart_witness_observations AS observations
      ON observations.challenge = challenges.challenge
    WHERE challenges.campaign_id = ? AND observations.challenge IS NULL
    ORDER BY challenges.sequence DESC
    LIMIT 1
  `);
  const readChallenge = database.prepare<
    [campaignId: string, challenge: string],
    ChallengeRow
  >(`
    SELECT challenge, phase
    FROM administrative_restart_witness_challenges
    WHERE campaign_id = ? AND challenge = ?
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
    SELECT sequence, challenge, phase, outcome, failure, observed_at,
      policy_revision, policy_state_version, execution_manifest_fingerprint,
      release_commit, service_instance_id, boot_identity
    FROM administrative_restart_witness_observations
    WHERE campaign_id = ?
    ORDER BY sequence
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
      release_commit, service_instance_id, boot_identity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function projectCampaign(row: CampaignRow): AdministrativeRestartWitnessCampaign {
    const observations = readObservations
      .all(row.campaign_id)
      .map(projectObservation);
    const nextObservation = readCurrentChallenge.get(row.campaign_id) ?? null;
    return administrativeRestartWitnessCampaignSchema.parse({
      campaignId: row.campaign_id,
      createdAt: row.created_at,
      nextObservation,
      observations,
      releaseCommit: row.release_commit,
      schemaVersion: 2,
      status: nextObservation === null ? "completed" : "pending",
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
      row.service_instance_id === null ||
      row.boot_identity === null
    ) {
      throw new Error("A passing restart observation has incomplete authority");
    }
    const checks =
      row.phase === "baseline"
        ? { authorityCaptured: true as const }
        : row.phase === "service-restart"
          ? {
              authorityUnchanged: true as const,
              bootIdentityUnchanged: true as const,
              serviceInstanceChanged: true as const,
            }
          : {
              authorityUnchanged: true as const,
              bootIdentityChanged: true as const,
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
      if (!releaseCommitPattern.test(input.releaseCommit)) {
        throw new Error("Restart Witness Release commit is invalid");
      }
      const existing = findCampaignForRelease.get(input.releaseCommit);
      if (existing !== undefined) return projectCampaign(existing);
      const identityCollision = findCampaign.get(campaignId);
      if (identityCollision !== undefined) {
        throw new Error("Restart Witness campaign identity is already in use");
      }
      insertCampaign.run(campaignId, createdAt, input.releaseCommit);
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
    if (rows.length >= maximumObservationAttempts) {
      return denied("campaign-attempt-limit");
    }
    const passedRows = rows.filter((row) => row.outcome === "passed");
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
      const failure = evaluateObservation({
        authority,
        baseline,
        campaign: admission.campaign,
        host,
        phase: admission.phase,
      });
      const sequence = admission.rows.length + 1;
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
          host.serviceInstanceId,
          host.bootIdentity,
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
        host.serviceInstanceId,
        host.bootIdentity,
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
        admission.rows.length + 1,
        admission.identity.challenge,
        admission.phase,
        "failed",
        "host-observation-unavailable",
        observedAt,
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
      return denied("host-observation-unavailable");
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
      if (!releaseCommitPattern.test(releaseCommit)) return undefined;
      const row = findCampaignForRelease.get(releaseCommit);
      return row === undefined ? undefined : projectCampaign(row);
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
    input.baseline.service_instance_id === null ||
    input.baseline.boot_identity === null
  ) {
    return "authority-changed";
  }
  if (input.phase === "service-restart") {
    if (input.baseline.service_instance_id === input.host.serviceInstanceId) {
      return "service-instance-unchanged";
    }
    if (input.baseline.boot_identity !== input.host.bootIdentity) {
      return "boot-identity-changed-during-service-restart";
    }
    return undefined;
  }
  return input.baseline.boot_identity === input.host.bootIdentity
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
      service_instance_id TEXT,
      boot_identity TEXT,
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
          release_commit IS NOT NULL AND service_instance_id IS NOT NULL AND
          boot_identity IS NOT NULL)
      )
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
  `);
}
