import { expect, test } from "vitest";

import { assertNonDestructiveGitArguments } from "../src/worktree-safety.ts";

test("observing and committing a Delegated Worktree is permitted", () => {
  for (const command of [
    ["-C", "/worktree", "status", "--porcelain"],
    ["-C", "/worktree", "add", "--", "ui/style.css"],
    ["-C", "/worktree", "commit", "-m", "Change a control"],
    ["-C", "/worktree", "rev-parse", "HEAD"],
  ]) {
    expect(() => assertNonDestructiveGitArguments(command)).not.toThrow();
  }
});

test("resetting, stashing, cleaning, or deleting a Delegated Worktree is refused", () => {
  for (const command of [
    ["-C", "/worktree", "reset", "--hard"],
    ["-C", "/worktree", "stash"],
    ["-C", "/worktree", "clean", "-fd"],
    ["-C", "/worktree", "restore", "."],
    ["-C", "/worktree", "rm", "-r", "ui"],
    ["-C", "/worktree", "worktree", "remove", "/worktree"],
    ["-C", "/worktree", "update-ref", "-d", "refs/heads/grok/task"],
  ]) {
    expect(() => assertNonDestructiveGitArguments(command)).toThrow(
      "Stopping preserves a Delegated Worktree",
    );
  }
});

test("a forced checkout that would discard unfinished work is refused", () => {
  expect(() =>
    assertNonDestructiveGitArguments(["-C", "/worktree", "checkout", "--force", "main"]),
  ).toThrow("Stopping preserves a Delegated Worktree");
  expect(() =>
    assertNonDestructiveGitArguments(["-C", "/worktree", "checkout", "-b", "grok/task"]),
  ).not.toThrow();
});
