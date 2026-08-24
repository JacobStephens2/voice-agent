import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createProcessKeeploreSubagentExecutor } from "../src/keeplore-subagent-runner-server.ts";

import {
  keeploreDelegatedWorktree,
  keeploreDelegationBrief,
} from "./keeplore-delegation-fixtures.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("the Subagent Runner forwards the executor's account of a failed run to its journal", async () => {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  const command = await failingExecutorCommand(
    `{"level":50,"msg":"keeplore delegation failed"}`,
  );
  const brief = keeploreDelegationBrief({ delegationId: "delegation-journal" });
  const executor = createProcessKeeploreSubagentExecutor({ command });

  await expect(
    executor.execute({
      brief,
      worktree: keeploreDelegatedWorktree(
        brief,
        `/var/lib/voice-agent-worktrees/keeplore/${brief.delegationId}`,
      ),
    }),
  ).rejects.toThrow("Restricted Codex ended without a structured result");

  expect(written.join("")).toContain("keeplore delegation failed");
});

async function failingExecutorCommand(line: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-executor-"));
  temporaryDirectories.push(directory);
  const command = `${directory}/executor.sh`;
  await writeFile(
    command,
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${line}' >&2\nexit 1\n`,
  );
  await chmod(command, 0o755);
  return command;
}
