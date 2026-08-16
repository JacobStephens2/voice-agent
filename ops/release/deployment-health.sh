#!/usr/bin/env bash
set -euo pipefail
exec 8>&-
exec 9>&-

for unit in voice-agent-api.service voice-agent-worker.service voice-agent-broker.service; do
  systemctl is-active --quiet "$unit"
done
systemctl is-active --quiet voice-agent-promotion-resume.path

test -f /opt/voice-agent/current/apps/pwa/dist/index.html
test -S /run/voice-agent-broker/broker.sock
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3472/healthz >/dev/null
curl --fail --silent --show-error --max-time 5 \
  --unix-socket /run/voice-agent-broker/broker.sock \
  http://localhost/healthz >/dev/null
runuser --user voice-agent -- /usr/bin/node --experimental-strip-types \
  /opt/voice-agent/current/packages/sqlite-store/src/database-maintenance-cli.ts \
  verify /var/lib/voice-agent/voice-agent.sqlite >/dev/null

printf 'Voice Agent API, worker, broker, static PWA, and SQLite health checks passed.\n'
