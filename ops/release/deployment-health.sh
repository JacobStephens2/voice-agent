#!/usr/bin/env bash
set -euo pipefail
exec 8>&-
exec 9>&-

for unit in voice-agent-api.service voice-agent-worker.service \
  voice-agent-subagent.service voice-agent-broker.service; do
  systemctl is-active --quiet "$unit"
done
systemctl is-active --quiet voice-agent-promotion-resume.path
systemctl is-active --quiet voice-agent-probes.timer

test -f /opt/voice-agent/current/apps/pwa/dist/index.html
test -S /run/voice-agent-broker/broker.sock
test -S /run/voice-agent-subagent/runner.sock
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3472/healthz >/dev/null
worker_environment=$(systemctl show voice-agent-worker.service \
  --property=Environment --value)
worker_port=
for assignment in $worker_environment; do
  if [[ $assignment == VOICE_AGENT_WORKER_PORT=* ]]; then
    worker_port=${assignment#VOICE_AGENT_WORKER_PORT=}
  fi
done
if [[ ! $worker_port =~ ^[0-9]+$ ]]; then
  printf 'Voice Agent worker port is not configured.\n' >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:$worker_port/" >/dev/null
runuser --user voice-agent --group voice-broker-client -- /usr/bin/curl \
  --fail --silent --show-error --max-time 5 \
  --unix-socket /run/voice-agent-broker/broker.sock \
  http://localhost/healthz >/dev/null
runuser --user voice-agent -- /usr/bin/node --experimental-strip-types \
  /opt/voice-agent/current/packages/sqlite-store/src/database-maintenance-cli.ts \
  verify /var/lib/voice-agent/voice-agent.sqlite >/dev/null
probe_metrics=/var/lib/voice-agent-probes/probes.prom
test -f "$probe_metrics"
grep -Fx 'voice_agent_monitoring_same_host 1' "$probe_metrics" >/dev/null
probe_modified=$(stat -c %Y "$probe_metrics")
current_time=$(date +%s)
if (( current_time - probe_modified > 120 )); then
  printf 'Voice Agent application probe metrics are stale.\n' >&2
  exit 1
fi

printf 'Voice Agent API, worker, restricted Subagent, broker, explicit probes, static PWA, and SQLite health checks passed.\n'
