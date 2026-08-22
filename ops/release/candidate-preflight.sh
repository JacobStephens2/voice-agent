#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^/opt/voice-agent/releases/[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s /opt/voice-agent/releases/<40-character-commit>\n' "$0" >&2
  exit 1
fi

release=$1
commit=$(basename "$release")
if [[ ! -f "$release/.voice-agent-release" ]] || \
  [[ $(<"$release/.voice-agent-release") != "$commit" ]]; then
  printf 'Candidate Release identity is invalid.\n' >&2
  exit 1
fi

test -f "$release/apps/pwa/dist/index.html"
test -f "$release/packages/sqlite-store/src/database-maintenance-cli.ts"
test -f "$release/apps/broker/src/probe-metrics-cli.ts"
test -f "$release/ops/grafana/voice-agent-slice-one.json"
script_directory=$(cd "$(dirname "$0")" && pwd)
systemd-analyze verify \
  "$script_directory/systemd/voice-agent-api.service" \
  "$script_directory/systemd/voice-agent-worker.service" \
  "$script_directory/systemd/voice-agent-subagent.service" \
  "$script_directory/systemd/voice-agent-broker.service" \
  "$script_directory/systemd/voice-agent-probes.service" \
  "$script_directory/systemd/voice-agent-probes.timer" \
  "$script_directory/systemd/voice-agent-promotion-resume.path" \
  "$script_directory/systemd/voice-agent-promotion-resume.service"

printf 'Candidate Release %s passed static and systemd preflight.\n' "$commit"
