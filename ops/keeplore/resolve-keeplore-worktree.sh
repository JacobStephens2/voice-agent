#!/usr/bin/env bash
#
# Resolve one Delegated Worktree after its pull request stops being open.
#
# The pull-request state is read from GitHub rather than asserted by an
# operator, the decision comes from the Voice Agent's own policy, and the
# removal runs as the restricted runner that owns the worktree. A worktree is
# removed only when the policy says remove and the path is inside the
# registered worktree root; everything else is retained with its reason.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_load_configuration

pull_request=${1:-}
if [[ ! $pull_request =~ ^[1-9][0-9]*$ ]]; then
  printf 'Usage: %s <pull-request-number>\n' "$0" >&2
  exit 2
fi

worktree_root=/var/lib/voice-agent-worktrees/keeplore
runner_mirror=/var/lib/voice-agent-worktrees/keeplore.git

projection=$(keeplore_github_api \
  "repos/$keeplore_repository/pulls/$pull_request" "$(keeplore_github_token)" \
  | jq -r 'if .merged then "merged" elif .state == "closed" then "closed" else "open" end')
if [[ $projection != merged && $projection != closed && $projection != open ]]; then
  printf 'GitHub did not report a state for pull request %s.\n' "$pull_request" >&2
  exit 1
fi

decision=$(runuser --user voice-agent -- env -i \
  HOME=/var/lib/voice-agent \
  PATH=/usr/local/bin:/usr/bin:/bin \
  VOICE_AGENT_DATABASE_PATH=/var/lib/voice-agent/voice-agent.sqlite \
  KEEPLORE_PULL_REQUEST_STATE="$projection" \
  /usr/bin/node --experimental-strip-types \
  "${VOICE_AGENT_RELEASE:-/opt/voice-agent/current}/apps/worker/src/keeplore-worktree-lifecycle.ts")

reason=$(jq -r '.reason' <<<"$decision")
worktree_path=$(jq -r '.worktreePath' <<<"$decision")
# The observed state travels with the decision on standard output; the human
# sentence goes to standard error so a caller can consume one without the other.
emit() {
  jq -c --arg removed "$1" '. + {removed: ($removed == "true")}' <<<"$decision"
}
if [[ $(jq -r '.decision' <<<"$decision") != remove ]]; then
  printf 'Retaining %s: %s\n' "$worktree_path" "$reason" >&2
  emit false
  exit 0
fi

# The decision names a path from the durable record; the removal re-derives the
# boundary itself rather than trusting it.
case "$worktree_path" in
  "$worktree_root"/*) ;;
  *) printf 'Refusing to remove a path outside the registered worktree root.\n' >&2
     exit 1 ;;
esac
if [[ $worktree_path == *".."* ]]; then
  printf 'Refusing to remove a worktree path containing a parent reference.\n' >&2
  exit 1
fi

runuser --user voice-codex -- env -i \
  HOME=/var/lib/voice-codex \
  PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/bin/git --git-dir="$runner_mirror" worktree remove "$worktree_path"
runuser --user voice-codex -- env -i \
  HOME=/var/lib/voice-codex \
  PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/bin/git --git-dir="$runner_mirror" worktree prune
printf 'Removed %s: %s\n' "$worktree_path" "$reason" >&2
emit true
