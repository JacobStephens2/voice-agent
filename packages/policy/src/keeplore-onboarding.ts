import {
  keeploreApplicationId,
  keeploreFormerRepository,
  keeploreProductionBranch,
  keeploreRegistrationSchema,
  keeploreRepository,
  keeplorePolicyAssessmentSchema,
  type KeeploreBranchProtection,
  type KeeploreEnrollmentSource,
  type KeeploreGitHubAppInstallation,
  type KeeploreLiveInspection,
  type KeeplorePolicyAssessment,
  type KeeploreRegistration,
  type KeeploreWorkingTreeReconciliation,
} from "@voice-agent/contracts";

/** Source files the Voice Agent may read directly; secrets and env files are excluded. */
export const keeploreDefaultReadScope = [
  "**/*.php",
  "**/*.js",
  "**/*.css",
  "**/*.html",
  "**/*.json",
  "**/*.sql",
  "**/*.md",
  "!**/environment_variables.php",
] as const;

export const keeploreReleaseRoot = "/opt/keeplore/releases" as const;
export const keeploreSharedRoot = "/opt/keeplore/shared" as const;

/**
 * Gitignored runtime state that lives inside the live checkout today. Each
 * Release links these out of the shared root, so a Release carries no secrets
 * and a Promotion never orphans live state.
 */
export const keeploreSharedPaths = [
  "private/environment_variables.php",
  "private/vendor",
  "database/backups",
  "logs",
] as const;
export const keeploreSourceMirrorPath =
  "/var/lib/keeplore-source/repository.git" as const;
export const keeploreWorktreeRoot =
  "/var/lib/voice-agent-worktrees/keeplore" as const;
export const keeploreRetainedReleases = 2;

/** Exactly the GitHub App authority the design requires, and nothing else. */
export const keeploreRequiredGitHubAppPermissions = {
  checks: "read",
  contents: "write",
  pull_requests: "write",
} as const;

