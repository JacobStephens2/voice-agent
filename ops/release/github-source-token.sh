#!/usr/bin/env bash
set -euo pipefail

configuration=/etc/voice-agent/github-app.conf
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
IFS=$'\t' read -r app_id installation_id < "$configuration"
if [[ ! $app_id =~ ^[0-9]+$ || ! $installation_id =~ ^[0-9]+$ ]]; then
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
  "$issued_at" "$expires_at" "$app_id" | base64url)
unsigned_token="$header.$payload"
signature=$(printf '%s' "$unsigned_token" \
  | openssl dgst -sha256 -sign "$private_key" -binary \
  | base64url)
jwt="$unsigned_token.$signature"

response=$(curl --fail --silent --show-error --max-time 15 \
  --config - <<CONFIG
url = "https://api.github.com/app/installations/$installation_id/access_tokens"
request = "POST"
header = "Accept: application/vnd.github+json"
header = "Authorization: Bearer $jwt"
header = "X-GitHub-Api-Version: 2022-11-28"
CONFIG
)
printf '%s' "$response" | jq -er '.token'
