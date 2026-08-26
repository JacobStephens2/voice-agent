#!/usr/bin/env bash
set -euo pipefail
exec 8>&-

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this Promotion Attempt recorder as root.\n' >&2
  exit 1
fi
if [[ $# -lt 2 || $# -gt 3 || ! $1 =~ ^[0-9a-f]{40}$ || ! $2 =~ ^[a-z-]+$ ]] || \
  [[ $# -eq 3 && $3 != --already-counted ]]; then
  printf 'Usage: %s <40-character-merged-commit> <failure-stage> [--already-counted]\n' "$0" >&2
  exit 1
fi

commit=$1
stage=$2
# --already-counted keeps a re-attempt of a commit the Deployment Circuit
# Breaker has already refused out of the consecutive-failure count, so retrying
# one blocked Human Merge cannot look like several distinct failures.
counted=1
if [[ ${3:-} == --already-counted ]]; then counted=0; fi
previous=-
if [[ -L /opt/voice-agent/current ]]; then
  previous=$(readlink -f /opt/voice-agent/current)
  case "$previous" in
    /opt/voice-agent/releases/*) ;;
    *) printf 'Current release link is outside the release root.\n' >&2; exit 1 ;;
  esac
fi

exec 9>/run/voice-agent-promotion.lock
flock -x 9
script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=promotion-state.sh
source "$script_directory/promotion-state.sh"
# shellcheck source=deployment-authority-drift.sh
source "$script_directory/deployment-authority-drift.sh"
promotion_state_initialize
# A failure recorded before any candidate exists still leaves a Release
# serving, and what it carries that the pinned authority is not running does not
# stop being true because this attempt failed. Reporting it here keeps the
# metrics describing the live host rather than resetting to "no drift" on every
# pre-candidate failure. The comparison decides nothing: it cannot change the
# recorded result or reach the Deployment Circuit Breaker.
voice_agent_authority_drift_paths_found=()
voice_agent_authority_drift_record=$voice_agent_authority_drift_none
if [[ $previous != - ]]; then
  voice_agent_authority_drift_observe "$previous" "$script_directory"
fi
promotion_state_record "$commit" "$previous" failed "$stage" 0 "$counted" \
  "$voice_agent_authority_drift_record" \
  "${#voice_agent_authority_drift_paths_found[@]}"
printf 'Recorded failed Promotion Attempt for %s at stage %s.\n' \
  "$commit" "$stage" >&2
