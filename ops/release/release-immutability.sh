#!/usr/bin/env bash

voice_agent_release_tree_is_immutable() {
  if [[ $# -ne 1 || ! -d $1 || -L $1 ]]; then return 1; fi

  local release_root unsafe_path link resolved
  release_root=$(realpath -- "$1") || return 1
  if find "$release_root" -prune -perm /022 -print >/dev/null 2>&1; then
    unsafe_path=$(find "$release_root" ! -type l -perm /022 -print -quit) ||
      return 1
  else
    unsafe_path=$(find "$release_root" ! -type l -perm +022 -print -quit) ||
      return 1
  fi
  if [[ -n $unsafe_path ]]; then return 1; fi

  while IFS= read -r -d '' link; do
    resolved=$(realpath -- "$link") || return 1
    case "$resolved" in
      "$release_root" | "$release_root"/*) ;;
      *) return 1 ;;
    esac
  done < <(find "$release_root" -type l -print0)
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -euo pipefail
  if [[ $# -ne 1 ]]; then
    printf 'Usage: %s <immutable-release-directory>\n' "$0" >&2
    exit 1
  fi
  voice_agent_release_tree_is_immutable "$1"
fi
