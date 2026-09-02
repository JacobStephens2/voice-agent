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
# shellcheck source=deployment-authority-drift.sh
source "$script_directory/deployment-authority-drift.sh"
# The installed set is the pinned set. A narrower list here would strand a
# reviewed unit change in the pinned authority: promoted, pinned, and never
# delivered to /etc/systemd/system.
unit_definitions=("${voice_agent_authority_units[@]}")
runtime_units=(
  voice-agent-api.service
  voice-agent-worker.service
  voice-agent-keeplore-publisher.service
  voice-agent-repository-administration.service
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
voice_agent_authority_drift_paths_found=()
voice_agent_authority_drift_record=$voice_agent_authority_drift_none
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

# The gate is one row, so any Release carrying the program can open it. Rolling
# back to a Release predating this boundary would otherwise leave admission
# closed with nothing on the host able to reopen it, so the Release that closed
# the gate is the fallback: it carries the program by construction.
reopen_call_admission() {
  local release_path
  if [[ $admission_paused == false ]]; then return 0; fi
  for release_path in "$@"; do
    if [[ -n $release_path ]] && \
      self_promotion_cli "$release_path" reopen "$database"; then
      admission_paused=false
      return 0
    fi
  done
  printf 'Call Admission could not be reopened; it stays closed.\n' >&2
}

# Every exit between closing the gate and the end of the attempt passes through
# the cleanup trap, including a failure before the switch — a unit-definition
# install, a daemon-reload, or the migration-backup integrity check. Reopening
# from one place there, rather than at each success path, is what keeps a failed
# attempt from leaving the prior, healthy Release serving with every caller
# refused. The gate still reopens only against a runtime confirmed healthy now,
# whichever Release that turns out to be.
confirm_healthy_runtime_and_reopen() {
  if [[ $admission_paused == false ]]; then return 0; fi
  if ! "$script_directory/deployment-health.sh" >/dev/null 2>&1; then
    printf 'No healthy runtime was confirmed; Call Admission stays closed.\n' >&2
    return 1
  fi
  reopen_call_admission "$(readlink -f /opt/voice-agent/current 2>/dev/null)" \
    "$previous" "$release"
  [[ $admission_paused == false ]]
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
    if systemctl cat voice-agent-repository-administration.service \
      >/dev/null 2>&1; then
      systemctl restart voice-agent-repository-administration.service
    else
      systemctl stop voice-agent-repository-administration.service || true
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
    printf 'Restored previous release %s and its service definitions.\n' \
      "$(basename "$previous")" >&2
  elif [[ $switched == true ]]; then
    rm -f -- /opt/voice-agent/current
    systemctl stop "${installation_units[@]}" || true
    printf 'No previous release existed; stopped the failed first installation.\n' >&2
  fi
}


# Deployment Authority Drift is an observation this attempt reports, not a
# verdict it reaches. Automatic Promotion never replaces the pinned, root-owned
# authority it is executing from, so a Release carrying reviewed changes under
# `ops/release/` or `ops/systemd/` leaves them dormant until the attended
# upgrade applies them. Naming them here is what keeps "live" and "live except
# for the root-pinned parts" from reading the same. The comparison cannot fail
# the attempt: every failure inside it leaves the observation empty.
observe_authority_drift() {
  local active
  voice_agent_authority_drift_paths_found=()
  voice_agent_authority_drift_record=$voice_agent_authority_drift_none
  # A first installation that failed before switching leaves nothing serving,
  # and a candidate that never became active has no dormant reviewed content to
  # report. Silence there is the honest reading.
  active=$(readlink -f /opt/voice-agent/current 2>/dev/null) || active=""
  if [[ -z $active || ! -d $active ]]; then return 0; fi
  voice_agent_authority_drift_observe "$active" "$script_directory"
  if [[ ${#voice_agent_authority_drift_paths_found[@]} -eq 0 ]]; then return 0; fi
  printf 'Release %s diverges from the pinned deployment authority at: %s\n' \
    "$(basename "$active")" "${voice_agent_authority_drift_paths_found[*]}" >&2
  printf 'Apply the reviewed changes with the attended %s; the Promotion itself is unaffected.\n' \
    "$voice_agent_authority_drift_action" >&2
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ $rollback_required == true ]]; then
    rollback_failed_promotion || true
  fi
  if ! confirm_healthy_runtime_and_reopen; then status=1; fi
  if [[ $promotion_started == true ]]; then
    attempt_stage=promotion
    if [[ ${VOICE_AGENT_FRESH_PASSKEY_RESUME:-0} == 1 ]]; then
      attempt_stage=fresh-passkey-resume
    elif [[ ${VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE:-0} == 1 ]]; then
      attempt_stage=deployment-authority-upgrade
    fi
    observe_authority_drift || true
    if [[ $status -eq 0 ]]; then
      promotion_state_record "$commit" "${previous:--}" succeeded \
        "$attempt_stage" "${VOICE_AGENT_MANUAL_ROLLBACK:-0}" 1 \
        "$voice_agent_authority_drift_record" \
        "${#voice_agent_authority_drift_paths_found[@]}"
    else
      promotion_state_record "$commit" "${previous:--}" failed \
        "$attempt_stage" "${VOICE_AGENT_MANUAL_ROLLBACK:-0}" 1 \
        "$voice_agent_authority_drift_record" \
        "${#voice_agent_authority_drift_paths_found[@]}"
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
if [[ -n $previous ]]; then
  pause_status=0
  self_promotion_cli "$previous" pause "$database" "$commit" \
    "promotion:$commit" || pause_status=$?
  if [[ $pause_status -eq 2 ]]; then
    # A prior Release built before this boundary existed carries no program to
    # close the gate with. Promoting it forward is how the host acquires one.
    printf 'Prior Release %s predates the Self-Promotion boundary; promoting without it.\n' \
      "$(basename "$previous")" >&2
  elif [[ $pause_status -ne 0 ]]; then
    printf 'Call Admission could not be closed for Self-Promotion of %s.\n' \
      "$commit" >&2
    exit 1
  else
    admission_paused=true
    # Unset lets the program's own bound apply, so the number lives in one place.
    if ! self_promotion_cli "$previous" await-safe-point "$database" \
      ${VOICE_AGENT_SAFE_POINT_OBSERVATIONS:+"$VOICE_AGENT_SAFE_POINT_OBSERVATIONS"}; then
      printf 'Promotion Safe Point was not reached for %s; the prior Release stays active.\n' \
        "$commit" >&2
      exit 1
    fi
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
  voice-agent-keeplore-publisher.service \
  voice-agent-repository-administration.service voice-agent-subagent.service \
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

printf 'Release %s failed health verification. Final failed health probe follows.\n' \
  "$commit" >&2
"$script_directory/deployment-health.sh" || true
exit 1
