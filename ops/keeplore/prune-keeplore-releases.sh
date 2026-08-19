#!/usr/bin/env bash
#
# Keep the active Keeplore Release plus enough recent Releases to roll back to,
# exactly as the Deployment Contract's retention declares.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_load_configuration

active=""
if [[ -L $keeplore_current_link ]]; then
  active=$(basename "$(readlink -f "$keeplore_current_link")")
fi

kept=0
while IFS= read -r release; do
  name=$(basename "$release")
  [[ $name =~ ^[0-9a-f]{40}$ ]] || continue
  if [[ $name == "$active" ]]; then continue; fi
  kept=$((kept + 1))
  if (( kept < keeplore_retained_releases )); then continue; fi
  chmod -R u+w "$release"
  rm -rf -- "$release"
  printf 'Removed superseded Keeplore Release %s.\n' "$name"
done < <(find "$keeplore_release_root" -mindepth 1 -maxdepth 1 -type d \
  -printf '%T@\t%p\n' | sort -rn | cut -f2-)
