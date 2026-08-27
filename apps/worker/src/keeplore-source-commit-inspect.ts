/**
 * Refuse a registered Keeplore source commit that cannot exercise the trial.
 *
 * The wizard runs this after the operator pins a source commit and before it
 * asks for the telephone call, so a commit whose `ui/style.css` already carries
 * the Brief's rule costs a git read here rather than a call, a Codex run, and
 * an operator's review of a Delegation that had no candidate to produce.
 *
 * It runs as `voice-codex`, the only identity granted read access to the
 * root-owned source mirror, and imports nothing outside this package so that
 * path resolves no workspace link.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  describeSatisfiedKeeploreSourceCommit,
  findSatisfiedKeeploreSourceCommit,
} from "./keeplore-satisfied-source-commit.ts";

/** Enough history to reach the merge that introduced the rule, and no more. */
const walkedAncestors = 200;
const run = promisify(execFile);
const mirror = process.env.KEEPLORE_SOURCE_MIRROR ?? "";
const sourceCommit = process.env.KEEPLORE_SOURCE_COMMIT ?? "";

if (!/^[0-9a-f]{40}$/u.test(sourceCommit) || mirror === "") {
  process.stderr.write(
    "KEEPLORE_SOURCE_MIRROR and a 40-character KEEPLORE_SOURCE_COMMIT are required.\n",
  );
  process.exit(1);
}

try {
  const satisfied = await findSatisfiedKeeploreSourceCommit({
    ancestors: (
      await git([
        "rev-list",
        "--first-parent",
        `--max-count=${walkedAncestors}`,
        sourceCommit,
        "--",
        "ui/style.css",
      ])
    )
      .split("\n")
      .filter(Boolean),
    readStylesheet: (commit) => git(["show", `${commit}:ui/style.css`]),
    sourceCommit,
  });
  if (satisfied !== null) {
    process.stderr.write(
      `${describeSatisfiedKeeploreSourceCommit(satisfied)}\n`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  // A source commit whose ui/style.css the mirror cannot produce is no more
  // runnable than one that already carries the rule, and the operator is owed
  // the reason in a line rather than a stack.
  process.stderr.write(
    `Unable to read ui/style.css at ${sourceCommit} from ${mirror}: ${describeFailure(error)}\n`,
  );
  process.exitCode = 1;
}

async function git(args: readonly string[]): Promise<string> {
  return (await run("/usr/bin/git", [`--git-dir=${mirror}`, ...args])).stdout;
}

function describeFailure(error: unknown): string {
  const reported = (error as { readonly stderr?: unknown }).stderr;
  const text =
    typeof reported === "string" && reported.trim() !== ""
      ? reported
      : String(error);
  return text.trim().split("\n")[0] ?? "";
}
