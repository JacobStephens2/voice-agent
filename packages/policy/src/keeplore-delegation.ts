import {
  keeploreButtonTrialAcceptanceCriteria,
  keeploreButtonTrialGoal,
  keeploreDelegationBriefSchema,
  keeploreDelegationCapabilities,
  keeploreMatchedControlProperties,
  type KeeploreDelegationBrief,
  type KeeploreDelegationResult,
  type KeeploreRegistration,
  type KeeploreWorktree,
} from "@voice-agent/contracts";

export function createKeeploreDelegationBrief(input: {
  readonly acceptedAt: string;
  readonly delegationId: string;
  readonly registration: KeeploreRegistration;
  readonly requestId: string;
  readonly sourceCommit: string;
  readonly taskId: string;
}): { readonly brief: KeeploreDelegationBrief; readonly worktree: KeeploreWorktree } {
  const worktree: KeeploreWorktree = {
    baseCommit: input.sourceCommit,
    branch: `codex/keeplore-button-${input.delegationId}`,
    dirty: false,
    id: input.delegationId,
    path: `${input.registration.worktreeRoot}/${input.delegationId}`,
    state: "queued",
  };
  return {
    brief: keeploreDelegationBriefSchema.parse({
      acceptanceCriteria: [...keeploreButtonTrialAcceptanceCriteria],
      boundedContext: {
        editablePaths: ["ui/style.css"],
        referencePaths: ["ui/artifacts/useby.php", "ui/artifacts/useby.js"],
        repositoryContentTrust: "untrusted-data-only",
      },
      capabilities: [...keeploreDelegationCapabilities],
      delegationId: input.delegationId,
      durableTask: {
        acceptedAt: input.acceptedAt,
        id: input.taskId,
        kind: "keeplore.button-trial",
        requestId: input.requestId,
      },
      goal: keeploreButtonTrialGoal,
      registeredCodebase: {
        applicationId: input.registration.applicationId,
        productionBranch: input.registration.productionBranch,
        provider: input.registration.permittedSubagentProvider,
        readScope: input.registration.readScope,
        repository: input.registration.repository,
        revision: input.registration.revision,
        sourceCommit: input.sourceCommit,
        verificationCommand: input.registration.verification.command,
        worktreeRoot: input.registration.worktreeRoot,
      },
    }),
    worktree,
  };
}

export function validateKeeploreDelegationResult(
  brief: KeeploreDelegationBrief,
  result: KeeploreDelegationResult,
): void {
  if (result.delegationId !== brief.delegationId) {
    throw new Error("Delegation Result identity does not match its brief");
  }
  if (result.branch !== `codex/keeplore-button-${brief.delegationId}`) {
    throw new Error("Delegation Result names an unauthorized branch");
  }
  if (result.worktree.baseCommit !== brief.registeredCodebase.sourceCommit) {
    throw new Error("Delegated Worktree does not use the registered revision");
  }
  for (const path of result.failure?.evidencePaths ?? []) {
    if (
      !path.startsWith(`/var/lib/voice-agent-evidence/${brief.delegationId}/`) ||
      path.split("/").includes("..")
    ) {
      throw new Error("Delegation failure evidence escaped its evidence directory");
    }
  }
  const editable = new Set<string>(brief.boundedContext.editablePaths);
  if (result.changedFiles.some((path) => !editable.has(path))) {
    throw new Error("Delegation Result changed a path outside the table-only scope");
  }
  if (result.status !== "completed") {
    if (
      result.cleanup.eligible ||
      (result.worktree.dirty && result.cleanup.quarantineReason === null)
    ) {
      throw new Error("Incomplete Delegated Worktrees must be retained or quarantined");
    }
    return;
  }
  if (result.failure !== null) {
    throw new Error("A completed Delegation must not report a failure");
  }
  if (
    result.worktree.dirty ||
    result.worktree.state !== "completed" ||
    result.cleanup.eligible ||
    result.cleanup.quarantineReason !== null
  ) {
    throw new Error(
      "A completed Delegation must retain its clean worktree while the pull request is open",
    );
  }
  if (
    result.changedFiles.length !== 1 ||
    result.changedFiles[0] !== "ui/style.css" ||
    result.commits.length === 0
  ) {
    throw new Error("A completed Delegation must contain only its scoped committed change");
  }
  if (result.pullRequest.state !== "open") {
    throw new Error("A completed Delegation must open a pull request");
  }
  const expectedPullRequestPrefix =
    `https://github.com/${brief.registeredCodebase.repository}/pull/`;
  if (
    !result.pullRequest.url.startsWith(expectedPullRequestPrefix) ||
    !/^\d+$/u.test(result.pullRequest.url.slice(expectedPullRequestPrefix.length))
  ) {
    throw new Error("Delegation Result names a pull request outside Keeplore");
  }
  const declaredVerification = result.verification.automated.find(
    (check) => check.command === brief.registeredCodebase.verificationCommand,
  );
  if (declaredVerification?.outcome !== "passed") {
    throw new Error("Declared Keeplore automated verification did not pass");
  }
  for (const viewport of ["desktop", "mobile"] as const) {
    const screenshot = result.verification.screenshots.find(
      (entry) => entry.viewport.name === viewport,
    );
    if (screenshot?.authenticated !== true) {
      throw new Error(`Authenticated ${viewport} screenshot is unavailable`);
    }
    if (
      !screenshot.path.startsWith(
        `/var/lib/voice-agent-evidence/${brief.delegationId}/`,
      ) ||
      screenshot.path.split("/").includes("..")
    ) {
      throw new Error("Delegation screenshot escaped its evidence directory");
    }
    const styles = result.verification.computedStyles.find(
      (entry) => entry.viewport === viewport,
    );
    if (styles === undefined) {
      throw new Error(`${viewport} computed-style evidence is unavailable`);
    }
    const mismatched = keeploreMatchedControlProperties.filter(
      (property) => styles.getRidOf[property] !== styles.remove[property],
    );
    // Every mismatch, not just the alphabetically first: a candidate reported
    // as differing in boxShadow alone sends the next round of work after one
    // property while the rest are still wrong.
    if (mismatched.length > 0) {
      throw new Error(
        `${viewport} table controls differ in ${mismatched.join(", ")}`,
      );
    }
    if (
      styles.getRidOf.widthMode !== "content" ||
      styles.remove.widthMode !== "content" ||
      styles.getRidOf.width === styles.remove.width
    ) {
      throw new Error(`${viewport} table controls do not retain content widths`);
    }
  }
  const cardView = result.verification.cardView;
  if (
    !cardView.unchanged ||
    cardView.beforeHash !== cardView.afterHash
  ) {
    throw new Error("Card view changed during the table-only Delegation");
  }
}
