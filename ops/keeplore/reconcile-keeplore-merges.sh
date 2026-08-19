#!/usr/bin/env bash
#
# Periodic reconciliation: discover a Human Merge whose webhook never arrived,
# and stay idempotent when the merge was already processed.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_load_configuration

state_directory=/var/lib/keeplore-promotions
install -d -o root -g root -m 0750 "$state_directory"
verified_human_merges="$state_directory/verified-human-merges.tsv"
touch "$verified_human_merges"
chmod 0640 "$verified_human_merges"

head_commit=$(curl --fail --silent --show-error --max-time 15 \
  -H 'Accept: application/vnd.github+json' \
  -H "Authorization: Bearer $(keeplore_github_token)" \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "https://api.github.com/repos/$keeplore_repository/commits/main" \
  | jq -er '.sha')
if [[ ! $head_commit =~ ^[0-9a-f]{40}$ ]]; then
  printf 'GitHub did not report a main-branch head commit.\n' >&2
  exit 1
fi

active=""
if [[ -L $keeplore_current_link ]]; then
  active=$(basename "$(readlink -f "$keeplore_current_link")")
fi
if [[ $head_commit == "$active" ]]; then
  printf 'Reconciliation found no missed Keeplore Human Merge.\n'
  exit 0
fi
if grep -Fxq "$head_commit" "$verified_human_merges"; then
  printf 'Human Merge %s was already processed but is not serving; leaving it for review.\n' \
    "$head_commit" >&2
  exit 0
fi
attempts="$state_directory/attempts.jsonl"
if [[ -f $attempts ]] && \
  grep -F "\"commit\":\"$head_commit\"" "$attempts" \
  | grep -Fq '"result":"failed"'; then
  printf 'Human Merge %s has a recorded failed Promotion Attempt; it needs owner review.\n' \
    "$head_commit" >&2
  exit 0
fi

printf 'Reconciling missed Keeplore Human Merge %s.\n' "$head_commit"
"$script_directory/promote-keeplore-main.sh" "$head_commit"
