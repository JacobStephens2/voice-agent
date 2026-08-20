import {
  keeploreRepositoryPolicyObservationSchema,
  type KeeploreBranchBypassAttestation,
  type KeeploreBranchRulesObservation,
  type KeeploreGitHubAppObservation,
  type KeeplorePolicyAssessment,
  type KeeploreRepositoryPolicyObservation,
} from "@voice-agent/contracts";
import {
  deriveKeeploreBranchProtection,
  deriveKeeploreGitHubAppInstallation,
} from "@voice-agent/policy";

import type { KeeploreOnboardingControls } from "./keeplore-onboarding.ts";

/** The Agent Host's repository-policy journal, read as untrusted append-only events. */
export interface KeeploreRepositoryPolicyJournal {
  read(): Promise<string>;
}

export interface KeeploreRepositoryPolicyAssessments {
  readonly branchProtection: KeeplorePolicyAssessment;
  readonly githubApp: KeeplorePolicyAssessment;
}

/**
 * How long an observation still describes the repository. A boundary nobody has
 * looked at for a week is not evidence that the boundary still holds.
 */
export const keeploreObservationLifetimeMs = 7 * 24 * 60 * 60 * 1000;

const unobserved: KeeplorePolicyAssessment = {
  satisfied: false,
  violations: ["Keeplore repository policy has not been observed recently"],
};

/**
 * Parses observation lines, discarding any the contract rejects. A truncated
 * final line — the collector appends while this reads — is not yet evidence.
 */
export function readKeeploreRepositoryPolicyObservations(
  journal: string,
): readonly KeeploreRepositoryPolicyObservation[] {
  const observations: KeeploreRepositoryPolicyObservation[] = [];
  for (const line of journal.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const observation =
      keeploreRepositoryPolicyObservationSchema.safeParse(parsed);
    if (observation.success) observations.push(observation.data);
  }
  return observations;
}

/**
 * Records what was observed of the production branch's rules and the Voice
 * Agent's GitHub App installation. An unobserved or stale policy stays
 * unassessed rather than assumed satisfied, so the Evidence Record never claims
 * a boundary nobody checked.
 */
export async function assessKeeploreRepositoryPolicy(options: {
  readonly controls: Pick<
    KeeploreOnboardingControls,
    "assessKeeploreBranchProtection" | "assessKeeploreGitHubApp"
  >;
  readonly journal: KeeploreRepositoryPolicyJournal;
  readonly now: () => number;
}): Promise<KeeploreRepositoryPolicyAssessments> {
  const fresh = readKeeploreRepositoryPolicyObservations(
    await options.journal.read(),
  ).filter(
    (observation) =>
      options.now() - Date.parse(observation.observedAt) <
      keeploreObservationLifetimeMs,
  );
  const rules = latest<KeeploreBranchRulesObservation>(fresh, "branch-rules");
  const attestation = latest<KeeploreBranchBypassAttestation>(
    fresh,
    "branch-bypass",
  );
  const app = latest<KeeploreGitHubAppObservation>(fresh, "github-app");
  const [branchProtection, githubApp] = await Promise.all([
    rules === undefined
      ? Promise.resolve(unobserved)
      : options.controls.assessKeeploreBranchProtection(
          deriveKeeploreBranchProtection({ attestation, rules }),
        ),
    app === undefined
      ? Promise.resolve(unobserved)
      : options.controls.assessKeeploreGitHubApp(
          deriveKeeploreGitHubAppInstallation(app),
        ),
  ]);
  return { branchProtection, githubApp };
}

function latest<Observation extends KeeploreRepositoryPolicyObservation>(
  observations: readonly KeeploreRepositoryPolicyObservation[],
  kind: Observation["kind"],
): Observation | undefined {
  return observations
    .filter((observation): observation is Observation =>
      observation.kind === kind,
    )
    .reduce<Observation | undefined>(
      (newest, observation) =>
        newest === undefined || newest.observedAt <= observation.observedAt
          ? observation
          : newest,
      undefined,
    );
}
