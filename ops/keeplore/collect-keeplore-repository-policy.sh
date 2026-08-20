#!/usr/bin/env bash
#
# Observe Keeplore's production-branch rules and GitHub App installation with
# the Voice Agent's own GitHub credentials, and append what was seen to the
# Agent Host's repository-policy journal. The Voice Agent reads that journal as
# untrusted append-only events (ADR-0042) and turns it into its two policy
# assessments.
#
# This records only what those credentials can actually see. A ruleset's bypass
# actors are not among them: GitHub discloses them solely to an actor with write
# access to the ruleset, which the App must never hold. The owner attests those
# separately with their own account (ADR-0047).

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_load_configuration

branch=main
journal=$(keeplore_repository_policy_journal)
observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
installation_token=$(keeplore_github_token)

# The production branch's active rules. This needs only metadata read.
rules=$(keeplore_github_api \
  "repos/$keeplore_repository/rules/branches/$branch" \
  "$installation_token")

jq -cn \
  --argjson activeRules "$(jq -c '[.[].type] | unique' <<<"$rules")" \
  --arg branch "$branch" \
  --arg observedAt "$observed_at" \
  --arg repository "$keeplore_repository" \
  --argjson requiredChecks "$(jq -c '
    [ .[]
      | select(.type == "required_status_checks")
      | .parameters.required_status_checks[]?
      | .context ]
    | unique' <<<"$rules")" \
  '{
    activeRules: $activeRules,
    application: "keeplore-production",
    branch: $branch,
    kind: "branch-rules",
    observedAt: $observedAt,
    observedBy: "github-app-installation",
    repository: $repository,
    requiredChecks: $requiredChecks
  }' >> "$journal"

# The App's own granted authority. The permissions and repository selection are
# read as the App itself, which needs no repository permission at all; only the
# repository list needs the installation token.
if [[ -x "$script_directory/github-app-jwt.sh" ]]; then
  application_jwt=$("$script_directory/github-app-jwt.sh")
else
  application_jwt=$("$script_directory/../release/github-app-jwt.sh")
fi
github_app_configuration=/etc/voice-agent/github-app.conf
if [[ $(stat -c %U "$github_app_configuration") != root ]]; then
  printf 'GitHub App source configuration is not root-owned.\n' >&2
  exit 1
fi
installation_id=$(awk -F'\t' 'NR == 1 { print $2 }' "$github_app_configuration")
if [[ ! $installation_id =~ ^[0-9]+$ ]]; then
  printf 'GitHub App source configuration names no installation.\n' >&2
  exit 1
fi
installation=$(keeplore_github_api \
  "app/installations/$installation_id" "$application_jwt")
repositories=$(keeplore_github_api 'installation/repositories?per_page=20' \
  "$installation_token" \
  | jq -c '[.repositories[]?.full_name] | .[0:20]')

jq -cn \
  --arg observedAt "$observed_at" \
  --argjson permissions "$(jq -c '.permissions' <<<"$installation")" \
  --argjson repositories "$repositories" \
  --arg repositorySelection "$(jq -r '.repository_selection' <<<"$installation")" \
  '{
    application: "keeplore-production",
    kind: "github-app",
    observedAt: $observedAt,
    observedBy: "github-app-credentials",
    permissions: $permissions,
    repositories: $repositories,
    repositorySelection: $repositorySelection
  }' >> "$journal"

printf 'Recorded Keeplore repository-policy observations in %s.\n' "$journal"
