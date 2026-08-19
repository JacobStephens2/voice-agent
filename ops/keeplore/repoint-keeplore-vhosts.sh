#!/usr/bin/env bash
#
# Repoint Keeplore's Apache document roots at the active Release, so Promotion
# is an atomic symlink swap instead of an edit inside the live checkout.
#
# The cutover is reversible: the previous vhost files are backed up and restored
# when configtest, the graceful reload, or the health check fails.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_load_configuration

if [[ ! -L $keeplore_current_link ]]; then
  printf 'No active Keeplore Release to serve; promote one first.\n' >&2
  exit 1
fi

sites=/etc/apache2/sites-available
backup_directory=/var/lib/keeplore-promotions/vhost-backups
install -d -o root -g root -m 0750 "$backup_directory"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
changed=()

restore_vhosts() {
  local file
  for file in "${changed[@]}"; do
    install -o root -g root -m 0644 \
      "$backup_directory/$(basename "$file").$stamp" "$file"
  done
  /usr/sbin/apache2ctl configtest && keeplore_reload_edge
}

repoint() {
  local file=$1 from=$2 to=$3
  if [[ ! -f $file ]]; then
    printf 'Keeplore vhost %s is missing.\n' "$file" >&2
    exit 1
  fi
  if ! grep -Fq "$from" "$file"; then
    printf 'Keeplore vhost %s does not serve %s; leaving it alone.\n' "$file" "$from"
    return
  fi
  cp -p "$file" "$backup_directory/$(basename "$file").$stamp"
  changed+=("$file")
  sed -i "s#$from#$to#g" "$file"
  printf 'Repointed %s at %s.\n' "$(basename "$file")" "$to"
}

for suffix in "" -le-ssl; do
  repoint "$sites/keeplore.app$suffix.conf" \
    "$keeplore_live_checkout/ui" "$keeplore_current_link/ui"
  repoint "$sites/api.keeplore.app$suffix.conf" \
    "$keeplore_live_checkout/api" "$keeplore_current_link/api"
done

if (( ${#changed[@]} == 0 )); then
  printf 'Keeplore vhosts already serve the active Release.\n'
  exit 0
fi

if ! /usr/sbin/apache2ctl configtest; then
  printf 'Apache rejected the repointed Keeplore vhosts; restoring.\n' >&2
  restore_vhosts
  exit 1
fi
keeplore_reload_edge
if ! "$script_directory/keeplore-health.sh"; then
  printf 'Keeplore was unhealthy after the cutover; restoring the previous vhosts.\n' >&2
  restore_vhosts
  exit 1
fi

printf 'Keeplore now serves the active Release through %s.\n' "$keeplore_current_link"
