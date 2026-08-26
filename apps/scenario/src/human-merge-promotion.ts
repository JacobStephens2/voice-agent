import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CallAdmissionRecord,
  FixtureCodebaseRegistration,
  FixtureDeploymentContract,
  FixtureGitHubEvent,
  PromotionOperationProjection,
  PromotionEvidenceRecordProjection,
  SelfPromotionVerification,
  SelfPromotionVerificationCheck,
} from "@voice-agent/contracts";
import {
  fixtureDeploymentContractSchema,
  selfPromotionVerificationChecks,
} from "@voice-agent/contracts";
import { createSelfPromotionRuntime } from "@voice-agent/runtime";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import { renderEvidenceRecordPage } from "@voice-agent/pwa/server";
import {
  createPromotionStore,
  fixturePromotionCodebase,
  type PromotionCodebase,
  type PromotionStoreInspection,
} from "./human-merge-promotion-store.ts";
import {
  createSelfPromotionWorld,
  type SelfPromotionWorld,
} from "./self-promotion-world.ts";

export type { FixtureGitHubEvent } from "@voice-agent/contracts";

const trustedSessionToken = "scenario-trusted-session";
const authorityDriftAction =
  "./ops/upgrade-agent-host-deployment-authority.sh" as const;
const commitPattern = /^[0-9a-f]{40}$/u;

export interface HumanMergePromotionScenarioOptions {
  /**
   * The Deployment Authority Drift the Agent Host would observe for a Release,
   * by commit: the pinned-relative paths whose reviewed content the pinned,
   * root-owned authority is not yet running. Automatic Promotion never applies
   * these, so the host reports them and leaves them to the attended upgrade.
   */
  readonly authorityDriftByCommit?:
    | Readonly<Record<string, readonly string[]>>
    | undefined;
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
  /**
   * Promote into the runtime performing the Promotion. Present only for the
   * Voice Agent's own Registered Codebase.
   */
  readonly selfPromotion?: SelfPromotionScenarioOptions | undefined;
  readonly webhookSecret: string;
}

export interface SelfPromotionScenarioOptions {
  /**
   * Readings a commit's Release fails after the switch, by check. Each is an
   * independent reading of the switched runtime, so a Release whose health path
   * answers can still be refused by, say, a durable store it cannot read.
   */
  readonly failedChecksByCommit?:
    | Readonly<Record<string, readonly SelfPromotionVerificationCheck[]>>
    | undefined;
  /**
   * Overrides the safe-point bound the Deployment Contract declares, so a
   * scenario need not spend the enrolled number of observations.
   */
  readonly maximumSafePointObservations?: number | undefined;
  /**
   * Invoked between safe-point observations, in place of waiting on a clock. A
   * scenario advances its world here — ending a call, settling an Operation —
   * so the Promotion observes exactly what the Agent Host would.
   */
  readonly onSafePointWait?: (() => Promise<void>) | undefined;
}

export interface PromotionDeliveryResult {
  readonly outcome: "accepted" | "denied" | "duplicate";
  readonly record: PromotionEvidenceRecordProjection;
}

export type HumanMergePromotionInspection = PromotionStoreInspection;

export interface HumanMergePromotionScenario {
  /**
   * The live runtime a Self-Promotion waits for. Absent unless the scenario
   * promotes the Voice Agent's own Registered Codebase.
   */
  readonly world?: SelfPromotionWorld;
  readCallAdmission(): Promise<CallAdmissionRecord | undefined>;
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
  const selfPromotionOptions = options.selfPromotion;
  const world =
    selfPromotionOptions === undefined
      ? undefined
      : createSelfPromotionWorld({
          databasePath: options.databasePath,
          now: () => options.now,
        });
  const selfPromotion =
    world === undefined
      ? undefined
      : createSelfPromotionRuntime({
          // A scenario advances its own world between observations instead of
          // spending wall-clock time.
          delay: async () => {
            await selfPromotionOptions?.onSafePointWait?.();
          },
          now: () => options.now,
          store: world.store,
        });

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
      await world?.close();
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
    async readCallAdmission() {
      return world?.readCallAdmission();
    },
    ...(world === undefined ? {} : { world }),
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

