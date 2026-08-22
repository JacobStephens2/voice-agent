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
unit_definitions=(
  voice-agent-api.service
  voice-agent-worker.service
  voice-agent-subagent.service
  voice-agent-broker.service
  voice-agent-probes.service
  voice-agent-probes.timer
)
runtime_units=(
  voice-agent-api.service
  voice-agent-worker.service
  voice-agent-subagent.service
  voice-agent-broker.service
)
enabled_units=("${runtime_units[@]}" voice-agent-probes.timer)
if [[ ! -f "$release/.voice-agent-release" ]] || \
  [[ $(<"$release/.voice-agent-release") != "$commit" ]]; then
  printf 'Immutable release %s is unavailable.\n' "$commit" >&2
  exit 1
fi
exec 9>/run/voice-agent-promotion.lock
flock -x 9
script_directory=$(cd "$(dirname "$0")" && pwd)
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
    systemctl restart "${runtime_units[@]}"
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
    printf 'Restored previous release %s and its service definitions.\n' \
      "$(basename "$previous")" >&2
  elif [[ $switched == true ]]; then
    rm -f -- /opt/voice-agent/current
    systemctl stop "${unit_definitions[@]}" || true
    printf 'No previous release existed; stopped the failed first installation.\n' >&2
  fi
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

database=/var/lib/voice-agent/voice-agent.sqlite
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
systemctl restart voice-agent-broker.service voice-agent-subagent.service \
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
  printf 'Promoted Voice Agent release %s.\n' "$commit"
  exit 0
fi

printf 'Release %s failed health verification.\n' "$commit" >&2
exit 1
