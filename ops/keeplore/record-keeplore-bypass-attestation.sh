#!/usr/bin/env bash
#
# Record the owner's reading of the production branch's bypass actors.
#
# GitHub discloses a ruleset's `bypass_actors` only to an actor with write
# access to the ruleset. The Voice Agent's GitHub App must never hold that, so
# no credential the Voice Agent owns can enumerate them and the collector cannot
# clear this boundary on its own (ADR-0047). The owner reads it with their own
# authenticated GitHub account, through `gh`, and this appends the result to the
# same journal so the Evidence Record carries who established it.
#
# Usage: sudo -E .../record-keeplore-bypass-attestation.sh
# `gh` must already be authenticated as the owner.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_load_configuration

if ! command -v gh >/dev/null 2>&1; then
  printf 'The owner attests bypass actors with an authenticated gh.\n' >&2
  exit 1
fi

branch=main
journal=$(keeplore_repository_policy_journal)
observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

owner_gh() {
  gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$1"
}

# Every ruleset that applies to the branch, repository and organization alike:
# bypass granted above the repository counts just as much.
ruleset_ids=$(owner_gh "repos/$keeplore_repository/rules/branches/$branch" \
  | jq -r '[.[].ruleset_id] | unique | .[]')

bypass_actors='[]'
rulesets_read=0
for ruleset_id in $ruleset_ids; do
  [[ $ruleset_id =~ ^[0-9]+$ ]] || continue
  ruleset=$(owner_gh "repos/$keeplore_repository/rulesets/$ruleset_id")
  if ! jq -e 'has("bypass_actors")' <<<"$ruleset" >/dev/null; then
    printf 'GitHub did not disclose bypass actors for ruleset %s.\n' \
      "$ruleset_id" >&2
    printf 'Attest with an account that may write the ruleset, or nothing is proven.\n' >&2
    exit 1
  fi
  rulesets_read=$((rulesets_read + 1))
  bypass_actors=$(jq -c --argjson existing "$bypass_actors" '
    $existing + [ .bypass_actors[]?
      | "\(.actor_type // "actor"):\(.actor_id // 0)" ]
    | unique | .[0:20]' <<<"$ruleset")
done
if [[ $rulesets_read -eq 0 ]]; then
  printf 'No ruleset applies to %s; there is nothing binding the branch.\n' \
    "$branch" >&2
  exit 1
fi

jq -cn \
  --argjson bypassActors "$bypass_actors" \
  --arg branch "$branch" \
  --arg observedAt "$observed_at" \
  --arg repository "$keeplore_repository" \
  --argjson rulesetsRead "$rulesets_read" \
  '{
    application: "keeplore-production",
    attestedAt: $observedAt,
    attestedBy: "owner",
    branch: $branch,
    bypassActors: $bypassActors,
    kind: "branch-bypass",
    observedAt: $observedAt,
    repository: $repository,
    rulesetsRead: $rulesetsRead
  }' >> "$journal"

printf 'Attested %s ruleset(s) on %s with %s bypass actor(s).\n' \
  "$rulesets_read" "$branch" "$(jq -r 'length' <<<"$bypass_actors")"