      /**
       * Report what the Release left serving carries that the pinned,
       * root-owned deployment authority is not running. It is observed against
       * the Release actually serving when the attempt settles — the promoted
       * one, or the prior one a rollback restored — because that is the
       * question an owner is asking. Drift settles nothing: the attempt's
       * result and the Deployment Circuit Breaker are decided before this runs
       * and never read it.
       */
      const observeAuthorityDrift = (activeCommit: string | undefined) => {
        const paths =
          activeCommit === undefined
            ? []
            : (options.authorityDriftByCommit?.[activeCommit] ?? []);
        if (paths.length === 0) {
          store.recordAuthorityDrift({
            attemptId: attempt.id,
            drift: { diverged: false, paths: [] },
          });
          return;
        }
        store.recordAuthorityDrift({
          attemptId: attempt.id,
          drift: { action: authorityDriftAction, diverged: true, paths: [...paths] },
        });
        store.appendEvidence(
          attempt.record_id,
          `${attempt.id}:authority-drift`,
          "authority.drift-observed",
          options.now,
          `Release ${activeCommit} diverges from the pinned deployment authority at ${paths.join(
            ", ",
          )}; the attended ${authorityDriftAction} applies it.`,
          { action: authorityDriftAction, paths: paths.join(" ") },
        );
      };

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

