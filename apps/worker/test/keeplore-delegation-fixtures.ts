import {
  keeploreButtonTrialAcceptanceCriteria,
  keeploreButtonTrialGoal,
  keeploreDelegationBriefSchema,
  keeploreDelegationCapabilities,
  keeploreWorktreeSchema,
  type KeeploreDelegationBrief,
  type KeeploreWorktree,
} from "@voice-agent/contracts";

const registeredSourceCommit = "82fccd682db9f3ed40f91c56b7577bc6cbcff8ff";

export function keeploreDelegationBrief(options: {
  readonly delegationId: string;
  readonly sourceCommit?: string;
  readonly worktreeRoot?: string;
}): KeeploreDelegationBrief {
  return keeploreDelegationBriefSchema.parse({
    acceptanceCriteria: [...keeploreButtonTrialAcceptanceCriteria],
    boundedContext: {
      editablePaths: ["ui/style.css"],
      referencePaths: ["ui/artifacts/useby.php", "ui/artifacts/useby.js"],
      repositoryContentTrust: "untrusted-data-only",
    },
    capabilities: [...keeploreDelegationCapabilities],
    delegationId: options.delegationId,
    durableTask: {
      acceptedAt: "2026-08-23T15:02:07.129Z",
      id: `task-${options.delegationId}`,
      kind: "keeplore.button-trial",
      requestId: `telephone:turn-${options.delegationId}`,
    },
    goal: keeploreButtonTrialGoal,
    registeredCodebase: {
      applicationId: "keeplore-production",
      productionBranch: "main",
      provider: "codex",
      readScope: ["**/*.php"],
      repository: "JacobStephens2/keeplore",
      revision: 1,
      sourceCommit: options.sourceCommit ?? registeredSourceCommit,
      verificationCommand: "vendor/bin/phpunit",
      worktreeRoot:
        options.worktreeRoot ?? "/var/lib/voice-agent-worktrees/keeplore",
    },
  });
}

export function keeploreDelegatedWorktree(
  brief: KeeploreDelegationBrief,
  path: string,
): KeeploreWorktree {
  return keeploreWorktreeSchema.parse({
    baseCommit: brief.registeredCodebase.sourceCommit,
    branch: `codex/keeplore-button-${brief.delegationId}`,
    dirty: false,
    id: brief.delegationId,
    path,
    state: "running",
  });
}
