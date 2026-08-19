import {
  keeploreApplicationId,
  keeploreOnboardingEvidenceRecordProjectionSchema,
  type FixtureGitHubEvent,
  type KeeploreBranchProtection,
  type KeeploreDeploymentContract,
  type KeeploreEnrollmentSource,
  type KeeploreGitHubAppInstallation,
  type KeeploreLiveInspection,
  type KeeplorePolicyAssessment,
  type KeeploreOnboardingEvidenceRecordProjection,
  type KeeploreRegistration,
  type KeeploreWorkingTreeReconciliation,
  type PromotionEvidenceRecordProjection,
} from "@voice-agent/contracts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import { renderEvidenceRecordPage } from "@voice-agent/pwa/server";
import { createSqliteKeeploreOnboardingStore } from "@voice-agent/sqlite-store";
import {
  createKeeploreOnboardingControls,
  deriveKeeploreOnboardingConclusion,
  keeploreReleaseRoot,
  keeploreRetainedReleases,
  type KeeploreContractActivationResult,
  type KeeploreEnrollmentResult,
} from "@voice-agent/runtime";

import {
  createHumanMergePromotionScenario,
  type PromotionDeliveryResult,
} from "./human-merge-promotion.ts";
import type {
  PromotionCodebase,
  PromotionStoreInspection,
} from "./human-merge-promotion-store.ts";

const contractActivationSessionToken = "keeplore-fresh-passkey-session";
const trustedSessionToken = "trusted";
const onboardingQuestion = "Onboard Keeplore with a harmless Human Merge." as const;

export interface KeeploreOnboardingDeliveryResult {
  readonly outcome: PromotionDeliveryResult["outcome"];
  readonly record: KeeploreOnboardingEvidenceRecordProjection;
}

export interface KeeploreOnboardingScenarioOptions {
  readonly databasePath: string;
  readonly healthStatusByCommit?: Readonly<Record<string, number>> | undefined;
  readonly ids: readonly string[];
  readonly inspection: KeeploreLiveInspection;
  readonly now: string;
  readonly webhookSecret: string;
}

export interface KeeploreOnboardingScenario {
  activateContract(input: {
    readonly buildCommand?: string;
    readonly health?: KeeploreDeploymentContract["health"];
    readonly preflightCommand?: string;
    readonly releaseRoot?: string;
    readonly retainedReleases?: number;
    readonly revision: number;
    readonly source: KeeploreEnrollmentSource;
  }): Promise<KeeploreContractActivationResult>;
  assessBranchProtection(
    protection: KeeploreBranchProtection,
  ): Promise<KeeplorePolicyAssessment>;
  assessGitHubApp(
    installation: KeeploreGitHubAppInstallation,
  ): Promise<KeeplorePolicyAssessment>;
  /** The pulls, branches, worktrees, builds, and deployments performed so far. */
  automationActions(): Promise<readonly string[]>;
  close(): Promise<void>;
  deliver(input: {
    readonly deliveryId: string;
    readonly event: FixtureGitHubEvent;
    readonly signature: string;
  }): Promise<KeeploreOnboardingDeliveryResult>;
  enroll(input: {
    readonly reconciliation: KeeploreWorkingTreeReconciliation;
    readonly source: KeeploreEnrollmentSource;
  }): Promise<KeeploreEnrollmentResult>;
  getRecord(
    taskId: string,
  ): Promise<KeeploreOnboardingEvidenceRecordProjection | undefined>;
  getRegistration(): Promise<KeeploreRegistration | undefined>;
  inspect(): Promise<PromotionStoreInspection>;
  inspectLiveCheckout(): Promise<KeeploreLiveInspection>;
  liveCheckoutState(): Promise<{
    readonly headCommit: string;
    readonly uncommittedPaths: readonly string[];
  }>;
  processNext(): Promise<KeeploreOnboardingEvidenceRecordProjection | undefined>;
  readTaskPage(
    taskId: string,
    sessionToken?: string,
  ): Promise<{
    readonly body:
      | KeeploreOnboardingEvidenceRecordProjection
      | { readonly error: string };
    readonly html: string;
    readonly statusCode: number;
  }>;
  reconcile(
    events: readonly FixtureGitHubEvent[],
  ): Promise<readonly KeeploreOnboardingDeliveryResult[]>;
}