export interface KeeploreEnrollmentDecision {
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

export function authorizeKeeploreEnrollment(input: {
  readonly inspection: KeeploreLiveInspection;
  readonly reconciliation: KeeploreWorkingTreeReconciliation;
  readonly source: KeeploreEnrollmentSource;
}): KeeploreEnrollmentDecision {
  if (input.source !== "fresh-passkey-action") {
    return {
      decision: "deny",
      reason: denyKeeploreAuthorityExpansion(input.source),
    };
  }
  if (input.reconciliation.remainingUncommittedPaths.length > 0) {
    return {
      decision: "deny",
      reason:
        "Live Keeplore work must be reconciled and preserved by the owner before enrollment",
    };
  }
  if (
    input.inspection.uncommittedPaths.length > 0 &&
    input.reconciliation.outcome === "already-clean"
  ) {
    return {
      decision: "deny",
      reason: "Keeplore reconciliation evidence contradicts the live inspection",
    };
  }
  if (input.inspection.remoteRepository !== keeploreRepository) {
    return {
      decision: "deny",
      reason:
        input.inspection.remoteRepository === keeploreFormerRepository
          ? `The live checkout still names ${keeploreFormerRepository}; repoint its origin at ${keeploreRepository}`
          : `The live checkout tracks ${input.inspection.remoteRepository}, not ${keeploreRepository}`,
    };
  }
  const undeclaredSharedPaths = keeploreSharedPaths.filter(
    (path) => !input.inspection.sharedPaths.includes(path),
  );
  if (undeclaredSharedPaths.length > 0) {
    return {
      decision: "deny",
      reason: `Keeplore shared state is undeclared: ${undeclaredSharedPaths.join(", ")}`,
    };
  }
  if (
    input.inspection.documentRoots.api === input.inspection.liveCheckoutPath ||
    input.inspection.documentRoots.ui === input.inspection.liveCheckoutPath
  ) {
    return {
      decision: "deny",
      reason: "Keeplore document roots must name the served subdirectories",
    };
  }
  if (
    input.reconciliation.outcome === "preserved-on-branch" &&
    input.reconciliation.preservedRef === undefined
  ) {
    return {
      decision: "deny",
      reason: "Preserved Keeplore work must name the reference that holds it",
    };
  }
  return {
    decision: "allow",
    reason: "The live Keeplore working tree is reconciled and preserved.",
  };
}

export function denyKeeploreAuthorityExpansion(
  source: Exclude<KeeploreEnrollmentSource, "fresh-passkey-action">,
): string {
  if (source === "trusted-session") return "Fresh Passkey Action required";
  if (source === "voice") return "Voice cannot enroll Keeplore";
  return "Repository content cannot enroll Keeplore";
}

export function createKeeploreRegistration(input: {
  readonly inspection: KeeploreLiveInspection;
  readonly registeredAt: string;
  readonly revision: number;
}): KeeploreRegistration {
  const [verificationCommand] = input.inspection.verificationCommands;
  if (verificationCommand === undefined) {
    throw new Error("Keeplore enrollment requires a declared verification seam");
  }
  return keeploreRegistrationSchema.parse({
    applicationId: keeploreApplicationId,
    deploymentBoundaries: {
      liveCheckoutPath: input.inspection.liveCheckoutPath,
      releaseRoot: keeploreReleaseRoot,
      retainedReleases: keeploreRetainedReleases,
      sharedRoot: keeploreSharedRoot,
      sourceMirrorPath: keeploreSourceMirrorPath,
    },
    permittedSubagentProvider: "codex",
    productionBranch: keeploreProductionBranch,
    readScope: [...keeploreDefaultReadScope],
    registeredAt: input.registeredAt,
    registeredBy: "fresh-passkey-action",
    repository: keeploreRepository,
    revision: input.revision,
    verification: {
      checkName: "keeplore-verification",
      command: verificationCommand,
    },
    worktreeRoot: keeploreWorktreeRoot,
  });
}

export function assessKeeploreBranchProtection(
  protection: KeeploreBranchProtection,
  registration: KeeploreRegistration,
): KeeplorePolicyAssessment {
  const violations: string[] = [];
  if (protection.branch !== registration.productionBranch) {
    violations.push(
      `Branch protection targets ${protection.branch}, not ${registration.productionBranch}`,
    );
  }
  if (!protection.requiresPullRequest) {
    violations.push("Production branch does not require a pull request");
  }
  if (protection.allowsForcePush) {
    violations.push("Production branch allows force pushes");
  }
  if (protection.allowsDeletion) {
    violations.push("Production branch allows deletion");
  }
  if (!protection.requiredChecks.includes(registration.verification.checkName)) {
    violations.push(
      `Production branch does not require the ${registration.verification.checkName} check`,
    );
  }
  for (const actor of protection.bypassActors) {
    violations.push(`Production branch rules grant ${actor} bypass authority`);
  }
  return keeplorePolicyAssessmentSchema.parse({
    satisfied: violations.length === 0,
    violations,
  });
}

export function assessKeeploreGitHubAppInstallation(
  installation: KeeploreGitHubAppInstallation,
  registration: KeeploreRegistration,
): KeeplorePolicyAssessment {
  const violations: string[] = [];
  for (const [permission, level] of Object.entries(
    keeploreRequiredGitHubAppPermissions,
  )) {
    const granted = installation.permissions[permission];
    if (granted === undefined) {
      violations.push(`GitHub App is missing the ${permission} permission`);
    } else if (granted !== level) {
      violations.push(
        `GitHub App holds ${permission}:${granted} instead of ${permission}:${level}`,
      );
    }
  }
  for (const [permission, level] of Object.entries(installation.permissions)) {
    if (!(permission in keeploreRequiredGitHubAppPermissions)) {
      violations.push(`GitHub App holds the unrequired ${permission} permission`);
    } else if (level === "admin") {
      violations.push(`GitHub App holds administrative ${permission} authority`);
    }
  }
  for (const repository of installation.repositories) {
    if (repository !== registration.repository) {
      violations.push(`GitHub App is installed on unregistered ${repository}`);
    }
  }
  return keeplorePolicyAssessmentSchema.parse({
    satisfied: violations.length === 0,
    violations,
  });
}

export function authorizeKeeploreContractActivation(input: {
  readonly activeRevision: number | undefined;
  readonly registration: KeeploreRegistration | undefined;
  readonly releaseRoot: string;
  readonly revision: number;
  readonly source: KeeploreEnrollmentSource;
}): KeeploreEnrollmentDecision {
  if (input.source !== "fresh-passkey-action") {
    return {
      decision: "deny",
      reason:
        input.source === "repository"
          ? "Repository content cannot activate a Keeplore Deployment Contract"
          : denyKeeploreAuthorityExpansion(input.source),
    };
  }
  if (input.registration === undefined) {
    return { decision: "deny", reason: "Keeplore is not a Registered Codebase" };
  }
  const { liveCheckoutPath, releaseRoot } = input.registration.deploymentBoundaries;
  if (
    input.releaseRoot === liveCheckoutPath ||
    input.releaseRoot.startsWith(`${liveCheckoutPath}/`) ||
    !input.releaseRoot.startsWith(releaseRoot)
  ) {
    return {
      decision: "deny",
      reason: "Deployment Contract Release root is outside the registered boundaries",
    };
  }
  if (
    input.activeRevision !== undefined &&
    input.revision <= input.activeRevision
  ) {
    return {
      decision: "deny",
      reason: "Deployment Contract revisions must increase",
    };
  }
  return {
    decision: "allow",
    reason: "A Fresh Passkey Action may activate the Deployment Contract revision.",
  };
}

export function deriveKeeploreOnboardingConclusion(input: {
  readonly promoted: boolean;
  readonly rolledBack: boolean;
}): "Keeplore is onboarded and its Human Merge was promoted." | "Keeplore onboarding could not be confirmed." {
  return input.promoted && !input.rolledBack
    ? "Keeplore is onboarded and its Human Merge was promoted."
    : "Keeplore onboarding could not be confirmed.";
}
