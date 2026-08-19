#!/usr/bin/env bash
#
# The Keeplore health semantics declared by its Deployment Contract.

set -euo pipefail
exec 9>&-

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_load_configuration

systemctl is-active --quiet "$keeplore_service_unit"
test -L "$keeplore_current_link"
test -f "$(readlink -f "$keeplore_current_link")/.keeplore-release"

status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  "$keeplore_health_url" || printf '000')
if [[ $status != 200 ]]; then
  printf 'Keeplore health %s answered %s, expected 200.\n' \
    "$keeplore_health_url" "$status" >&2
  exit 1
fi
if [[ -n ${keeplore_public_health_url:-} ]]; then
  public_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    "$keeplore_public_health_url" || printf '000')
  if [[ $public_status != 200 ]]; then
    printf 'Public Keeplore health answered %s, expected 200.\n' \
      "$public_status" >&2
    exit 1
  fi
fi

printf 'Keeplore Release %s is healthy.\n' \
  "$(basename "$(readlink -f "$keeplore_current_link")")"
