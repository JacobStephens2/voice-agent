#!/usr/bin/env bash
#
# A short-lived GitHub App JWT signed with the root-owned private key. It
# authenticates the App as itself — enough to read the App's own installation
# and its granted permissions, and nothing about any repository.
#
# This repeats github-source-token.sh's key handling rather than refactoring it.
# setup-agent-host.sh pins the installed deployment authority and refuses to
# overwrite a script that differs from the repository's copy, so changing
# github-source-token.sh would strand a host that already runs it.

set -euo pipefail

# Managed applications may supply their own pinned App identity. Voice Agent
# releases keep the original paths when no override is present.
configuration=${VOICE_AGENT_GITHUB_APP_CONFIGURATION:-/etc/voice-agent/github-app.conf}
private_key=${VOICE_AGENT_GITHUB_APP_KEY_PATH:-/etc/voice-agent/github-app-private-key.pem}
if [[ ! -f $configuration || ! -f $private_key ]]; then
  printf 'Root-owned GitHub App source credentials are unavailable.\n' >&2
  exit 1
fi
if [[ $(stat -c %U "$private_key") != root || \
  ($(stat -c %a "$private_key") != 400 && \
  $(stat -c %a "$private_key") != 600) || \
  $(stat -c %U "$configuration") != root ]]; then
  printf 'GitHub App private key is not root-owned.\n' >&2
  exit 1
fi
IFS=$'\t' read -r github_app_id github_app_installation_id < "$configuration"
if [[ ! $github_app_id =~ ^[0-9]+$ || \
  ! $github_app_installation_id =~ ^[0-9]+$ ]]; then
  printf 'GitHub App source configuration is invalid.\n' >&2
  exit 1
fi

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

issued_at=$(($(date +%s) - 60))
expires_at=$((issued_at + 540))
header=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64url)
payload=$(printf '{"iat":%s,"exp":%s,"iss":%s}' \
  "$issued_at" "$expires_at" "$github_app_id" | base64url)
unsigned_token="$header.$payload"
signature=$(printf '%s' "$unsigned_token" \
  | openssl dgst -sha256 -sign "$private_key" -binary \
  | base64url)
printf '%s.%s' "$unsigned_token" "$signature"