export async function createKeeploreOnboardingScenario(
  options: KeeploreOnboardingScenarioOptions,
): Promise<KeeploreOnboardingScenario> {
  const onboardingStore = createSqliteKeeploreOnboardingStore(options.databasePath);
  const controls = createKeeploreOnboardingControls({
    inspector: { async inspect() { return options.inspection; } },
    now: () => options.now,
    store: onboardingStore,
  });
  const codebase: PromotionCodebase = {
    applicationId: keeploreApplicationId,
    buildCommand: "npm ci && npm run build",
    health: { expectedStatus: 200, path: "/api/health" },
    initialProductionCommit: options.inspection.headCommit,
    liveCheckoutPath: options.inspection.liveCheckoutPath,
    preflightCommand: options.inspection.verificationCommands[0] ?? "npm test",
    productionBranch: options.inspection.productionBranch,
    releaseRoot: keeploreReleaseRoot,
    repository: options.inspection.repository,
    sourceCheckoutRoot: "/var/lib/keeplore-source",
  };
  const promotion = await createHumanMergePromotionScenario({
    codebase,
    contractActivationAuthority: {
      async hasFreshPasskeyAction(sessionToken) {
        return sessionToken === contractActivationSessionToken;
      },
    },
    databasePath: options.databasePath,
    healthStatusByCommit: options.healthStatusByCommit,
    ids: options.ids,
    now: options.now,
    seedDeploymentContract: false,
    webhookSecret: options.webhookSecret,
  });
  const api = createTaskApi({
    authentication: {
      async canViewEvidence(sessionToken) {
        return sessionToken === trustedSessionToken;
      },
    },
    records: {
      async getEvidenceRecord(taskId) {
        return projectRecord(await promotion.getRecord(taskId));
      },
    },
  });

  async function projectRecord(
    record: PromotionEvidenceRecordProjection | undefined,
  ): Promise<KeeploreOnboardingEvidenceRecordProjection | undefined> {
    if (record === undefined) return undefined;
    const registration = await controls.getKeeploreRegistration();
    const contract = await controls.getKeeploreActiveContract();
    if (registration === undefined || contract === undefined) {
      throw new Error("Keeplore onboarding policy is unavailable");
    }
    const promoted = record.promotion.verification?.outcome === "healthy";
    const rolledBack = record.promotion.rollback.performed;
    const activeRelease = (await promotion.inspect()).activeRelease;
    return keeploreOnboardingEvidenceRecordProjectionSchema.parse({
      evidence: record.evidence,
      onboarding: {
        branchProtection: await controls.getKeeploreAssessment("branch-protection"),
        contractRevision: contract.revision,
        githubApp: await controls.getKeeploreAssessment("github-app"),
        ...(record.promotion.verification === undefined
          ? {}
          : { health: record.promotion.verification }),
        merge: record.promotion.merge,
        ...(record.promotion.attempt === undefined
          ? {}
          : {
              promotionAttempt: {
                id: record.promotion.attempt.id,
                mergeCommit: record.promotion.attempt.mergeCommit,
                status: record.promotion.attempt.status,
              },
            }),
        registrationRevision: registration.revision,
        ...(record.promotion.release === undefined
          ? {}
          : { release: record.promotion.release }),
        ...(activeRelease === undefined ||
        activeRelease.id === record.promotion.release?.id
          ? {}
          : { retainedRelease: activeRelease }),
        rollback: record.promotion.rollback,
      },
      task: {
        conclusion:
          record.promotion.attempt === undefined ||
          record.promotion.attempt.status === "queued" ||
          record.promotion.attempt.status === "running"
            ? "Keeplore onboarding is pending."
            : deriveKeeploreOnboardingConclusion({ promoted, rolledBack }),
        createdAt: record.task.createdAt,
        id: record.task.id,
        kind: "keeplore.onboarding",
        question: onboardingQuestion,
        status: record.task.status,
        updatedAt: record.task.updatedAt,
      },
    });
  }

  async function requireProjection(
    record: PromotionEvidenceRecordProjection,
  ): Promise<KeeploreOnboardingEvidenceRecordProjection> {
    const projected = await projectRecord(record);
    if (projected === undefined) {
      throw new Error("Keeplore onboarding Evidence Record is unavailable");
    }
    return projected;
  }

  return {
    async activateContract(input) {
      const registration = await controls.getKeeploreRegistration();
      const activation = await controls.activateKeeploreDeploymentContract({
        buildCommand: input.buildCommand ?? codebase.buildCommand,
        health: input.health ?? codebase.health,
        preflightCommand: input.preflightCommand ?? codebase.preflightCommand,
        releaseRoot:
          input.releaseRoot ??
          registration?.deploymentBoundaries.releaseRoot ??
          keeploreReleaseRoot,
        retainedReleases: input.retainedReleases ?? keeploreRetainedReleases,
        revision: input.revision,
        source: input.source,
      });
      if (activation.decision === "denied") return activation;
      await promotion.activateContract({
        buildCommand: activation.contract.buildCommand,
        health: activation.contract.health,
        preflightCommand: activation.contract.preflightCommand,
        releaseRoot: activation.contract.releaseRoot,
        revision: activation.contract.revision,
        sessionToken: contractActivationSessionToken,
      });
      return activation;
    },
    async assessBranchProtection(protection) {
      return controls.assessKeeploreBranchProtection(protection);
    },
    async assessGitHubApp(installation) {
      return controls.assessKeeploreGitHubApp(installation);
    },
    async automationActions() {
      const inspection = await promotion.inspect();
      return inspection.operations.map((operation) => operation.kind);
    },
    async close() {
      await api.close();
      await promotion.close();
      onboardingStore.close();
    },
    async deliver(input) {
      await requireActiveContract();
      const delivered = await promotion.deliver(input);
      return {
        outcome: delivered.outcome,
        record: await requireProjection(delivered.record),
      };
    },
    async enroll(input) {
      return controls.enrollKeeplore({
        reconciliation: input.reconciliation,
        source: input.source,
      });
    },
    async getRecord(taskId) {
      return projectRecord(await promotion.getRecord(taskId));
    },
    async getRegistration() {
      return controls.getKeeploreRegistration();
    },
    async inspect() {
      return promotion.inspect();
    },
    async inspectLiveCheckout() {
      return controls.inspectKeeploreLiveCheckout();
    },
    async liveCheckoutState() {
      const inspection = await controls.inspectKeeploreLiveCheckout();
      return {
        headCommit: inspection.headCommit,
        uncommittedPaths: inspection.uncommittedPaths,
      };
    },
    async processNext() {
      const promoted = await promotion.processNext();
      if (promoted === undefined) return undefined;
      return requireProjection(promoted);
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
        KeeploreOnboardingEvidenceRecordProjection | { readonly error: string }
      >();
      return {
        body,
        html:
          response.statusCode === 200
            ? renderEvidenceRecordPage(
                body as KeeploreOnboardingEvidenceRecordProjection,
              )
            : "",
        statusCode: response.statusCode,
      };
    },
    async reconcile(events) {
      await requireActiveContract();
      const discovered = await promotion.reconcile(events);
      const projected: KeeploreOnboardingDeliveryResult[] = [];
      for (const result of discovered) {
        projected.push({
          outcome: result.outcome,
          record: await requireProjection(result.record),
        });
      }
      return projected;
    },
  };

  async function requireActiveContract(): Promise<void> {
    if ((await controls.getKeeploreActiveContract()) === undefined) {
      throw new Error("Keeplore Deployment Contract is not active");
    }
  }
}
