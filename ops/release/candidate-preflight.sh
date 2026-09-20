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
# shellcheck source=deployment-authority-manifest.sh
source "$script_directory/deployment-authority-manifest.sh"
for mapping in "${voice_agent_authority_apparmor_local_overlays[@]}"; do
  overlay=${mapping#*:}
  target_path="/etc/apparmor.d/$overlay"
  test -f "$target_path"
  cmp -s "$script_directory/apparmor/$overlay" "$target_path"
done
for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
  profile=${mapping#*:}
  target_path="/etc/apparmor.d/$profile"
  test -f "$target_path"
  cmp -s "$script_directory/apparmor/$profile" "$target_path"
  /usr/sbin/apparmor_parser -Q "$script_directory/apparmor/$profile"
done
# Every pinned unit definition is verified, so preflight coverage widens with
# the manifest instead of drifting behind it.
pinned_unit_paths=("${voice_agent_authority_units[@]/#/$script_directory/systemd/}")
systemd-analyze verify "${pinned_unit_paths[@]}"

printf 'Candidate Release %s passed static and systemd preflight.\n' "$commit"