      // The Release exists and has passed preflight before anything about the
      // running system changes. Only now does a Self-Promotion begin closing
      // Call Admission, so a wait for a live call never happens behind a build
      // that might have failed anyway.
      let safePointDeadlineExceeded = false;
      if (selfPromotion !== undefined) {
        await selfPromotion.pauseCallAdmission({
          commit: attempt.merge_commit,
          promotionId: attempt.id,
        });
        store.recordSelfPromotion({
          admission: { state: "paused" },
          attemptId: attempt.id,
        });
        store.appendEvidence(
          attempt.record_id,
          `${attempt.id}:admission-paused`,
          "admission.paused",
          options.now,
          "Call Admission closed for Self-Promotion; new Telephone Sessions are refused.",
          { commit: attempt.merge_commit, reason: "self-promotion" },
        );
        // The enrolled contract declares the bound; a scenario may shorten it.
        const maximumObservations =
          selfPromotionOptions?.maximumSafePointObservations ??
          contract.selfPromotion?.safePointObservations;
        const safePoint = await selfPromotion.awaitSafePoint({
          ...(maximumObservations === undefined ? {} : { maximumObservations }),
        });
        const resumable = await selfPromotion.readResumableWork();
        store.recordSelfPromotion({ attemptId: attempt.id, safePoint });
        store.appendEvidence(
          attempt.record_id,
          `${attempt.id}:work-disposed`,
          "work.disposed",
          options.now,
          `Active work at the safe point: ${safePoint.activeTelephoneSessionsAtRequest} Telephone Session(s) allowed to end, ${safePoint.warmTelephoneSessionsAtRequest} reserved session(s) allowed to clear, ${safePoint.nonInterruptibleOperationsAtRequest} non-interruptible Operation(s) allowed to settle, ${resumable.length} resumable Operation(s) carried across the switch.`,
          {
            activeTelephoneSessions: safePoint.activeTelephoneSessionsAtRequest,
            endedForPromotion: safePoint.endedForPromotion,
            nonInterruptibleOperations:
              safePoint.nonInterruptibleOperationsAtRequest,
            resumableOperations: resumable.length,
            warmTelephoneSessions: safePoint.warmTelephoneSessionsAtRequest,
          },
        );
        const safePointOperation = store.performOperation({
          actualHealthStatus,
          attempt,
          contract,
          kind: "release.safe-point",
          release,
        });
        simulateProcessLossAfterOperation(safePointOperation.kind);
        store.appendEvidence(
          attempt.record_id,
          `${safePointOperation.operationId}:evidence`,
          "safe-point.reached",
          options.now,
          `Promotion Safe Point ${safePoint.disposition} after ${safePoint.observations} observation(s).`,
          {
            disposition: safePoint.disposition,
            observations: safePoint.observations,
          },
        );
        safePointDeadlineExceeded = safePoint.disposition === "deadline-exceeded";
      }
      if (safePointDeadlineExceeded && selfPromotion !== undefined) {
        // Nothing switched, so the prior Release is still the active one and
        // there was never anything to restore. It still has to be confirmed
        // healthy in its own right before the gate reopens — "untouched" is not
        // the same reading as "healthy".
        const active = store.findActiveRelease();
        const activeHealthy =
          active !== undefined &&
          (options.healthStatusByCommit?.[active.commit] ??
            contract.health.expectedStatus) === contract.health.expectedStatus;
        if (activeHealthy) {
          await selfPromotion.reopenCallAdmission();
          store.recordSelfPromotion({
            admission: {
              reopenedAfter: "abandoned-before-switch",
              state: "open",
            },
            attemptId: attempt.id,
          });
          store.appendEvidence(
            attempt.record_id,
            `${attempt.id}:admission-reopened`,
            "admission.reopened",
            options.now,
            `Call Admission reopened against unchanged Release ${active.id}; the Promotion never switched.`,
            { reopenedAfter: "abandoned-before-switch" },
          );
        }
        // Nothing switched, so the Release still serving is the prior one, and
        // what it carries that the pinned authority is not running is as true
        // here as on any other settle path. Skipping the observation would make
        // "no drift" and "nobody looked" read the same.
        observeAuthorityDrift(store.findActiveRelease()?.commit);
        return store.completeUnhealthy({
          attemptId: attempt.id,
          now: options.now,
          release,
          rollbackPerformed: false,
        });
      }
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
      // A Self-Promotion reads more than the contract's health path: the
      // switch replaced the runtime taking the reading, so it also proves the
      // services restarted, the worker is ready, the new Release can read the
      // durable store the old one wrote, and this attempt still owns the
      // closed admission gate it is about to reopen.
      let selfVerification: SelfPromotionVerification | undefined;
      if (selfPromotion !== undefined) {
        const admission = await selfPromotion.readCallAdmission();
        const healthy = verification.outcome === "healthy";
        const active = store.findActiveRelease();
        const failed =
          selfPromotionOptions?.failedChecksByCommit?.[attempt.merge_commit] ??
          [];
        const passes = (
          check: SelfPromotionVerificationCheck,
          reading: boolean,
        ) => reading && !failed.includes(check);
        const outcomes: Readonly<
          Record<SelfPromotionVerificationCheck, boolean>
        > = {
          "api-health": passes("api-health", healthy),
          "atomic-switch": passes("atomic-switch", active?.id === release.id),
          // The gate is still held by this Promotion Attempt, so reopening it
          // readmits Telephone Sessions against the Release just verified.
          "call-admission": passes(
            "call-admission",
            admission.state === "paused" &&
              admission.promotionId === attempt.id,
          ),
          "durable-store-compatibility": passes(
            "durable-store-compatibility",
            true,
          ),
          "public-health": passes("public-health", healthy),
          "service-restart": passes("service-restart", healthy),
          "worker-readiness": passes("worker-readiness", healthy),
        };
        selfVerification = {
          checks: selfPromotionVerificationChecks.map((check) => ({
            check,
            outcome: outcomes[check] ? ("passed" as const) : ("failed" as const),
          })),
          outcome: selfPromotionVerificationChecks.every(
            (check) => outcomes[check],
          )
            ? ("healthy" as const)
            : ("unhealthy" as const),
        };
        store.recordSelfPromotion({ attemptId: attempt.id, selfVerification });
        store.appendEvidence(
          attempt.record_id,
          `${attempt.id}:self-verified`,
          "release.verified",
          options.now,
          `Self-Promotion runtime verification was ${selfVerification.outcome}.`,
          Object.fromEntries(
            selfVerification.checks.map((check) => [check.check, check.outcome]),
          ),
        );
      }
      const promotionHealthy =
        verification.outcome === "healthy" &&
        (selfVerification === undefined || selfVerification.outcome === "healthy");
      if (!promotionHealthy) {
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
        if (selfPromotion !== undefined) {
          // Admission reopens only against a runtime confirmed healthy. If the
          // restored Release cannot be confirmed either, the gate stays closed
          // rather than readmitting callers to a runtime nobody has verified.
          const restored = store.findPreviousRelease(attempt.id);
          const restoredHealthy =
            restored !== undefined &&
            (options.healthStatusByCommit?.[restored.commit] ??
              contract.health.expectedStatus) === contract.health.expectedStatus;
          if (restoredHealthy) {
            await selfPromotion.reopenCallAdmission();
            store.recordSelfPromotion({
              admission: { reopenedAfter: "rollback-verified", state: "open" },
              attemptId: attempt.id,
            });
            store.appendEvidence(
              attempt.record_id,
              `${attempt.id}:admission-reopened`,
              "admission.reopened",
              options.now,
              `Call Admission reopened after ${rollback.restoredReleaseId ?? "the prior Release"} was restored and confirmed healthy.`,
              { reopenedAfter: "rollback-verified" },
            );
          }
        }
        observeAuthorityDrift(store.findActiveRelease()?.commit);
        return store.completeUnhealthy({
          attemptId: attempt.id,
          now: options.now,
          release,
          verification,
        });
      }
      if (selfPromotion !== undefined) {
        await selfPromotion.reopenCallAdmission();
        store.recordSelfPromotion({
          admission: { reopenedAfter: "verified", state: "open" },
          attemptId: attempt.id,
        });
        store.appendEvidence(
          attempt.record_id,
          `${attempt.id}:admission-reopened`,
          "admission.reopened",
          options.now,
          `Call Admission reopened against verified Release ${release.id}.`,
          { reopenedAfter: "verified" },
        );
      }
      observeAuthorityDrift(store.findActiveRelease()?.commit);
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
