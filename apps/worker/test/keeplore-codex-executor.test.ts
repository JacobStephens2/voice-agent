import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
  keeploreButtonTrialAcceptanceCriteria,
  keeploreButtonTrialGoal,
  keeploreDelegationBriefSchema,
  keeploreDelegationCapabilities,
  keeploreWorktreeSchema,
} from "@voice-agent/contracts";

const executorPath = fileURLToPath(
  new URL("../src/keeplore-codex-executor.ts", import.meta.url),
);

test("the restricted executor parses its typed JSON stdin before preflight", () => {
  const brief = keeploreDelegationBriefSchema.parse({
    acceptanceCriteria: [...keeploreButtonTrialAcceptanceCriteria],
    boundedContext: {
      editablePaths: ["ui/style.css"],
      referencePaths: ["ui/artifacts/useby.php", "ui/artifacts/useby.js"],
      repositoryContentTrust: "untrusted-data-only",
    },
    capabilities: [...keeploreDelegationCapabilities],
    delegationId: "delegation-stdin",
    durableTask: {
      acceptedAt: "2026-08-23T15:02:07.129Z",
      id: "task-stdin",
      kind: "keeplore.button-trial",
      requestId: "telephone:turn-stdin",
    },
    goal: keeploreButtonTrialGoal,
    registeredCodebase: {
      applicationId: "keeplore-production",
      productionBranch: "main",
      provider: "codex",
      readScope: ["**/*.php"],
      repository: "JacobStephens2/keeplore",
      revision: 1,
      sourceCommit: "82fccd682db9f3ed40f91c56b7577bc6cbcff8ff",
      verificationCommand: "vendor/bin/phpunit",
      worktreeRoot: "/var/lib/voice-agent-worktrees/keeplore",
    },
  });
  const worktree = keeploreWorktreeSchema.parse({
    baseCommit: brief.registeredCodebase.sourceCommit,
    branch: `codex/keeplore-button-${brief.delegationId}`,
    dirty: false,
    id: brief.delegationId,
    path: "/tmp/escaped-keeplore-worktree",
    state: "running",
  });

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", executorPath],
    {
      encoding: "utf8",
      input: JSON.stringify({ brief, worktree }),
      timeout: 10_000,
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Delegated Worktree escaped its registered root",
  );
  expect(result.stderr).not.toContain("expected object, received string");
});
