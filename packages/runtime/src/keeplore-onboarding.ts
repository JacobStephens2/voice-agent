import {
  keeploreDeploymentContractSchema,
  type KeeploreBranchProtection,
  type KeeploreDeploymentContract,
  type KeeploreEnrollmentSource,
  type KeeploreGitHubAppInstallation,
  type KeeploreLiveInspection,
  type KeeplorePolicyAssessment,
  type KeeploreRegistration,
  type KeeploreWorkingTreeReconciliation,
} from "@voice-agent/contracts";
import type {
  KeeploreAssessmentKind,
  KeeploreOnboardingStore,
} from "@voice-agent/durable-store";
import {
  assessKeeploreBranchProtection,
  assessKeeploreGitHubAppInstallation,
  authorizeKeeploreContractActivation,
  authorizeKeeploreEnrollment,
  createKeeploreRegistration,
} from "@voice-agent/policy";

export {
  deriveKeeploreOnboardingConclusion,
  keeploreReleaseRoot,
  keeploreRetainedReleases,
} from "@voice-agent/policy";

/** A read-only revalidation of the live Keeplore checkout. */
export interface KeeploreLiveInspector {
  inspect(): Promise<KeeploreLiveInspection>;
}

export type {
  KeeploreAssessmentKind,
  KeeploreOnboardingStore,
} from "@voice-agent/durable-store";

export type KeeploreEnrollmentResult =
  | { readonly decision: "denied"; readonly reason: string }
  | {
      readonly decision: "enrolled";
      readonly registration: KeeploreRegistration;
    };

export type KeeploreContractActivationResult =
  | { readonly decision: "denied"; readonly reason: string }
  | {
      readonly contract: KeeploreDeploymentContract;
      readonly decision: "activated";
    };

export interface KeeploreOnboardingControls {
  activateKeeploreDeploymentContract(input: {
    readonly buildCommand: string;
    readonly health: KeeploreDeploymentContract["health"];
    readonly preflightCommand: string;
    readonly releaseRoot: string;
    readonly retainedReleases: number;
    readonly revision: number;
    readonly source: KeeploreEnrollmentSource;
  }): Promise<KeeploreContractActivationResult>;
  assessKeeploreBranchProtection(
    protection: KeeploreBranchProtection,
  ): Promise<KeeplorePolicyAssessment>;
  assessKeeploreGitHubApp(
    installation: KeeploreGitHubAppInstallation,
  ): Promise<KeeplorePolicyAssessment>;
  /** Enrollment revalidates the live checkout itself unless an inspection is supplied. */
  enrollKeeplore(input: {
    readonly inspection?: KeeploreLiveInspection | undefined;
    readonly reconciliation: KeeploreWorkingTreeReconciliation;
    readonly source: KeeploreEnrollmentSource;
  }): Promise<KeeploreEnrollmentResult>;
  getKeeploreActiveContract(): Promise<KeeploreDeploymentContract | undefined>;
  getKeeploreAssessment(
    kind: KeeploreAssessmentKind,
  ): Promise<KeeplorePolicyAssessment | undefined>;
  getKeeploreRegistration(): Promise<KeeploreRegistration | undefined>;
  inspectKeeploreLiveCheckout(): Promise<KeeploreLiveInspection>;
}

const unassessed: KeeplorePolicyAssessment = {
  satisfied: false,
  violations: ["Keeplore policy has not been assessed"],
};

export function createKeeploreOnboardingControls(options: {
  readonly inspector: KeeploreLiveInspector;
  readonly now: () => string;
  readonly store: KeeploreOnboardingStore;
}): KeeploreOnboardingControls {
  async function requireRegistration(): Promise<KeeploreRegistration | undefined> {
    return options.store.findRegistration();
  }

  return {
    async activateKeeploreDeploymentContract(input) {
      const registration = await requireRegistration();
      const active = await options.store.findActiveContract();
      const decision = authorizeKeeploreContractActivation({
        activeRevision: active?.revision,
        registration,
        releaseRoot: input.releaseRoot,
        revision: input.revision,
        source: input.source,
      });
      if (decision.decision === "deny") {
        return { decision: "denied", reason: decision.reason };
      }
      const contract = keeploreDeploymentContractSchema.parse({
        activatedAt: options.now(),
        activatedBy: "fresh-passkey-action",
        applicationId: "keeplore-production",
        buildCommand: input.buildCommand,
        health: input.health,
        preflightCommand: input.preflightCommand,
        releaseRoot: input.releaseRoot,
        retainedReleases: input.retainedReleases,
        revision: input.revision,
        source: "voice-agent-policy",
      });
      await options.store.saveContract(contract);
      return { contract, decision: "activated" };
    },
    async assessKeeploreBranchProtection(protection) {
      const registration = await requireRegistration();
      if (registration === undefined) return unassessed;
      const assessment = assessKeeploreBranchProtection(protection, registration);
      await options.store.saveAssessment("branch-protection", assessment);
      return assessment;
    },
    async assessKeeploreGitHubApp(installation) {
      const registration = await requireRegistration();
      if (registration === undefined) return unassessed;
      const assessment = assessKeeploreGitHubAppInstallation(
        installation,
        registration,
      );
      await options.store.saveAssessment("github-app", assessment);
      return assessment;
    },
    async enrollKeeplore(input) {
      const inspection = input.inspection ?? (await options.inspector.inspect());
      const decision = authorizeKeeploreEnrollment({
        inspection,
        reconciliation: input.reconciliation,
        source: input.source,
      });
      if (decision.decision === "deny") {
        return { decision: "denied", reason: decision.reason };
      }
      const existing = await options.store.findRegistration();
      const registration = createKeeploreRegistration({
        inspection,
        registeredAt: options.now(),
        revision: (existing?.revision ?? 0) + 1,
      });
      await options.store.saveRegistration(registration);
      return { decision: "enrolled", registration };
    },
    async getKeeploreActiveContract() {
      return options.store.findActiveContract();
    },
    async getKeeploreAssessment(kind) {
      return (await options.store.findAssessment(kind)) ?? unassessed;
    },
    async getKeeploreRegistration() {
      return options.store.findRegistration();
    },
    async inspectKeeploreLiveCheckout() {
      return options.inspector.inspect();
    },
  };
}
