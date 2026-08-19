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
install -d -o root -g root -m 0750 "$state_directory"
verified_human_merges="$state_directory/verified-human-merges.tsv"
touch "$verified_human_merges"
chmod 0640 "$verified_human_merges"

exec 8>/run/keeplore-main-promotion-queue.lock
flock -x 8

if ! "$script_directory/../release/verify-human-merge.sh" \
  "$keeplore_repository" "$commit"; then
  printf 'Commit %s is not a verified Human Merge into main of %s.\n' \
    "$commit" "$keeplore_repository" >&2
  exit 1
fi

if grep -Fxq "$commit" "$verified_human_merges"; then
  printf 'Human Merge %s was already recorded; Promotion is idempotent.\n' "$commit"
else
  printf '%s\n' "$commit" >> "$verified_human_merges"
fi

active=""
if [[ -L $keeplore_current_link ]]; then
  active=$(basename "$(readlink -f "$keeplore_current_link")")
fi
if [[ $active == "$commit" ]]; then
  printf 'Keeplore already serves Release %s.\n' "$commit"
  exit 0
fi

"$script_directory/install-keeplore-release.sh" "$commit"
"$script_directory/promote-keeplore-release.sh" "$commit"
