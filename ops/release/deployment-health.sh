#!/usr/bin/env bash
set -euo pipefail
exec 8>&-
exec 9>&-

for unit in voice-agent-api.service voice-agent-worker.service \
  voice-agent-keeplore-publisher.service voice-agent-subagent.service \
  voice-agent-broker.service; do
  systemctl is-active --quiet "$unit"
done
systemctl is-active --quiet voice-agent-promotion-resume.path
systemctl is-active --quiet voice-agent-probes.timer

if [[ $(</proc/sys/kernel/apparmor_restrict_unprivileged_userns) != 1 ]]; then
  printf 'AppArmor unprivileged-user-namespace restriction is not enabled.\n' >&2
  exit 1
fi
if ! grep -q '^bwrap (enforce)$' \
  /sys/kernel/security/apparmor/profiles || \
  ! grep -q '^unpriv_bwrap (enforce)$' \
    /sys/kernel/security/apparmor/profiles; then
  printf 'Bubblewrap AppArmor profile is not enforcing.\n' >&2
  exit 1
fi
release_root=
if ! release_root=$(readlink -f /opt/voice-agent/current) || \
  [[ ! $release_root =~ ^/opt/voice-agent/releases/[0-9a-f]{40}$ ]] || \
  [[ ! -d $release_root ]]; then
  printf 'Active Voice Agent release path is invalid.\n' >&2
  exit 1
fi
if ! (
  cd "$release_root"
  runuser --user voice-codex -- env -i \
    CODEX_HOME=/var/lib/voice-codex/.codex HOME=/var/lib/voice-codex \
    PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/bin/codex sandbox --permission-profile voice-agent-health \
    --cd "$release_root" \
    --config 'permissions.voice-agent-health.filesystem={":minimal" = "read", ":workspace_roots" = {"apps/worker/src/keeplore-codex-executor.ts" = "read"}}' \
    --config permissions.voice-agent-health.network.enabled=false -- \
    /usr/bin/true >/dev/null
); then
  printf 'Offline Codex sandbox health probe failed.\n' >&2
  exit 1
fi

test -f /opt/voice-agent/current/apps/pwa/dist/index.html
test -S /run/voice-agent-broker/broker.sock
test -S /run/voice-agent-subagent/runner.sock
test -S /run/voice-agent-keeplore-publisher/publisher.sock
runuser --user voice-codex --group voice-subagent-client -- /usr/bin/curl \
  --fail --silent --show-error --max-time 5 \
  --unix-socket /run/voice-agent-keeplore-publisher/publisher.sock \
  http://localhost/healthz >/dev/null
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

printf 'Voice Agent API, worker, restricted Subagent, typed Keeplore publisher, broker, explicit probes, static PWA, and SQLite health checks passed.\n'
