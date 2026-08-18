#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this Grafana dashboard installer as root.\n' >&2
  exit 1
fi
if [[ $# -ne 1 || ! -f $1/ops/grafana/voice-agent-slice-one.json ]]; then
  printf 'Usage: %s <voice-agent-repository-root>\n' "$0" >&2
  exit 1
fi
if ! getent passwd grafana >/dev/null; then
  printf 'The existing Grafana service account is unavailable.\n' >&2
  exit 1
fi

source_dashboard=$1/ops/grafana/voice-agent-slice-one.json
dashboard_directory=/var/lib/grafana/dashboards
provisioning_directory=/etc/grafana/provisioning/dashboards
dashboard=$dashboard_directory/voice-agent-slice-one.json
provider=$provisioning_directory/voice-agent.yml
jq empty "$source_dashboard"
install -d -o grafana -g grafana -m 0755 "$dashboard_directory"
if [[ ! -d $provisioning_directory ]]; then
  install -d -o root -g grafana -m 0755 "$provisioning_directory"
fi
install -o grafana -g grafana -m 0644 "$source_dashboard" "$dashboard"
provider_candidate=$(mktemp /etc/grafana/provisioning/dashboards/.voice-agent.XXXXXX)
cleanup() {
  rm -f -- "$provider_candidate"
}
trap cleanup EXIT
printf '%s\n' \
  'apiVersion: 1' \
  'providers:' \
  '  - name: Voice Agent' \
  '    orgId: 1' \
  '    folder: Voice Agent' \
  '    type: file' \
  '    disableDeletion: true' \
  '    editable: false' \
  '    updateIntervalSeconds: 30' \
  '    options:' \
  '      path: /var/lib/grafana/dashboards' \
  > "$provider_candidate"
install -o root -g grafana -m 0644 "$provider_candidate" "$provider"
systemctl restart grafana-server.service
systemctl is-active --quiet grafana-server.service
printf 'Installed the same-host Voice Agent slice-one Grafana dashboard.\n'
