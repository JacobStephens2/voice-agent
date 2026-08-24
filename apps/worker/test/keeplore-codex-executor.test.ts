import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import { keeploreDelegationResultSchema } from "@voice-agent/contracts";

import {
  keeploreDelegatedWorktree,
  keeploreDelegationBrief,
} from "./keeplore-delegation-fixtures.ts";

const executorPath = fileURLToPath(
  new URL("../src/keeplore-codex-executor.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("the restricted executor parses its typed JSON stdin before preflight", () => {
  const result = runExecutor(
    executorInput({
      delegationId: "delegation-stdin",
      worktreePath: "/tmp/escaped-keeplore-worktree",
      worktreeRoot: "/var/lib/voice-agent-worktrees/keeplore",
    }),
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Delegated Worktree escaped its registered root",
  );
  expect(result.stderr).not.toContain("expected object, received string");
});

test(
  "a Delegation that fails before the model runs records the error that ended it",
  async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "keeplore-worktrees-"));
    temporaryDirectories.push(worktreeRoot);
    const delegationId = "delegation-preparation";

    const spawned = runExecutor(
      executorInput({
        delegationId,
        // No commit resolves, so the run cannot reach the restricted model.
        sourceCommit: "0".repeat(40),
        worktreePath: `${worktreeRoot}/${delegationId}`,
        worktreeRoot,
      }),
    );

    expect(spawned.status).toBe(0);
    const result = keeploreDelegationResultSchema.parse(
      JSON.parse(spawned.stdout),
    );
    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({
      evidencePaths: [],
      kind: "delegation-execution",
    });
    expect(result.failure?.name.length).toBeGreaterThan(0);
    expect(result.failure?.message.length).toBeGreaterThan(0);
    // A preparation failure is not one of the kinds only a started run can
    // produce, so the recorded failure names this run and not the model's.
    expect(["model-declined", "restricted-runner", "sandbox-initialization"]).not.toContain(
      result.failure?.kind,
    );
    expect(result.changedFiles).toEqual([]);
    expect(result.commits).toEqual([]);
    expect(result.worktree.state).toBe("failed");
    expect(result.pullRequest).toEqual({ state: "none", url: null });
    expect(spawned.stderr).toContain("keeplore delegation failed");
    expect(spawned.stderr).toContain(delegationId);
  },
  120_000,
);

function runExecutor(input: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", executorPath], {
    encoding: "utf8",
    input,
    timeout: 110_000,
  });
}

function executorInput(options: {
  readonly delegationId: string;
  readonly sourceCommit?: string;
  readonly worktreePath: string;
  readonly worktreeRoot: string;
}): string {
  const brief = keeploreDelegationBrief(options);
  return JSON.stringify({
    brief,
    worktree: keeploreDelegatedWorktree(brief, options.worktreePath),
  });
}
