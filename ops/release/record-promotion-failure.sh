#!/usr/bin/env bash
set -euo pipefail
exec 8>&-

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this Promotion Attempt recorder as root.\n' >&2
  exit 1
fi
if [[ $# -ne 2 || ! $1 =~ ^[0-9a-f]{40}$ || ! $2 =~ ^[a-z-]+$ ]]; then
  printf 'Usage: %s <40-character-merged-commit> <failure-stage>\n' "$0" >&2
  exit 1
fi

commit=$1
stage=$2
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
promotion_state_initialize
promotion_state_record "$commit" "$previous" failed "$stage" 0
printf 'Recorded failed Promotion Attempt for %s at stage %s.\n' \
  "$commit" "$stage" >&2
