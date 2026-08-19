import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  FixtureCodebaseRegistration,
  FixtureDeploymentContract,
  FixtureGitHubEvent,
  PromotionOperationProjection,
  PromotionEvidenceRecordProjection,
} from "@voice-agent/contracts";
import { fixtureDeploymentContractSchema } from "@voice-agent/contracts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import { renderEvidenceRecordPage } from "@voice-agent/pwa/server";
import {
  createPromotionStore,
  fixturePromotionCodebase,
  type PromotionCodebase,
  type PromotionStoreInspection,
} from "./human-merge-promotion-store.ts";

export type { FixtureGitHubEvent } from "@voice-agent/contracts";

const trustedSessionToken = "scenario-trusted-session";
const commitPattern = /^[0-9a-f]{40}$/u;

export interface HumanMergePromotionScenarioOptions {
  /** The Registered Codebase this Promotion queue serves. */
  readonly codebase?: PromotionCodebase | undefined;
  readonly contractActivationAuthority?:
    | {
        hasFreshPasskeyAction(sessionToken: string): Promise<boolean>;
      }
    | undefined;
  readonly databasePath: string;
  readonly healthStatusByCommit?: Readonly<Record<string, number>> | undefined;
  readonly ids: readonly string[];
  readonly now: string;
  readonly processLossAfterOperation?:
    | PromotionOperationProjection["kind"]
    | undefined;
  /** Seed Deployment Contract revision 1 from the codebase descriptor. */
  readonly seedDeploymentContract?: boolean | undefined;
  readonly webhookSecret: string;
}

export interface PromotionDeliveryResult {
  readonly outcome: "accepted" | "denied" | "duplicate";
  readonly record: PromotionEvidenceRecordProjection;
}

export type HumanMergePromotionInspection = PromotionStoreInspection;

