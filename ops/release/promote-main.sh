#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run the Human Merge Promotion queue as root.\n' >&2
  exit 1
fi
drain_only=false
if [[ $# -eq 2 && $2 == --drain ]]; then
  drain_only=true
elif [[ $# -ne 3 || ! $2 =~ ^[0-9a-f]{40}$ || ! $3 =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s <repository-path> <before-commit> <verified-human-merge>\n' "$0" >&2
  exit 1
fi

repository=$1
script_directory=$(cd "$(dirname "$0")" && pwd)
registered_repository=$(</etc/voice-agent/promotion-repository)
if [[ $repository != "$registered_repository" ]]; then
  printf 'Promotion repository does not match the root-owned registration.\n' >&2
  exit 1
fi
source_mirror=/var/lib/voice-agent-source/repository.git
source_remote=https://github.com/JacobStephens2/voice-agent.git
if [[ ! -d $source_mirror || $(stat -c %U "$source_mirror") != root ]]; then
  printf 'Root-owned Voice Agent source mirror is unavailable.\n' >&2
  exit 1
fi
git_repository=(git -c protocol.allow=never -c protocol.https.allow=always \
  --git-dir="$source_mirror")
"${git_repository[@]}" rev-parse --is-inside-work-tree >/dev/null
exec 8>/run/voice-agent-main-promotion-queue.lock
flock -x 8
source_token=$("$script_directory/github-source-token.sh")
GIT_TERMINAL_PROMPT=0 GITHUB_APP_INSTALLATION_TOKEN="$source_token" \
  "${git_repository[@]}" \
  -c credential.helper= \
  -c credential.helper="$script_directory/git-credential-github-app.sh" \
  -c credential.useHttpPath=true fetch --force "$source_remote" \
  +refs/heads/main:refs/remotes/origin/main
unset source_token

promotion_state_directory=/var/lib/voice-agent-promotions
verified_human_merges="$promotion_state_directory/verified-human-merges.tsv"
install -d -o root -g voice-agent -m 0750 "$promotion_state_directory"
touch "$verified_human_merges"
chown root:voice-agent "$verified_human_merges"
chmod 0640 "$verified_human_merges"
if [[ $drain_only == false ]]; then
  before_commit=$2
  verified_commit=$3
  if ! "${git_repository[@]}" cat-file -e "$before_commit^{commit}" || \
    ! "${git_repository[@]}" cat-file -e "$verified_commit^{commit}" || \
    ! "${git_repository[@]}" merge-base --is-ancestor \
      "$before_commit" "$verified_commit" || \
    ! "${git_repository[@]}" merge-base --is-ancestor \
      "$verified_commit" refs/remotes/origin/main; then
    printf 'Verified Human Merge transition %s -> %s is not part of origin/main.\n' \
      "$before_commit" "$verified_commit" >&2
    exit 1
  fi
  recorded_successor=$(awk -F '\t' -v before="$before_commit" \
    '$1 == before { print $2; exit }' "$verified_human_merges")
  if [[ -n $recorded_successor && $recorded_successor != "$verified_commit" ]]; then
    printf 'Human Merge evidence conflicts for predecessor %s.\n' \
      "$before_commit" >&2
    exit 1
  fi
  if [[ -z $recorded_successor ]]; then
    printf '%s\t%s\n' "$before_commit" "$verified_commit" \
      >> "$verified_human_merges"
  fi
fi

state=/var/lib/voice-agent-promotions/state.tsv
base=-
if [[ -f $state ]]; then
  IFS=$'\t' read -r _failures _circuit _last_failed base < "$state"
  base=${base:--}
fi
if [[ $base == - && -L /opt/voice-agent/current ]]; then
  current_release=$(readlink -f /opt/voice-agent/current)
  case "$current_release" in
    /opt/voice-agent/releases/[0-9a-f][0-9a-f]*) base=$(basename "$current_release") ;;
    *) printf 'Active Release identity is invalid.\n' >&2; exit 1 ;;
  esac
fi
if [[ ! $base =~ ^[0-9a-f]{40}$ ]] || \
  ! "${git_repository[@]}" merge-base --is-ancestor \
    "$base" refs/remotes/origin/main; then
  printf 'Promotion queue has no valid main-branch fixed point.\n' >&2
  exit 1
fi

processed=0
while true; do
  commit=$(awk -F '\t' -v before="$base" \
    '$1 == before { print $2; exit }' "$verified_human_merges")
  if [[ -z $commit ]]; then break; fi
  if ! "$script_directory/install-release.sh" "$repository" "$commit"; then
    "$script_directory/record-promotion-failure.sh" \
      "$commit" release-build
    printf 'Release build for %s failed; continuing in GitHub order.\n' \
      "$commit" >&2
  elif ! "$script_directory/promote-release.sh" "$commit"; then
    printf 'Promotion Attempt for %s failed; continuing in GitHub order.\n' \
      "$commit" >&2
  fi
  base=$commit
  processed=$((processed + 1))
done

printf 'Human Merge Promotion queue processed %s commit(s); fixed point is %s.\n' \
  "$processed" "$base"
