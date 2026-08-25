#!/usr/bin/env bash
set -euo pipefail
exec 8>&-

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this promotion as root.\n' >&2
  exit 1
fi
if [[ $# -ne 1 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s <40-character-merged-commit>\n' "$0" >&2
  exit 1
fi

commit=$1
release="/opt/voice-agent/releases/$commit"
script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deployment-authority-manifest.sh
source "$script_directory/deployment-authority-manifest.sh"
# The installed set is the pinned set. A narrower list here would strand a
# reviewed unit change in the pinned authority: promoted, pinned, and never
# delivered to /etc/systemd/system.
unit_definitions=("${voice_agent_authority_units[@]}")
runtime_units=(
  voice-agent-api.service
  voice-agent-worker.service
  voice-agent-keeplore-publisher.service
  voice-agent-subagent.service
  voice-agent-broker.service
)
legacy_runtime_units=(
  voice-agent-api.service
  voice-agent-worker.service
  voice-agent-subagent.service
  voice-agent-broker.service
)
enabled_units=("${runtime_units[@]}" voice-agent-probes.timer)
# A first installation that never had a previous Release is stopped through the
# Release's own units. The Promotion resume path is recovery machinery and is
# left running so a Fresh Passkey Action can still reach the queue.
installation_units=(
  "${runtime_units[@]}" voice-agent-probes.service voice-agent-probes.timer
)
if [[ ! -f "$release/.voice-agent-release" ]] || \
  [[ $(<"$release/.voice-agent-release") != "$commit" ]]; then
  printf 'Immutable release %s is unavailable.\n' "$commit" >&2
  exit 1
fi
exec 9>/run/voice-agent-promotion.lock
flock -x 9
# shellcheck source=promotion-state.sh
source "$script_directory/promotion-state.sh"
promotion_state_initialize
promotion_state_assert_allowed "$commit" "${VOICE_AGENT_MANUAL_ROLLBACK:-0}" \
  "${VOICE_AGENT_FRESH_PASSKEY_RESUME:-0}"

previous=""
if [[ -L /opt/voice-agent/current ]]; then
  previous=$(readlink -f /opt/voice-agent/current)
  case "$previous" in
    /opt/voice-agent/releases/*) ;;
    *) printf 'Current release link is outside the release root.\n' >&2; exit 1 ;;
  esac
elif [[ -e /opt/voice-agent/current ]]; then
  printf 'Current release path is not a symbolic link.\n' >&2
  exit 1
fi

unit_backup=$(mktemp -d /run/voice-agent-unit-backup.XXXXXX)
rollback_required=false
switched=false
promotion_started=true
admission_paused=false
database=/var/lib/voice-agent/voice-agent.sqlite

# The Self-Promotion boundary. Call Admission is a durable row in the Voice
# Agent's own store, so root reaches it as the unprivileged owner of that store
# rather than through any new authority. The outgoing Release closes the gate
# and waits; the incoming Release reopens it, and only after health verification
# has passed.
self_promotion_cli() {
  local release_path=$1
  shift
  local cli="$release_path/apps/worker/src/self-promotion-cli.ts"
  if [[ ! -f $cli ]]; then return 2; fi
  runuser --user voice-agent -- /usr/bin/node --experimental-strip-types \
    "$cli" "$@" 8>&- 9>&-
}

reopen_call_admission() {
  local release_path=$1
  if [[ $admission_paused == false ]]; then return 0; fi
  if self_promotion_cli "$release_path" reopen "$database"; then
    admission_paused=false
  else
    printf 'Call Admission could not be reopened from %s; it stays closed.\n' \
      "$release_path" >&2
  fi
}

restore_unit_definitions() {
  local unit
  for unit in "${unit_definitions[@]}"; do
    if [[ -f "$unit_backup/$unit" ]]; then
      install -o root -g root -m 0644 \
        "$unit_backup/$unit" "/etc/systemd/system/$unit"
    else
      rm -f -- "/etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload
}

rollback_failed_promotion() {
  restore_unit_definitions
  if [[ $switched == true && -n $previous && -d $previous ]]; then
    ln -sfn "$previous" "$candidate"
    mv -Tf "$candidate" /opt/voice-agent/current
    if systemctl cat voice-agent-keeplore-publisher.service >/dev/null 2>&1; then
      systemctl restart voice-agent-keeplore-publisher.service
    else
      systemctl stop voice-agent-keeplore-publisher.service || true
    fi
    systemctl restart "${legacy_runtime_units[@]}"
    if systemctl cat voice-agent-probes.timer >/dev/null 2>&1; then
      systemctl restart voice-agent-probes.timer
      systemctl start voice-agent-probes.service
    else
      systemctl stop voice-agent-probes.timer voice-agent-probes.service || true
    fi
    if systemctl cat voice-agent-promotion-resume.path >/dev/null 2>&1; then
      systemctl restart voice-agent-promotion-resume.path
    else
      systemctl stop voice-agent-promotion-resume.path \
        voice-agent-promotion-resume.service || true
    fi
    "$script_directory/deployment-health.sh"
    # A healthy runtime has now been confirmed, so the callers refused during
    # the switch may come back. A restored Release that cannot be confirmed
    # leaves the gate closed: the health check above exits non-zero first.
    reopen_call_admission "$previous"
    printf 'Restored previous release %s and its service definitions.\n' \
      "$(basename "$previous")" >&2
  elif [[ $switched == true ]]; then
    rm -f -- /opt/voice-agent/current
    systemctl stop "${installation_units[@]}" || true
    printf 'No previous release existed; stopped the failed first installation.\n' >&2
  fi
}

abandon_before_switch() {
  reopen_call_admission "$previous"
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ $rollback_required == true ]]; then
    rollback_failed_promotion || true
  fi
  if [[ $promotion_started == true ]]; then
    attempt_stage=promotion
    if [[ ${VOICE_AGENT_FRESH_PASSKEY_RESUME:-0} == 1 ]]; then
      attempt_stage=fresh-passkey-resume
    elif [[ ${VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE:-0} == 1 ]]; then
      attempt_stage=deployment-authority-upgrade
    fi
    if [[ $status -eq 0 ]]; then
      promotion_state_record "$commit" "${previous:--}" succeeded \
        "$attempt_stage" "${VOICE_AGENT_MANUAL_ROLLBACK:-0}"
    else
      promotion_state_record "$commit" "${previous:--}" failed \
        "$attempt_stage" "${VOICE_AGENT_MANUAL_ROLLBACK:-0}"
    fi
  fi
  rm -rf -- "$unit_backup"
  exit "$status"
}
trap cleanup EXIT

"$script_directory/candidate-preflight.sh" "$release"

# The immutable Release exists and has passed preflight before anything about
# the running system changes, so a live call is never waited out behind a build
# that might have failed anyway.
if [[ -n $previous && -f "$previous/apps/worker/src/self-promotion-cli.ts" ]]; then
  if ! self_promotion_cli "$previous" pause "$database" "$commit" \
    "promotion:$commit"; then
    printf 'Call Admission could not be closed for Self-Promotion of %s.\n' \
      "$commit" >&2
    exit 1
  fi
  admission_paused=true
  if ! self_promotion_cli "$previous" await-safe-point "$database" \
    "${VOICE_AGENT_SAFE_POINT_OBSERVATIONS:-900}"; then
    printf 'Promotion Safe Point was not reached for %s; the prior Release stays active.\n' \
      "$commit" >&2
    abandon_before_switch
    exit 1
  fi
fi

for unit in "${unit_definitions[@]}"; do
  if [[ -f "/etc/systemd/system/$unit" ]]; then
    cp -p "/etc/systemd/system/$unit" "$unit_backup/$unit"
  fi
done
rollback_required=true
for unit in "${unit_definitions[@]}"; do
  install -o root -g root -m 0644 \
    "$script_directory/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload

backup=/var/lib/voice-agent/migration-backups/pre-"$commit".sqlite
if [[ -f $database && ! -f $backup ]]; then
  if [[ -n $previous && \
    -f $previous/packages/sqlite-store/src/database-maintenance-cli.ts ]]; then
    runuser --user voice-agent -- /usr/bin/node --experimental-strip-types \
      "$previous/packages/sqlite-store/src/database-maintenance-cli.ts" \
      backup "$database" "$backup" 8>&- 9>&-
  else
    runuser --user voice-agent -- /usr/bin/sqlite3 "$database" \
      ".backup '$backup'" 8>&- 9>&-
    if [[ $(runuser --user voice-agent -- /usr/bin/sqlite3 "$backup" \
      'PRAGMA integrity_check;' 8>&- 9>&-) != ok ]]; then
      printf 'Pre-migration SQLite backup failed integrity verification.\n' >&2
      exit 1
    fi
  fi
fi

candidate=/opt/voice-agent/.current-candidate
ln -sfn "$release" "$candidate"
mv -Tf "$candidate" /opt/voice-agent/current
switched=true
systemctl restart voice-agent-broker.service \
  voice-agent-keeplore-publisher.service voice-agent-subagent.service \
  voice-agent-api.service voice-agent-worker.service
systemctl restart voice-agent-probes.timer
systemctl start voice-agent-probes.service
systemctl restart voice-agent-promotion-resume.path

healthy=false
for _attempt in {1..20}; do
  if "$script_directory/deployment-health.sh" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ $healthy == true ]]; then
  "$script_directory/deployment-health.sh"
  systemctl enable "${enabled_units[@]}"
  rollback_required=false
  # Confirmed healthy, so the switched Release readmits Telephone Sessions.
  reopen_call_admission "$release"
  if [[ $admission_paused == true ]]; then
    printf 'Release %s is healthy but Call Admission stays closed.\n' \
      "$commit" >&2
    exit 1
  fi
  printf 'Promoted Voice Agent release %s.\n' "$commit"
  exit 0
fi

printf 'Release %s failed health verification. Final failed health probe follows.\n' \
  "$commit" >&2
"$script_directory/deployment-health.sh" || true
exit 1
