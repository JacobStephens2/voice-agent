import { createHmac, timingSafeEqual } from "node:crypto";

import Database from "better-sqlite3";

import type {
  FixtureCodebaseRegistration,
  FixtureDeploymentContract,
  FixtureGitHubEvent,
  PromotionEffectProjection,
  PromotionEvidenceEventProjection,
  PromotionEvidenceRecordProjection,
} from "@voice-agent/contracts";
import { renderPromotionTaskPage } from "@voice-agent/pwa/server";

export type { FixtureGitHubEvent } from "@voice-agent/contracts";

const fixtureApplicationId = "fixture-production" as const;
const fixtureRepository = "JacobStephens2/fixture-application" as const;
const trustedSessionToken = "scenario-trusted-session";
const commitPattern = /^[0-9a-f]{40}$/u;

export interface HumanMergePromotionScenarioOptions {
  readonly databasePath: string;
  readonly healthStatusByCommit?: Readonly<Record<string, number>> | undefined;
  readonly ids: readonly string[];
  readonly now: string;
  readonly processLossAfterEffect?:
    | PromotionEffectProjection["kind"]
    | undefined;
  readonly webhookSecret: string;
}

export interface PromotionDeliveryResult {
  readonly outcome: "accepted" | "denied" | "duplicate";
  readonly record: PromotionEvidenceRecordProjection;
}

export interface HumanMergePromotionInspection {
  readonly activeRelease?: PromotionEvidenceRecordProjection["promotion"]["release"];
  readonly attempts: readonly NonNullable<
    PromotionEvidenceRecordProjection["promotion"]["attempt"]
  >[];
  readonly effects: readonly PromotionEffectProjection[];
}

export interface HumanMergePromotionScenario {
  activateContract(input: {
    readonly activatedBy: "fresh-passkey-action";
    readonly buildCommand: string;
    readonly health: FixtureDeploymentContract["health"];
    readonly preflightCommand: string;
    readonly releaseRoot: string;
    readonly revision: number;
  }): Promise<FixtureDeploymentContract>;
  close(): Promise<void>;
  deliver(input: {
    readonly deliveryId: string;
    readonly event: FixtureGitHubEvent;
    readonly signature: string;
  }): Promise<PromotionDeliveryResult>;
  getActiveContract(): Promise<FixtureDeploymentContract>;
  getRecord(taskId: string): Promise<PromotionEvidenceRecordProjection | undefined>;
  getRegistration(): Promise<FixtureCodebaseRegistration>;
  inspect(): Promise<HumanMergePromotionInspection>;
  processNext(): Promise<PromotionEvidenceRecordProjection | undefined>;
  reconcile(
    events: readonly FixtureGitHubEvent[],
  ): Promise<readonly PromotionDeliveryResult[]>;
  readTaskPage(taskId: string, sessionToken?: string): Promise<{
    readonly body: PromotionEvidenceRecordProjection | { readonly error: string };
    readonly html: string;
    readonly statusCode: number;
  }>;
}

interface RecordRow {
  readonly circuit_state: "closed" | "half-open" | "open";
  readonly conclusion: string;
  readonly consecutive_failures: number;
  readonly contract_json: string | null;
  readonly created_at: string;
  readonly denial_reason: string | null;
  readonly id: string;
  readonly merge_json: string;
  readonly question: string;
  readonly rollback_json: string;
  readonly status: "completed" | "denied" | "pending" | "running";
  readonly updated_at: string;
}

interface AttemptRow {
  readonly contract_json: string;
  readonly id: string;
  readonly merge_commit: string;
  readonly previous_release_json: string | null;
  readonly queue_sequence: number;
  readonly record_id: string;
  readonly release_json: string | null;
  readonly rollback_json: string;
  readonly status: "queued" | "rolled-back" | "running" | "succeeded";
  readonly verification_json: string | null;
}

interface EvidenceRow {
  readonly details_json: string;
  readonly id: string;
  readonly kind: PromotionEvidenceEventProjection["kind"];
  readonly occurred_at: string;
  readonly sequence: number;
  readonly summary: string;
}

interface PromotionStore {
  readonly database: Database.Database;
  activateContract(contract: FixtureDeploymentContract): FixtureDeploymentContract;
  activateInitialPolicy(now: string): void;
  appendEvidence(
    recordId: string,
    eventId: string,
    kind: PromotionEvidenceEventProjection["kind"],
    occurredAt: string,
    summary: string,
    details: PromotionEvidenceEventProjection["details"],
  ): void;
  claimNext(now: string): AttemptRow | undefined;
  completeHealthy(input: {
    readonly attemptId: string;
    readonly now: string;
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
    readonly verification: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["verification"]
    >;
  }): PromotionEvidenceRecordProjection;
  completeUnhealthy(input: {
    readonly attemptId: string;
    readonly now: string;
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
    readonly verification: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["verification"]
    >;
  }): PromotionEvidenceRecordProjection;
  findActiveContract(): FixtureDeploymentContract;
  findRecord(taskId: string): PromotionEvidenceRecordProjection | undefined;
  findRegistration(): FixtureCodebaseRegistration;
  hasAttempt(commit: string): boolean;
  hasDelivery(deliveryId: string): boolean;
  inspect(): HumanMergePromotionInspection;
  performEffect(input: {
    readonly actualHealthStatus: number;
    readonly attempt: AttemptRow;
    readonly contract: FixtureDeploymentContract;
    readonly kind: PromotionEffectProjection["kind"];
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
  }): PromotionEffectProjection;
  persistAccepted(input: {
    readonly attemptId: string;
    readonly contract: FixtureDeploymentContract;
    readonly deliveryId: string;
    readonly event: FixtureGitHubEvent;
    readonly now: string;
    readonly source: "reconciliation" | "webhook";
    readonly taskId: string;
  }): PromotionEvidenceRecordProjection;
  persistDenied(input: {
    readonly authenticated: boolean;
    readonly deliveryId: string;
    readonly duplicate: boolean;
    readonly event: FixtureGitHubEvent;
    readonly now: string;
    readonly reason: string;
    readonly taskId: string;
  }): PromotionEvidenceRecordProjection;
}

