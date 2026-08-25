/**
 * Decide what becomes of a Delegated Worktree once its pull request closes.
 *
 * This reads the Delegation and applies the policy; it removes nothing. The
 * worktree belongs to the restricted runner and the Voice Agent has no write
 * access to it, so the removal itself is performed by the root-owned
 * `ops/keeplore/resolve-keeplore-worktree.sh` as `voice-codex` on this
 * decision. Keeping the two apart means the identity that can delete a worktree
 * never reads the Voice Agent's database to decide whether it should.
 */
import { decideKeeploreWorktreeLifecycle } from "@voice-agent/policy";
import { createSqliteKeeploreDelegationStore } from "@voice-agent/sqlite-store";

const databasePath =
  process.env.VOICE_AGENT_DATABASE_PATH ??
  "/var/lib/voice-agent/voice-agent.sqlite";
const observedState = process.env.KEEPLORE_PULL_REQUEST_STATE;
if (
  observedState !== "closed" &&
  observedState !== "merged" &&
  observedState !== "open"
) {
  process.stderr.write(
    "KEEPLORE_PULL_REQUEST_STATE must be observed from GitHub as closed, merged, or open.\n",
  );
  process.exit(2);
}

const store = createSqliteKeeploreDelegationStore(databasePath);
try {
  const latest = (await store.list()).at(-1);
  const result = latest?.delegation.result;
  if (latest === undefined || result === undefined) {
    process.stderr.write("No terminal Keeplore Button Trial Delegation exists.\n");
    process.exitCode = 1;
  } else {
    const decision = decideKeeploreWorktreeLifecycle({
      pullRequestState: observedState,
      result,
    });
    process.stdout.write(
      `${JSON.stringify({
        ...decision,
        branch: result.branch,
        delegationId: result.delegationId,
        pullRequestState: observedState,
        worktreePath: result.worktree.path,
      })}\n`,
    );
  }
} finally {
  store.close();
}
