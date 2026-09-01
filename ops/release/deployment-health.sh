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
# Probe the sandbox under the Subagent unit's own namespace restriction. An
# attended shell can start Bubblewrap when the service cannot, so a probe run
# outside that confinement certifies an environment no Delegation ever runs in.
subagent_namespaces=$(systemctl show voice-agent-subagent.service \
  --property=RestrictNamespaces --value)
if ! systemd-run --quiet --pipe --wait --collect \
  --unit=voice-agent-codex-sandbox-health \
  --property=User=voice-codex \
  --property="RestrictNamespaces=$subagent_namespaces" \
  --working-directory="$release_root" \
  --setenv=CODEX_HOME=/var/lib/voice-codex/.codex \
  --setenv=HOME=/var/lib/voice-codex \
  --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/bin/codex sandbox --permission-profile voice-agent-health \
  --cd "$release_root" \
  --config 'permissions.voice-agent-health.filesystem={":minimal" = "read", ":workspace_roots" = {"apps/worker/src/keeplore-codex-executor.ts" = "read"}}' \
  --config permissions.voice-agent-health.network.enabled=false -- \
  /usr/bin/true >/dev/null; then
  printf 'Offline Codex sandbox health probe failed under the Subagent unit restrictions.\n' >&2
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
# The public edge, reached through Apache on the loopback so the reading does
# not depend on external DNS or reachability. A Self-Promotion that switched a
# Release the edge cannot serve must fail here rather than after admission has
# already reopened.
systemctl is-active --quiet apache2
# `--resolve` pins the connection to the loopback while curl still validates the
# certificate against the real name, so an expired or wrong certificate fails
# here rather than passing an unverified probe.
curl --fail --silent --show-error --max-time 5 \
  --resolve voice.stephens.page:443:127.0.0.1 \
  https://voice.stephens.page/ >/dev/null
# Apache proxies only `/api/`, so the proxy is proven by the authentication
# boundary answering: an unauthenticated task request must be refused, not
# unreachable. A `000` or `502` here is a dead edge, which is the failure this
# reading exists to catch.
# `|| true` keeps a dead edge reaching the comparison below: without it the
# non-zero curl exit would abort under `set -e` before the status is read.
edge_api_status=$(curl --silent --max-time 5 \
  --resolve voice.stephens.page:443:127.0.0.1 \
  --output /dev/null --write-out '%{http_code}' \
  https://voice.stephens.page/api/tasks || true)
if [[ $edge_api_status != 401 ]]; then
  printf 'Public edge returned %s for an unauthenticated task request.\n' \
    "$edge_api_status" >&2
  exit 1
fi
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
if [[ ! -S /run/voice-agent-worker/restart-witness.sock ]]; then
  printf 'Voice Agent worker identity seam is unavailable.\n' >&2
  exit 1
fi
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
