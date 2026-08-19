#!/usr/bin/env bash
#
# Promote one immutable Keeplore Release: run the contract's preflight, switch
# atomically, verify the declared health semantics, and restore the retained
# Release when verification fails.
#
# KEEPLORE_VERIFICATION_DRILL=1 forces the candidate's verification to fail so
# the owner can prove rollback. The restored Release is still verified for real,
# and no registration or health configuration is mutated.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_require_commit "${1:-}"
keeplore_load_configuration

commit=$1
release="$keeplore_release_root/$commit"
if [[ ! -f "$release/.keeplore-release" ]] || \
  [[ $(<"$release/.keeplore-release") != "$commit" ]]; then
  printf 'Immutable Keeplore Release %s is unavailable.\n' "$commit" >&2
  exit 1
fi

exec 9>/run/keeplore-promotion.lock
flock -x 9
state_directory=/var/lib/keeplore-promotions
install -d -o root -g root -m 0750 "$state_directory"
attempts="$state_directory/attempts.jsonl"

previous=""
if [[ -L $keeplore_current_link ]]; then
  previous=$(readlink -f "$keeplore_current_link")
  case "$previous" in
    "$keeplore_release_root"/*) ;;
    *) printf 'Current Keeplore Release link is outside the Release root.\n' >&2
       exit 1 ;;
  esac
elif [[ -e $keeplore_current_link ]]; then
  printf 'Current Keeplore Release path is not a symbolic link.\n' >&2
  exit 1
fi

record_attempt() {
  local result=$1 stage=$2
  printf '{"attemptedAt":"%s","application":"keeplore-production","commit":"%s","previous":"%s","result":"%s","stage":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "${previous:--}" "$result" "$stage" \
    >> "$attempts"
  chmod 0640 "$attempts"
}

switch_to() {
  local target=$1
  local candidate
  candidate="$(dirname "$keeplore_current_link")/.keeplore-candidate"
  ln -sfn "$target" "$candidate"
  mv -Tf "$candidate" "$keeplore_current_link"
  systemctl restart "$keeplore_service_unit"
}

# Preflight the candidate before anything switches.
if [[ ${KEEPLORE_VERIFICATION_DRILL:-0} == 1 && "$previous" == "$release" ]]; then
  printf 'A verification drill needs a candidate other than the serving Release.\n' >&2
  exit 2
fi
if [[ -n ${keeplore_preflight_command:-} ]]; then
  if ! runuser --user keeplore-builder -- env -i \
    HOME=/var/lib/keeplore-builder \
    PATH=/usr/local/bin:/usr/bin:/bin \
    /bin/bash -c "cd \"\$1\" && $keeplore_preflight_command" \
    keeplore-preflight "$release" 9>&-; then
    record_attempt failed preflight
    printf 'Candidate Keeplore Release %s failed the declared preflight.\n' "$commit" >&2
    exit 1
  fi
fi

switch_to "$release"
healthy=false
if [[ ${KEEPLORE_VERIFICATION_DRILL:-0} == 1 ]]; then
  printf 'Verification drill: treating Release %s as unhealthy.\n' "$commit" >&2
else
  for _attempt in {1..20}; do
    if "$script_directory/keeplore-health.sh" >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 1
  done
fi

if [[ $healthy == true ]]; then
  "$script_directory/keeplore-health.sh"
  record_attempt succeeded promotion
  "$script_directory/prune-keeplore-releases.sh" || true
  printf 'Promoted Keeplore Release %s.\n' "$commit"
  exit 0
fi

if [[ ${KEEPLORE_VERIFICATION_DRILL:-0} == 1 ]]; then
  record_attempt failed verification-drill
else
  record_attempt failed verification
fi
if [[ -n $previous && -d $previous ]]; then
  switch_to "$previous"
  if "$script_directory/keeplore-health.sh"; then
    printf 'Release %s failed verification; restored %s.\n' \
      "$commit" "$(basename "$previous")" >&2
  else
    printf 'Release %s failed verification and the restored Release is unhealthy.\n' \
      "$commit" >&2
  fi
else
  rm -f -- "$keeplore_current_link"
  systemctl stop "$keeplore_service_unit" || true
  printf 'Release %s failed verification; no prior Release existed.\n' "$commit" >&2
fi
exit 1
