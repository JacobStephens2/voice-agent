#!/usr/bin/env bash
#
# Promote one verified Keeplore Human Merge. The commit must be the merge commit
# of a pull request into main that an authenticated human GitHub user merged.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_require_commit "${1:-}"
keeplore_load_configuration

commit=$1
state_directory=/var/lib/keeplore-promotions
install -d -o root -g voice-agent -m 0750 "$state_directory"
verified_human_merges="$state_directory/verified-human-merges.tsv"
touch "$verified_human_merges"
chmod 0640 "$verified_human_merges"

exec 8>/run/keeplore-main-promotion-queue.lock
flock -x 8

if ! GH_TOKEN=$(keeplore_github_token) \
  "$script_directory/../release/verify-human-merge.sh" \
  "$keeplore_repository" "$commit"; then
  printf 'Commit %s is not a verified Human Merge into main of %s.\n' \
    "$commit" "$keeplore_repository" >&2
  exit 1
fi

active=""
if [[ -L $keeplore_current_link ]]; then
  active=$(basename "$(readlink -f "$keeplore_current_link")")
fi
if [[ $active == "$commit" ]]; then
  printf 'Keeplore already serves Release %s; Promotion is idempotent.\n' "$commit"
  exit 0
fi

# Provenance is the merger, not the pull request's author, and merged_by is
# populated only on GET /pulls/{number}.
merge_token=$(keeplore_github_token)
merge_pull=$(curl --fail --silent --show-error --max-time 15 \
  -H 'Accept: application/vnd.github+json' \
  -H "Authorization: Bearer $merge_token" \
  "https://api.github.com/repos/$keeplore_repository/commits/$commit/pulls" \
  | jq -r --arg commit "$commit" '
      [ .[] | select(.merge_commit_sha == $commit and .merged_at != null) ][0]
      | select(. != null) | .number
    ' || true)
merge_projection=""
if [[ $merge_pull =~ ^[1-9][0-9]*$ ]]; then
  merge_projection=$(curl --fail --silent --show-error --max-time 15 \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer $merge_token" \
    "https://api.github.com/repos/$keeplore_repository/pulls/$merge_pull" \
    | jq -r 'select(.merged_by != null) | "\(.merged_by.login)\t\(.merged_at)"' \
    || true)
fi
unset merge_token

"$script_directory/install-keeplore-release.sh" "$commit"
KEEPLORE_MERGE_ACTOR=$(cut -f1 <<<"$merge_projection") \
KEEPLORE_MERGED_AT=$(cut -f2 <<<"$merge_projection") \
KEEPLORE_MERGE_SOURCE="${KEEPLORE_MERGE_SOURCE:-webhook}" \
  "$script_directory/promote-keeplore-release.sh" "$commit"

# Only a promoted Human Merge is recorded as processed, so a rolled-back merge
# stays visible to the owner instead of looking complete.
if ! grep -Fxq "$commit" "$verified_human_merges"; then
  printf '%s\n' "$commit" >> "$verified_human_merges"
fi