export async function createHumanMergePromotionScenario(
  options: HumanMergePromotionScenarioOptions,
): Promise<HumanMergePromotionScenario> {
  const ids = [...options.ids];
  const store = createPromotionStore(options.databasePath);
  store.activateInitialPolicy(options.now);
  let processLossAfterEffect = options.processLossAfterEffect;

  function nextId(label: string): string {
    const id = ids.shift();
    if (id === undefined) {
      throw new Error(`The scenario exhausted its deterministic ${label} identifiers`);
    }
    return id;
  }

  function simulateProcessLossAfter(kind: PromotionEffectProjection["kind"]): void {
    if (processLossAfterEffect !== kind) return;
    processLossAfterEffect = undefined;
    throw new Error(`Simulated process loss after ${kind}`);
  }

  return {
    async activateContract(input) {
      const contract: FixtureDeploymentContract = {
        activatedAt: options.now,
        activatedBy: input.activatedBy,
        applicationId: fixtureApplicationId,
        buildCommand: input.buildCommand,
        health: input.health,
        preflightCommand: input.preflightCommand,
        releaseRoot: input.releaseRoot,
        revision: input.revision,
        source: "voice-agent-policy",
      };
      return store.activateContract(contract);
    },
    async close() {
      store.database.close();
    },
    async deliver(input) {
      const taskId = nextId("Durable Task");
      if (!isAuthenticatedDelivery(options.webhookSecret, input)) {
        return {
          outcome: "denied",
          record: store.persistDenied({
            authenticated: false,
            deliveryId: input.deliveryId,
            duplicate: false,
            event: input.event,
            now: options.now,
            reason: "invalid-signature",
            taskId,
          }),
        };
      }
      if (store.hasDelivery(input.deliveryId)) {
        return {
          outcome: "duplicate",
          record: store.persistDenied({
            authenticated: true,
            deliveryId: input.deliveryId,
            duplicate: true,
            event: input.event,
            now: options.now,
            reason: "duplicate-delivery",
            taskId,
          }),
        };
      }
      const denialReason = findHumanMergeDenial(input.event);
      if (denialReason !== undefined) {
        return {
          outcome: "denied",
          record: store.persistDenied({
            authenticated: true,
            deliveryId: input.deliveryId,
            duplicate: false,
            event: input.event,
            now: options.now,
            reason: denialReason,
            taskId,
          }),
        };
      }
      const contract = store.findActiveContract();
      const attemptId = nextId("Promotion Attempt");
      return {
        outcome: "accepted",
        record: store.persistAccepted({
          attemptId,
          contract,
          deliveryId: input.deliveryId,
          event: input.event,
          now: options.now,
          source: "webhook",
          taskId,
        }),
      };
    },
    async getActiveContract() {
      return store.findActiveContract();
    },
    async getRecord(taskId) {
      return store.findRecord(taskId);
    },
    async getRegistration() {
      return store.findRegistration();
    },
    async inspect() {
      return store.inspect();
    },
    async processNext() {
      const attempt = store.claimNext(options.now);
      if (attempt === undefined) return undefined;
      const contract = parseJson<FixtureDeploymentContract>(attempt.contract_json);
      const release = {
        commit: attempt.merge_commit,
        id: `${fixtureApplicationId}-${attempt.merge_commit}`,
        path: `${contract.releaseRoot}/${fixtureApplicationId}-${attempt.merge_commit}`,
      };
      const actualHealthStatus =
        options.healthStatusByCommit?.[attempt.merge_commit] ??
        contract.health.expectedStatus;

      const build = store.performEffect({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.build",
        release,
      });
      simulateProcessLossAfter(build.kind);
      store.appendEvidence(
        attempt.record_id,
        `${build.operationId}:evidence`,
        "release.built",
        options.now,
        `Immutable Release ${release.id} built from ${attempt.merge_commit}.`,
        {
          commit: attempt.merge_commit,
          releaseId: release.id,
          releasePath: release.path,
        },
      );

      const preflight = store.performEffect({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.preflight",
        release,
      });
      simulateProcessLossAfter(preflight.kind);
      store.appendEvidence(
        attempt.record_id,
        `${preflight.operationId}:evidence`,
        "release.preflighted",
        options.now,
        `Deployment Contract preflight passed for ${release.id}.`,
        { command: contract.preflightCommand, outcome: "passed" },
      );

      const switched = store.performEffect({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.switch",
        release,
      });
      simulateProcessLossAfter(switched.kind);
      store.appendEvidence(
        attempt.record_id,
        `${switched.operationId}:evidence`,
        "release.switched",
        options.now,
        `Production switched atomically to ${release.id}.`,
        { releaseId: release.id },
      );

      const verified = store.performEffect({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.verify",
        release,
      });
      simulateProcessLossAfter(verified.kind);
      const verification = {
        actualStatus: verified.actualStatus ?? actualHealthStatus,
        expectedStatus: contract.health.expectedStatus,
        outcome:
          actualHealthStatus === contract.health.expectedStatus
            ? ("healthy" as const)
            : ("unhealthy" as const),
        path: contract.health.path,
      };
      store.appendEvidence(
        attempt.record_id,
        `${verified.operationId}:evidence`,
        "release.verified",
        options.now,
        `Release verification was ${verification.outcome}.`,
        {
          actualStatus: verification.actualStatus,
          expectedStatus: verification.expectedStatus,
          outcome: verification.outcome,
          path: verification.path,
        },
      );
      if (verification.outcome !== "healthy") {
        const rollback = store.performEffect({
          actualHealthStatus,
          attempt,
          contract,
          kind: "release.rollback",
          release,
        });
        simulateProcessLossAfter(rollback.kind);
        store.appendEvidence(
          attempt.record_id,
          `${rollback.operationId}:evidence`,
          "release.rolled-back",
          options.now,
          rollback.restoredReleaseId === undefined
            ? `Unhealthy Release ${release.id} was removed; no prior Release existed.`
            : `Unhealthy Release ${release.id} was replaced by ${rollback.restoredReleaseId}.`,
          {
            attemptedReleaseId: release.id,
            restoredReleaseId: rollback.restoredReleaseId ?? null,
          },
        );
        return store.completeUnhealthy({
          attemptId: attempt.id,
          now: options.now,
          release,
          verification,
        });
      }
      return store.completeHealthy({
        attemptId: attempt.id,
        now: options.now,
        release,
        verification,
      });
    },
    async reconcile(events) {
      const discovered: PromotionDeliveryResult[] = [];
      for (const event of events) {
        if (
          findHumanMergeDenial(event) !== undefined ||
          store.hasAttempt(event.commit)
        ) {
          continue;
        }
        const taskId = nextId("Durable Task");
        const attemptId = nextId("Promotion Attempt");
        discovered.push({
          outcome: "accepted",
          record: store.persistAccepted({
            attemptId,
            contract: store.findActiveContract(),
            deliveryId: `reconciliation:${event.commit}`,
            event,
            now: options.now,
            source: "reconciliation",
            taskId,
          }),
        });
      }
      return discovered;
    },
    async readTaskPage(taskId, sessionToken) {
      if (sessionToken !== trustedSessionToken) {
        return {
          body: { error: "Authentication required" },
          html: "",
          statusCode: 401,
        };
      }
      const record = store.findRecord(taskId);
      if (record === undefined) {
        return {
          body: { error: "Evidence Record not found" },
          html: "",
          statusCode: 404,
        };
      }
      return {
        body: record,
        html: renderPromotionTaskPage(record),
        statusCode: 200,
      };
    },
  };
}

