#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this rollback as root.\n' >&2
  exit 1
fi
if [[ $# -ne 1 ]]; then
  printf 'Usage: %s <previous-release-commit>\n' "$0" >&2
  exit 1
fi

script_dir=$(cd "$(dirname "$0")" && pwd)
VOICE_AGENT_MANUAL_ROLLBACK=1 exec "$script_dir/promote-release.sh" "$1"
