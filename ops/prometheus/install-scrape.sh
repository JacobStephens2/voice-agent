#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this Prometheus configuration installer as root.\n' >&2
  exit 1
fi

configuration=/etc/prometheus/prometheus.yml
backup=/etc/prometheus/prometheus.yml.pre-voice-agent
begin_marker='# BEGIN voice-agent scrape'
end_marker='# END voice-agent scrape'

verify_live_metrics() {
  local attempt voice_agent_metrics
  curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:3472/metrics | \
    grep -F 'voice_agent_monitoring_same_host 1' >/dev/null
  curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:9090/-/ready >/dev/null
  host_metrics=$(curl --fail --silent --show-error --max-time 5 \
    --get --data-urlencode 'query=node_uname_info' \
    http://127.0.0.1:9090/api/v1/query)
  if [[ $(jq '.data.result | length' <<<"$host_metrics") -lt 1 ]]; then
    printf 'Prometheus does not currently receive Agent Host node-exporter metrics.\n' >&2
    exit 1
  fi
  for attempt in {1..6}; do
    if voice_agent_metrics=$(curl --fail --silent --show-error --max-time 5 \
      --get \
      --data-urlencode 'query=voice_agent_monitoring_same_host{job="voice-agent"} == 1' \
      http://127.0.0.1:9090/api/v1/query) && \
      jq -e \
        '.status == "success" and (.data.result | length) >= 1 and all(.data.result[]; .value[1] == "1")' \
        <<<"$voice_agent_metrics" >/dev/null; then
      return 0
    fi
    if (( attempt < 6 )); then
      sleep 5
    fi
  done
  printf 'Prometheus does not currently receive healthy Voice Agent metrics.\n' >&2
  exit 1
}

if [[ ! -f $configuration ]]; then
  printf 'Prometheus configuration %s is unavailable.\n' "$configuration" >&2
  exit 1
fi
if grep -Fq "$begin_marker" "$configuration"; then
  if ! grep -Fq 'targets: ['"'"'127.0.0.1:3472'"'"']' "$configuration"; then
    printf 'Existing Voice Agent Prometheus block does not target port 3472.\n' >&2
    exit 1
  fi
  promtool check config "$configuration"
  systemctl reload prometheus
  verify_live_metrics
  exit 0
fi
if ! grep -Eq '^scrape_configs:[[:space:]]*$' "$configuration"; then
  printf 'Prometheus configuration has no scrape_configs section.\n' >&2
  exit 1
fi

[[ -f $backup ]] || install -o root -g root -m 0644 "$configuration" "$backup"
candidate=$(mktemp /etc/prometheus/.prometheus.yml.XXXXXX)
cleanup() {
  rm -f -- "$candidate"
}
trap cleanup EXIT
cp "$configuration" "$candidate"
printf '\n%s\n' "$begin_marker" >> "$candidate"
printf '  - job_name: voice-agent\n' >> "$candidate"
printf '    metrics_path: /metrics\n' >> "$candidate"
printf '    static_configs:\n' >> "$candidate"
printf '      - targets: ['"'"'127.0.0.1:3472'"'"']\n' >> "$candidate"
printf '%s\n' "$end_marker" >> "$candidate"
promtool check config "$candidate"
install -o root -g root -m 0644 "$candidate" "$configuration"
systemctl reload prometheus
verify_live_metrics
printf 'Prometheus now scrapes private Voice Agent metrics on localhost:3472.\n'