export function signHumanMergeWebhook(
  secret: string,
  event: FixtureGitHubEvent,
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(JSON.stringify(event))
    .digest("hex")}`;
}

function createPromotionStore(databasePath: string): PromotionStore {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createPromotionSchema(database);

  function findRegistration(): FixtureCodebaseRegistration {
    const row = database
      .prepare("SELECT definition_json FROM promotion_registrations LIMIT 1")
      .get() as { readonly definition_json: string } | undefined;
    if (row === undefined) throw new Error("Fixture Registered Codebase is unavailable");
    return parseJson<FixtureCodebaseRegistration>(row.definition_json);
  }

  function findActiveContract(): FixtureDeploymentContract {
    const row = database
      .prepare(`
        SELECT promotion_contracts.definition_json
        FROM promotion_active_contracts
        JOIN promotion_contracts
          ON promotion_contracts.application_id = promotion_active_contracts.application_id
          AND promotion_contracts.revision = promotion_active_contracts.revision
        WHERE promotion_active_contracts.application_id = ?
      `)
      .get(fixtureApplicationId) as { readonly definition_json: string } | undefined;
    if (row === undefined) throw new Error("Active Deployment Contract is unavailable");
    return parseJson<FixtureDeploymentContract>(row.definition_json);
  }

  function findAttemptByRecord(recordId: string): AttemptRow | undefined {
    return database
      .prepare(`
        SELECT id, record_id, merge_commit, queue_sequence, status,
          contract_json, release_json, verification_json, rollback_json,
          previous_release_json
        FROM promotion_attempts
        WHERE record_id = ?
      `)
      .get(recordId) as AttemptRow | undefined;
  }

  function findAttempt(attemptId: string): AttemptRow {
    const attempt = database
      .prepare(`
        SELECT id, record_id, merge_commit, queue_sequence, status,
          contract_json, release_json, verification_json, rollback_json,
          previous_release_json
        FROM promotion_attempts
        WHERE id = ?
      `)
      .get(attemptId) as AttemptRow | undefined;
    if (attempt === undefined) throw new Error("Promotion Attempt is unavailable");
    return attempt;
  }

  function findRecord(taskId: string): PromotionEvidenceRecordProjection | undefined {
    const row = database
      .prepare(`
        SELECT id, status, question, conclusion, created_at, updated_at,
          merge_json, contract_json, denial_reason, rollback_json,
          circuit_state, consecutive_failures
        FROM promotion_records
        WHERE id = ?
      `)
      .get(taskId) as RecordRow | undefined;
    if (row === undefined) return undefined;
    const attempt = findAttemptByRecord(taskId);
    const evidence = database
      .prepare(`
        SELECT id, sequence, kind, occurred_at, summary, details_json
        FROM promotion_evidence_events
        WHERE record_id = ?
        ORDER BY sequence
      `)
      .all(taskId) as EvidenceRow[];
    const merge = parseJson<
      PromotionEvidenceRecordProjection["promotion"]["merge"]
    >(row.merge_json);
    const contract =
      row.contract_json === null
        ? undefined
        : parseJson<FixtureDeploymentContract>(row.contract_json);
    const release =
      attempt?.release_json === null || attempt?.release_json === undefined
        ? undefined
        : parseJson<
            NonNullable<PromotionEvidenceRecordProjection["promotion"]["release"]>
          >(attempt.release_json);
    const verification =
      attempt?.verification_json === null ||
      attempt?.verification_json === undefined
        ? undefined
        : parseJson<
            NonNullable<
              PromotionEvidenceRecordProjection["promotion"]["verification"]
            >
          >(attempt.verification_json);
    const rollback = parseJson<
      PromotionEvidenceRecordProjection["promotion"]["rollback"]
    >(attempt?.rollback_json ?? row.rollback_json);
    return {
      evidence: evidence.map((event) => ({
        details: parseJson<PromotionEvidenceEventProjection["details"]>(
          event.details_json,
        ),
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurred_at,
        sequence: event.sequence,
        summary: event.summary,
      })),
      promotion: {
        ...(attempt === undefined
          ? {}
          : {
              attempt: {
                id: attempt.id,
                mergeCommit: attempt.merge_commit,
                queueSequence: attempt.queue_sequence,
                status: attempt.status,
              },
            }),
        circuit: {
          consecutiveFailures: row.consecutive_failures,
          state: row.circuit_state,
        },
        ...(contract === undefined
          ? {}
          : {
              contract: {
                activatedAt: contract.activatedAt,
                revision: contract.revision,
                source: contract.source,
              },
            }),
        ...(row.denial_reason === null ? {} : { denialReason: row.denial_reason }),
        merge,
        ...(release === undefined ? {} : { release }),
        rollback,
        ...(verification === undefined ? {} : { verification }),
      },
      task: {
        conclusion: row.conclusion,
        createdAt: row.created_at,
        id: row.id,
        kind: "human-merge.promotion",
        question: row.question,
        status: row.status,
        updatedAt: row.updated_at,
      },
    };
  }

  function appendEvidence(
    recordId: string,
    eventId: string,
    kind: PromotionEvidenceEventProjection["kind"],
    occurredAt: string,
    summary: string,
    details: PromotionEvidenceEventProjection["details"],
  ): void {
    const next = database
      .prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM promotion_evidence_events
        WHERE record_id = ?
      `)
      .get(recordId) as { readonly sequence: number };
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_evidence_events (
          id, record_id, sequence, kind, occurred_at, summary, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        recordId,
        next.sequence,
        kind,
        occurredAt,
        summary,
        JSON.stringify(details),
      );
  }

  function hasDelivery(deliveryId: string): boolean {
    return (
      database
        .prepare(`
          SELECT 1
          FROM promotion_delivery_identities
          WHERE delivery_id = ?
        `)
        .get(deliveryId) !== undefined
    );
  }

  function hasAttempt(commit: string): boolean {
    return (
      database
        .prepare(`
          SELECT 1
          FROM promotion_attempts
          WHERE application_id = ? AND merge_commit = ?
        `)
        .get(fixtureApplicationId, commit) !== undefined
    );
  }

  function activateInitialPolicy(now: string): void {
    const registration: FixtureCodebaseRegistration = {
      applicationId: fixtureApplicationId,
      liveCheckoutPath: "/fixture/live",
      productionBranch: "main",
      registeredAt: now,
      repository: fixtureRepository,
      sourceCheckoutRoot: "/fixture/source",
    };
    const contract: FixtureDeploymentContract = {
      activatedAt: now,
      activatedBy: "fresh-passkey-action",
      applicationId: fixtureApplicationId,
      buildCommand: "pnpm build",
      health: { expectedStatus: 204, path: "/health" },
      preflightCommand: "pnpm test --run",
      releaseRoot: "/fixture/releases",
      revision: 1,
      source: "voice-agent-policy",
    };
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_registrations (
          application_id, definition_json
        ) VALUES (?, ?)
      `)
      .run(fixtureApplicationId, JSON.stringify(registration));
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_contracts (
          application_id, revision, active, definition_json
        ) VALUES (?, ?, 1, ?)
      `)
      .run(fixtureApplicationId, contract.revision, JSON.stringify(contract));
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_active_contracts (
          application_id, revision
        ) VALUES (?, ?)
      `)
      .run(fixtureApplicationId, contract.revision);
    database
      .prepare(`
        INSERT OR IGNORE INTO promotion_application_state (
          application_id, active_release_json, consecutive_failures, circuit_state
        ) VALUES (?, NULL, 0, 'closed')
      `)
      .run(fixtureApplicationId);
  }

  const activateContractTransaction = database.transaction(
    (contract: FixtureDeploymentContract): FixtureDeploymentContract => {
      const existing = database
        .prepare(`
          SELECT 1
          FROM promotion_contracts
          WHERE application_id = ? AND revision = ?
        `)
        .get(contract.applicationId, contract.revision);
      if (existing !== undefined) {
        throw new Error(
          `Deployment Contract revision ${contract.revision} already exists`,
        );
      }
      const active = findActiveContract();
      if (!Number.isInteger(contract.revision) || contract.revision <= active.revision) {
        throw new Error("Deployment Contract revisions must increase");
      }
      const registration = findRegistration();
      if (
        contract.releaseRoot === registration.liveCheckoutPath ||
        contract.releaseRoot.startsWith(`${registration.liveCheckoutPath}/`) ||
        !contract.releaseRoot.startsWith("/fixture/releases")
      ) {
        throw new Error("Deployment Contract Release root is outside policy");
      }
      database
        .prepare(`
          INSERT INTO promotion_contracts (
            application_id, revision, active, definition_json
          ) VALUES (?, ?, 0, ?)
        `)
        .run(
          contract.applicationId,
          contract.revision,
          JSON.stringify(contract),
        );
      database
        .prepare(`
          INSERT INTO promotion_active_contracts (application_id, revision)
          VALUES (?, ?)
          ON CONFLICT(application_id) DO UPDATE SET revision = excluded.revision
        `)
        .run(contract.applicationId, contract.revision);
      return findActiveContract();
    },
  );

  const persistAcceptedTransaction = database.transaction(
    (input: {
      readonly attemptId: string;
      readonly contract: FixtureDeploymentContract;
      readonly deliveryId: string;
      readonly event: FixtureGitHubEvent;
      readonly now: string;
      readonly source: "reconciliation" | "webhook";
      readonly taskId: string;
    }): PromotionEvidenceRecordProjection => {
      const applicationState = database
        .prepare(`
          SELECT consecutive_failures, circuit_state
          FROM promotion_application_state
          WHERE application_id = ?
        `)
        .get(fixtureApplicationId) as {
        readonly circuit_state: "closed" | "half-open" | "open";
        readonly consecutive_failures: number;
      };
      const sequence = database
        .prepare(`
          SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS sequence
          FROM promotion_attempts
        `)
        .get() as { readonly sequence: number };
      const merge: PromotionEvidenceRecordProjection["promotion"]["merge"] = {
        actor: input.event.mergedBy?.login ?? "unknown",
        beforeCommit: input.event.beforeCommit,
        branch: input.event.branch,
        commit: input.event.commit,
        deliveryId: input.deliveryId,
        repository: input.event.repository,
        source: input.source,
      };
      database
        .prepare(`
          INSERT INTO promotion_records (
            id, status, question, conclusion, created_at, updated_at,
            merge_json, contract_json, denial_reason, rollback_json,
            circuit_state, consecutive_failures
          ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `)
        .run(
          input.taskId,
          `Promote ${input.event.repository}@${input.event.commit}`,
          `Promotion for ${input.event.commit} is queued.`,
          input.now,
          input.now,
          JSON.stringify(merge),
          JSON.stringify(input.contract),
          JSON.stringify({ performed: false }),
          applicationState.circuit_state,
          applicationState.consecutive_failures,
        );
      database
        .prepare(`
          INSERT INTO promotion_delivery_identities (
            delivery_id, record_id, received_at
          ) VALUES (?, ?, ?)
        `)
        .run(input.deliveryId, input.taskId, input.now);
      database
        .prepare(`
          INSERT INTO promotion_attempts (
            id, record_id, application_id, merge_commit, queue_sequence,
            status, contract_json, release_json, verification_json, rollback_json
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?)
        `)
        .run(
          input.attemptId,
          input.taskId,
          fixtureApplicationId,
          input.event.commit,
          sequence.sequence,
          JSON.stringify(input.contract),
          JSON.stringify({ performed: false }),
        );
      appendEvidence(
        input.taskId,
        `${input.taskId}:merge`,
        input.source === "reconciliation"
          ? "reconciliation.discovered"
          : "merge.accepted",
        input.now,
        input.source === "reconciliation"
          ? `Reconciliation discovered missed Human Merge ${input.event.commit}.`
          : `Authenticated Human Merge ${input.event.commit} accepted.`,
        {
          actor: input.event.mergedBy?.login ?? "unknown",
          beforeCommit: input.event.beforeCommit,
          commit: input.event.commit,
          deliveryId: input.deliveryId,
        },
      );
      appendEvidence(
        input.taskId,
        `${input.taskId}:queued`,
        "promotion.queued",
        input.now,
        `Promotion Attempt ${input.attemptId} queued without coalescing.`,
        {
          attemptId: input.attemptId,
          contractRevision: input.contract.revision,
          queueSequence: sequence.sequence,
        },
      );
      return requireRecord(findRecord(input.taskId));
    },
  );

  const persistDeniedTransaction = database.transaction(
    (input: {
      readonly authenticated: boolean;
      readonly deliveryId: string;
      readonly duplicate: boolean;
      readonly event: FixtureGitHubEvent;
      readonly now: string;
      readonly reason: string;
      readonly taskId: string;
    }): PromotionEvidenceRecordProjection => {
      const applicationState = database
        .prepare(`
          SELECT consecutive_failures, circuit_state
          FROM promotion_application_state
          WHERE application_id = ?
        `)
        .get(fixtureApplicationId) as {
        readonly circuit_state: "closed" | "half-open" | "open";
        readonly consecutive_failures: number;
      };
      const merge: PromotionEvidenceRecordProjection["promotion"]["merge"] = {
        actor: input.event.mergedBy?.login ?? "unknown",
        beforeCommit: input.event.beforeCommit,
        branch: input.event.branch,
        commit: input.event.commit,
        deliveryId: input.deliveryId,
        repository: input.event.repository,
        source: "webhook",
      };
      database
        .prepare(`
          INSERT INTO promotion_records (
            id, status, question, conclusion, created_at, updated_at,
            merge_json, contract_json, denial_reason, rollback_json,
            circuit_state, consecutive_failures
          ) VALUES (?, 'denied', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `)
        .run(
          input.taskId,
          `Evaluate GitHub delivery ${input.deliveryId}`,
          `GitHub delivery denied: ${input.reason}.`,
          input.now,
          input.now,
          JSON.stringify(merge),
          input.reason,
          JSON.stringify({ performed: false }),
          applicationState.circuit_state,
          applicationState.consecutive_failures,
        );
      if (input.authenticated && !input.duplicate) {
        database
          .prepare(`
            INSERT INTO promotion_delivery_identities (
              delivery_id, record_id, received_at
            ) VALUES (?, ?, ?)
          `)
          .run(input.deliveryId, input.taskId, input.now);
      }
      appendEvidence(
        input.taskId,
        `${input.taskId}:denied`,
        input.duplicate ? "delivery.duplicate" : "delivery.denied",
        input.now,
        input.duplicate
          ? `Duplicate delivery ${input.deliveryId} ignored.`
          : `GitHub delivery denied: ${input.reason}.`,
        {
          authenticated: input.authenticated,
          deliveryId: input.deliveryId,
          reason: input.reason,
        },
      );
      return requireRecord(findRecord(input.taskId));
    },
  );

  function claimNext(now: string): AttemptRow | undefined {
    const running = database
      .prepare(`
        SELECT id, record_id, merge_commit, queue_sequence, status,
          contract_json, release_json, verification_json, rollback_json,
          previous_release_json
        FROM promotion_attempts
        WHERE status = 'running'
        ORDER BY queue_sequence
        LIMIT 1
      `)
      .get() as AttemptRow | undefined;
    if (running !== undefined) return running;
    const applicationState = database
      .prepare(`
        SELECT circuit_state
        FROM promotion_application_state
        WHERE application_id = ?
      `)
      .get(fixtureApplicationId) as {
      readonly circuit_state: "closed" | "half-open" | "open";
    };
    if (applicationState.circuit_state === "half-open") return undefined;
    const attempt = database
      .prepare(`
        SELECT id, record_id, merge_commit, queue_sequence, status,
          contract_json, release_json, verification_json, rollback_json,
          previous_release_json
        FROM promotion_attempts
        WHERE status = 'queued'
        ORDER BY queue_sequence
        LIMIT 1
      `)
      .get() as AttemptRow | undefined;
    if (attempt === undefined) return undefined;
    if (applicationState.circuit_state === "open") {
      database
        .prepare(`
          UPDATE promotion_application_state
          SET circuit_state = 'half-open'
          WHERE application_id = ?
        `)
        .run(fixtureApplicationId);
      database
        .prepare(`
          UPDATE promotion_records
          SET circuit_state = 'half-open'
          WHERE id = ?
        `)
        .run(attempt.record_id);
      appendEvidence(
        attempt.record_id,
        `${attempt.id}:circuit-half-open`,
        "circuit.changed",
        now,
        "Deployment Circuit Breaker entered half-open for one recovery attempt.",
        { state: "half-open" },
      );
    }
    database
      .prepare("UPDATE promotion_attempts SET status = 'running' WHERE id = ?")
      .run(attempt.id);
    database
      .prepare(`
        UPDATE promotion_records
        SET status = 'running', conclusion = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(`Promotion for ${attempt.merge_commit} is running.`, now, attempt.record_id);
    return findAttempt(attempt.id);
  }

  function performEffect(input: {
    readonly actualHealthStatus: number;
    readonly attempt: AttemptRow;
    readonly contract: FixtureDeploymentContract;
    readonly kind: PromotionEffectProjection["kind"];
    readonly release: NonNullable<
      PromotionEvidenceRecordProjection["promotion"]["release"]
    >;
  }): PromotionEffectProjection {
    const operationId = `${input.attempt.id}:${input.kind}`;
    const existing = database
      .prepare("SELECT effect_json FROM promotion_effects WHERE operation_id = ?")
      .get(operationId) as { readonly effect_json: string } | undefined;
    if (existing !== undefined) {
      return parseJson<PromotionEffectProjection>(existing.effect_json);
    }
    const effect: PromotionEffectProjection =
      input.kind === "release.build"
        ? {
            kind: input.kind,
            operationId,
            outcome: "completed",
            releasePath: input.release.path,
            sourcePath: `/fixture/source/${input.attempt.merge_commit}`,
          }
        : input.kind === "release.preflight"
          ? {
              command: input.contract.preflightCommand,
              kind: input.kind,
              operationId,
              outcome: "passed",
            }
          : input.kind === "release.verify"
            ? {
                actualStatus: input.actualHealthStatus,
                kind: input.kind,
                operationId,
                outcome:
                  input.actualHealthStatus === input.contract.health.expectedStatus
                    ? "healthy"
                    : "unhealthy",
              }
            : input.kind === "release.rollback"
              ? {
                  kind: input.kind,
                  operationId,
                  outcome: "completed",
                  ...(findAttempt(input.attempt.id).previous_release_json === null
                    ? {}
                    : {
                        restoredReleaseId: parseJson<
                          NonNullable<
                            PromotionEvidenceRecordProjection["promotion"]["release"]
                          >
                        >(
                          findAttempt(input.attempt.id).previous_release_json ??
                            "null",
                        ).id,
                      }),
                }
            : {
                kind: input.kind,
                operationId,
                outcome: "completed",
              };
    const persist = database.transaction(() => {
      if (input.kind === "release.switch") {
        const environment = database
          .prepare(`
            SELECT active_release_json
            FROM promotion_environment
            WHERE application_id = ?
          `)
          .get(fixtureApplicationId) as {
          readonly active_release_json: string | null;
        };
        database
          .prepare(`
            UPDATE promotion_attempts
            SET previous_release_json = ?
            WHERE id = ? AND previous_release_json IS NULL
          `)
          .run(environment.active_release_json, input.attempt.id);
        database
          .prepare(`
            UPDATE promotion_environment
            SET active_release_json = ?
            WHERE application_id = ?
          `)
          .run(JSON.stringify(input.release), fixtureApplicationId);
      } else if (input.kind === "release.rollback") {
        const currentAttempt = findAttempt(input.attempt.id);
        database
          .prepare(`
            UPDATE promotion_environment
            SET active_release_json = ?
            WHERE application_id = ?
          `)
          .run(currentAttempt.previous_release_json, fixtureApplicationId);
      }
      database
        .prepare(`
          INSERT INTO promotion_effects (
            operation_id, attempt_id, kind, effect_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(operationId, input.attempt.id, input.kind, JSON.stringify(effect));
    });
    persist.immediate();
    return effect;
  }

  const completeHealthyTransaction = database.transaction(
    (input: {
      readonly attemptId: string;
      readonly now: string;
      readonly release: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["release"]
      >;
      readonly verification: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["verification"]
      >;
    }): PromotionEvidenceRecordProjection => {
      const attempt = findAttempt(input.attemptId);
      const previousCircuit = database
        .prepare(`
          SELECT circuit_state
          FROM promotion_application_state
          WHERE application_id = ?
        `)
        .get(fixtureApplicationId) as {
        readonly circuit_state: "closed" | "half-open" | "open";
      };
      database
        .prepare(`
          UPDATE promotion_attempts
          SET status = 'succeeded', release_json = ?, verification_json = ?
          WHERE id = ?
        `)
        .run(JSON.stringify(input.release), JSON.stringify(input.verification), input.attemptId);
      database
        .prepare(`
          UPDATE promotion_application_state
          SET active_release_json = ?, consecutive_failures = 0,
            circuit_state = 'closed'
          WHERE application_id = ?
        `)
        .run(JSON.stringify(input.release), fixtureApplicationId);
      database
        .prepare(`
          UPDATE promotion_records
          SET status = 'completed', conclusion = ?, updated_at = ?,
            circuit_state = 'closed', consecutive_failures = 0
          WHERE id = ?
        `)
        .run(
          `Release ${attempt.merge_commit} is active and healthy.`,
          input.now,
          attempt.record_id,
        );
      if (previousCircuit.circuit_state !== "closed") {
        appendEvidence(
          attempt.record_id,
          `${attempt.id}:circuit-closed`,
          "circuit.changed",
          input.now,
          "Healthy verification closed the Deployment Circuit Breaker.",
          { state: "closed" },
        );
      }
      return requireRecord(findRecord(attempt.record_id));
    },
  );

  const completeUnhealthyTransaction = database.transaction(
    (input: {
      readonly attemptId: string;
      readonly now: string;
      readonly release: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["release"]
      >;
      readonly verification: NonNullable<
        PromotionEvidenceRecordProjection["promotion"]["verification"]
      >;
    }): PromotionEvidenceRecordProjection => {
      const attempt = findAttempt(input.attemptId);
      const applicationState = database
        .prepare(`
          SELECT consecutive_failures, circuit_state
          FROM promotion_application_state
          WHERE application_id = ?
        `)
        .get(fixtureApplicationId) as {
        readonly circuit_state: "closed" | "half-open" | "open";
        readonly consecutive_failures: number;
      };
      const consecutiveFailures = applicationState.consecutive_failures + 1;
      const circuitState = consecutiveFailures >= 3 ? "open" : "closed";
      const restoredRelease =
        attempt.previous_release_json === null
          ? undefined
          : parseJson<
              NonNullable<
                PromotionEvidenceRecordProjection["promotion"]["release"]
              >
            >(attempt.previous_release_json);
      const rollback: PromotionEvidenceRecordProjection["promotion"]["rollback"] = {
        attemptedReleaseId: input.release.id,
        performed: true,
        ...(restoredRelease === undefined
          ? {}
          : { restoredReleaseId: restoredRelease.id }),
      };
      database
        .prepare(`
          UPDATE promotion_attempts
          SET status = 'rolled-back', release_json = ?, verification_json = ?,
            rollback_json = ?
          WHERE id = ?
        `)
        .run(
          JSON.stringify(input.release),
          JSON.stringify(input.verification),
          JSON.stringify(rollback),
          input.attemptId,
        );
      database
        .prepare(`
          UPDATE promotion_application_state
          SET active_release_json = ?, consecutive_failures = ?,
            circuit_state = ?
          WHERE application_id = ?
        `)
        .run(
          attempt.previous_release_json,
          consecutiveFailures,
          circuitState,
          fixtureApplicationId,
        );
      const conclusion =
        restoredRelease === undefined
          ? `Release ${attempt.merge_commit} was unhealthy; no prior Release was available.`
          : `Release ${attempt.merge_commit} was unhealthy; ${restoredRelease.id} was restored.`;
      database
        .prepare(`
          UPDATE promotion_records
          SET status = 'completed', conclusion = ?, updated_at = ?,
            circuit_state = ?, consecutive_failures = ?, rollback_json = ?
          WHERE id = ?
        `)
        .run(
          conclusion,
          input.now,
          circuitState,
          consecutiveFailures,
          JSON.stringify(rollback),
          attempt.record_id,
        );
      if (circuitState === "open") {
        appendEvidence(
          attempt.record_id,
          `${attempt.id}:circuit-open`,
          "circuit.changed",
          input.now,
          applicationState.circuit_state === "half-open"
            ? "The failed half-open attempt reopened the Deployment Circuit Breaker."
            : "Three consecutive failures opened the Deployment Circuit Breaker.",
          { consecutiveFailures, state: "open" },
        );
      }
      return requireRecord(findRecord(attempt.record_id));
    },
  );

  function inspect(): HumanMergePromotionInspection {
    const environment = database
      .prepare(`
        SELECT active_release_json
        FROM promotion_environment
        WHERE application_id = ?
      `)
      .get(fixtureApplicationId) as {
      readonly active_release_json: string | null;
    };
    const effects = database
      .prepare("SELECT effect_json FROM promotion_effects ORDER BY rowid")
      .all() as Array<{ readonly effect_json: string }>;
    const attempts = database
      .prepare(`
        SELECT id, merge_commit, queue_sequence, status
        FROM promotion_attempts
        ORDER BY queue_sequence
      `)
      .all() as Array<{
      readonly id: string;
      readonly merge_commit: string;
      readonly queue_sequence: number;
      readonly status: AttemptRow["status"];
    }>;
    return {
      ...(environment.active_release_json === null
        ? {}
        : {
            activeRelease: parseJson<
              NonNullable<
                PromotionEvidenceRecordProjection["promotion"]["release"]
              >
            >(environment.active_release_json),
          }),
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        mergeCommit: attempt.merge_commit,
        queueSequence: attempt.queue_sequence,
        status: attempt.status,
      })),
      effects: effects.map((effect) =>
        parseJson<PromotionEffectProjection>(effect.effect_json),
      ),
    };
  }

  return {
    activateContract(contract) {
      return activateContractTransaction.immediate(contract);
    },
    activateInitialPolicy,
    appendEvidence,
    claimNext,
    completeHealthy(input) {
      return completeHealthyTransaction.immediate(input);
    },
    completeUnhealthy(input) {
      return completeUnhealthyTransaction.immediate(input);
    },
    database,
    findActiveContract,
    findRecord,
    findRegistration,
    hasAttempt,
    hasDelivery,
    inspect,
    performEffect,
    persistAccepted(input) {
      return persistAcceptedTransaction.immediate(input);
    },
    persistDenied(input) {
      return persistDeniedTransaction.immediate(input);
    },
  };
}

function createPromotionSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS promotion_registrations (
      application_id TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_contracts (
      application_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      definition_json TEXT NOT NULL,
      PRIMARY KEY (application_id, revision)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_promotion_contract
    ON promotion_contracts(application_id)
    WHERE active = 1;

    CREATE TABLE IF NOT EXISTS promotion_active_contracts (
      application_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      FOREIGN KEY (application_id, revision)
        REFERENCES promotion_contracts(application_id, revision)
    );

    CREATE TABLE IF NOT EXISTS promotion_records (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      merge_json TEXT NOT NULL,
      contract_json TEXT,
      denial_reason TEXT,
      rollback_json TEXT NOT NULL,
      circuit_state TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_delivery_identities (
      delivery_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES promotion_records(id),
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_attempts (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL UNIQUE REFERENCES promotion_records(id),
      application_id TEXT NOT NULL,
      merge_commit TEXT NOT NULL,
      queue_sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      release_json TEXT,
      verification_json TEXT,
      rollback_json TEXT NOT NULL,
      previous_release_json TEXT,
      UNIQUE (application_id, merge_commit)
    );

    CREATE TABLE IF NOT EXISTS promotion_evidence_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES promotion_records(id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      UNIQUE (record_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS promotion_effects (
      operation_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES promotion_attempts(id),
      kind TEXT NOT NULL,
      effect_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_application_state (
      application_id TEXT PRIMARY KEY,
      active_release_json TEXT,
      consecutive_failures INTEGER NOT NULL,
      circuit_state TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotion_environment (
      application_id TEXT PRIMARY KEY,
      active_release_json TEXT
    );

    INSERT OR IGNORE INTO promotion_environment (
      application_id, active_release_json
    ) VALUES ('fixture-production', NULL);

    CREATE TRIGGER IF NOT EXISTS promotion_contracts_no_update
    BEFORE UPDATE ON promotion_contracts
    BEGIN
      SELECT RAISE(ABORT, 'Deployment Contract revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_contracts_no_delete
    BEFORE DELETE ON promotion_contracts
    BEGIN
      SELECT RAISE(ABORT, 'Deployment Contract revisions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_evidence_no_update
    BEFORE UPDATE ON promotion_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Promotion Evidence Events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_evidence_no_delete
    BEFORE DELETE ON promotion_evidence_events
    BEGIN
      SELECT RAISE(ABORT, 'Promotion Evidence Events are append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_effects_no_update
    BEFORE UPDATE ON promotion_effects
    BEGIN
      SELECT RAISE(ABORT, 'External Promotion effects are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS promotion_effects_no_delete
    BEFORE DELETE ON promotion_effects
    BEGIN
      SELECT RAISE(ABORT, 'External Promotion effects are immutable');
    END;
  `);
}

function isAuthenticatedDelivery(
  secret: string,
  input: {
    readonly event: FixtureGitHubEvent;
    readonly signature: string;
  },
): boolean {
  const expected = signHumanMergeWebhook(secret, input.event);
  const actualBuffer = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expected);
  return !(
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function findHumanMergeDenial(event: FixtureGitHubEvent): string | undefined {
  if (event.event === "push") return "direct-push";
  if (event.repository !== fixtureRepository) return "wrong-repository";
  if (event.branch !== "main") return "wrong-branch";
  if (
    event.action !== "closed" ||
    !event.merged ||
    event.mergedBy?.type !== "User" ||
    !commitPattern.test(event.commit) ||
    !commitPattern.test(event.beforeCommit)
  ) {
    return "non-human-merge";
  }
  return undefined;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function requireRecord(
  record: PromotionEvidenceRecordProjection | undefined,
): PromotionEvidenceRecordProjection {
  if (record === undefined) throw new Error("Promotion Evidence Record is unavailable");
  return record;
}
