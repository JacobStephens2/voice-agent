import type {
  KeeploreDeploymentContract,
  KeeplorePolicyAssessment,
  KeeploreRegistration,
} from "@voice-agent/contracts";

export type KeeploreAssessmentKind = "branch-protection" | "github-app";

/** Durable Keeplore onboarding policy: registration, contract revisions, assessments. */
export interface KeeploreOnboardingStore {
  findActiveContract(): Promise<KeeploreDeploymentContract | undefined>;
  findAssessment(
    kind: KeeploreAssessmentKind,
  ): Promise<KeeplorePolicyAssessment | undefined>;
  findRegistration(): Promise<KeeploreRegistration | undefined>;
  saveAssessment(
    kind: KeeploreAssessmentKind,
    assessment: KeeplorePolicyAssessment,
  ): Promise<void>;
  saveContract(contract: KeeploreDeploymentContract): Promise<void>;
  saveRegistration(registration: KeeploreRegistration): Promise<void>;
}
