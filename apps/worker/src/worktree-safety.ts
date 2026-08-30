/**
 * The Git subcommands that discard work this system promised to preserve.
 *
 * Stopping a Delegation, failing one, and pausing one all leave the Delegated
 * Worktree exactly as the run left it: completed commits stay committed and
 * unfinished changes stay on disk for the next bounded run or for the owner.
 * Nothing in the executor's cleanup path may reach for one of these, so the
 * refusal lives at the one place Git is invoked rather than in a comment.
 */
const discardingSubcommands = new Set([
  "clean",
  "reset",
  "restore",
  "rm",
  "stash",
  "worktree",
]);

const forcedCheckoutOptions = new Set(["-f", "--force"]);

export function assertNonDestructiveGitArguments(
  arguments_: readonly string[],
): void {
  const subcommand = arguments_.find(
    (argument, index) =>
      !argument.startsWith("-") &&
      arguments_[index - 1] !== "-C" &&
      !argument.startsWith("--git-dir="),
  );
  if (subcommand === undefined) return;
  const options = arguments_.slice(arguments_.indexOf(subcommand) + 1);
  const discards =
    discardingSubcommands.has(subcommand) ||
    (subcommand === "checkout" &&
      options.some((option) => forcedCheckoutOptions.has(option))) ||
    (subcommand === "update-ref" && options.includes("-d")) ||
    (subcommand === "branch" &&
      options.some((option) => option === "-D" || option === "--delete"));
  if (discards) {
    throw new Error(
      `Stopping preserves a Delegated Worktree; git ${subcommand} would discard it`,
    );
  }
}