export interface HumanMergePromotionScenario {
  activateContract(input: {
    readonly buildCommand: string;
    readonly health: FixtureDeploymentContract["health"];
    readonly preflightCommand: string;
    readonly releaseRoot: string;
    readonly revision: number;
    readonly sessionToken: string;
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

export async function createHumanMergePromotionScenario(
  options: HumanMergePromotionScenarioOptions,
): Promise<HumanMergePromotionScenario> {
  const ids = [...options.ids];
  const codebase = options.codebase ?? fixturePromotionCodebase;
  const store = createPromotionStore(options.databasePath, codebase);
  store.activateInitialPolicy(options.now, {
    seedContract: options.seedDeploymentContract !== false,
  });
  const api = createTaskApi({
    authentication: {
      async canViewEvidence(sessionToken) {
        return sessionToken === trustedSessionToken;
      },
    },
    records: {
      async getEvidenceRecord(taskId) {
        return store.findRecord(taskId);
      },
    },
  });
  let processLossAfterOperation = options.processLossAfterOperation;

  function nextId(label: string): string {
    const id = ids.shift();
    if (id === undefined) {
      throw new Error(`The scenario exhausted its deterministic ${label} identifiers`);
    }
    return id;
  }

  function simulateProcessLossAfterOperation(kind: PromotionOperationProjection["kind"]): void {
    if (processLossAfterOperation !== kind) return;
    processLossAfterOperation = undefined;
    throw new Error(`Simulated process loss after ${kind}`);
  }

  return {
    async activateContract(input) {
      if (
        options.contractActivationAuthority === undefined ||
        !(await options.contractActivationAuthority.hasFreshPasskeyAction(
          input.sessionToken,
        ))
      ) {
        throw new Error("Fresh Passkey Action required");
      }
      const contract: FixtureDeploymentContract = {
        activatedAt: options.now,
        activatedBy: "fresh-passkey-action",
        applicationId: codebase.applicationId,
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
      await api.close();
      store.close();
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
      const denialReason = findHumanMergeDenial(codebase, input.event);
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
      const contract = fixtureDeploymentContractSchema.parse(
        JSON.parse(attempt.contract_json),
      );
      const release = {
        commit: attempt.merge_commit,
        id: `${codebase.applicationId}-${attempt.merge_commit}`,
        path: `${contract.releaseRoot}/${codebase.applicationId}-${attempt.merge_commit}`,
      };
      const actualHealthStatus =
        options.healthStatusByCommit?.[attempt.merge_commit] ??
        contract.health.expectedStatus;

      const build = store.performOperation({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.build",
        release,
      });
      simulateProcessLossAfterOperation(build.kind);
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

      const preflight = store.performOperation({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.preflight",
        release,
      });
      simulateProcessLossAfterOperation(preflight.kind);
      store.appendEvidence(
        attempt.record_id,
        `${preflight.operationId}:evidence`,
        "release.preflighted",
        options.now,
        `Deployment Contract preflight passed for ${release.id}.`,
        { command: contract.preflightCommand, outcome: "passed" },
      );

      const switched = store.performOperation({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.switch",
        release,
      });
      simulateProcessLossAfterOperation(switched.kind);
      store.appendEvidence(
        attempt.record_id,
        `${switched.operationId}:evidence`,
        "release.switched",
        options.now,
        `Production switched atomically to ${release.id}.`,
        { releaseId: release.id },
      );

      const verified = store.performOperation({
        actualHealthStatus,
        attempt,
        contract,
        kind: "release.verify",
        release,
      });
      simulateProcessLossAfterOperation(verified.kind);
      if (verified.outcome !== "healthy" && verified.outcome !== "unhealthy") {
        throw new Error("Persisted Release verification outcome is invalid");
      }
      const verification = {
        actualStatus: verified.actualStatus ?? actualHealthStatus,
        expectedStatus: contract.health.expectedStatus,
        outcome: verified.outcome,
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
        const rollback = store.performOperation({
          actualHealthStatus,
          attempt,
          contract,
          kind: "release.rollback",
          release,
        });
        simulateProcessLossAfterOperation(rollback.kind);
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
      const eligibleEvents = orderHumanMerges(
        events.filter(
          (event) => findHumanMergeDenial(codebase, event) === undefined,
        ),
      );
      for (const event of eligibleEvents) {
        if (store.hasAttempt(event.commit)) continue;
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
      store.reorderQueuedAttempts(options.now);
      return discovered.map((result) => ({
        ...result,
        record: requirePromotionRecord(
          store.findRecord(result.record.task.id),
        ),
      }));
    },
    async readTaskPage(taskId, sessionToken) {
      const request = {
        method: "GET",
        url: `/api/tasks/${encodeURIComponent(taskId)}`,
      } as const;
      const response = await api.inject(
        sessionToken === undefined
          ? request
          : {
              ...request,
              headers: {
                cookie: `${trustedSessionCookieName}=${sessionToken}`,
              },
            },
      );
      const body = response.json<
        PromotionEvidenceRecordProjection | { readonly error: string }
      >();
      return {
        body,
        html:
          response.statusCode === 200
            ? renderEvidenceRecordPage(body as PromotionEvidenceRecordProjection)
            : "",
        statusCode: response.statusCode,
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

function findHumanMergeDenial(
  codebase: PromotionCodebase,
  event: FixtureGitHubEvent,
): string | undefined {
  if (event.event === "push") return "direct-push";
  if (event.repository !== codebase.repository) return "wrong-repository";
  if (event.branch !== codebase.productionBranch) return "wrong-branch";
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

function orderHumanMerges(
  events: readonly FixtureGitHubEvent[],
): readonly FixtureGitHubEvent[] {
  const uniqueByCommit = new Map<string, FixtureGitHubEvent>();
  for (const event of events) uniqueByCommit.set(event.commit, event);
  const remaining = [...uniqueByCommit.values()];
  const ordered: FixtureGitHubEvent[] = [];
  while (remaining.length > 0) {
    const remainingCommits = new Set(remaining.map((event) => event.commit));
    const nextIndex = remaining.findIndex(
      (event) => !remainingCommits.has(event.beforeCommit),
    );
    if (nextIndex === -1) {
      throw new Error("Reconciliation history is not an ordered merge chain");
    }
    const [next] = remaining.splice(nextIndex, 1);
    if (next !== undefined) ordered.push(next);
  }
  return ordered;
}

function requirePromotionRecord(
  record: PromotionEvidenceRecordProjection | undefined,
): PromotionEvidenceRecordProjection {
  if (record === undefined) {
    throw new Error("Promotion Evidence Record is unavailable");
  }
  return record;
}
