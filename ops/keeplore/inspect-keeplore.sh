#!/usr/bin/env bash
#
# A read-only revalidation of the live Keeplore checkout. It never fetches,
# checks out, stashes, or writes, so the owner's uncommitted work survives.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_load_configuration

git_checkout=(git --no-optional-locks -c protocol.allow=never -C "$keeplore_live_checkout")
head_commit=$("${git_checkout[@]}" rev-parse HEAD)
branch=$("${git_checkout[@]}" rev-parse --abbrev-ref HEAD)
remote=$("${git_checkout[@]}" remote get-url origin)
uncommitted=$("${git_checkout[@]}" status --porcelain | wc -l | tr -d ' ')
active_release=none
if [[ -L $keeplore_current_link ]]; then
  active_release=$(basename "$(readlink -f "$keeplore_current_link")")
fi
health_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  "$keeplore_health_url" || printf '000')

printf 'repository\t%s\n' "$keeplore_repository"
printf 'remote\t%s\n' "$remote"
printf 'remoteRepository\t%s\n' "$(sed -E 's#(\.git)?$##; s#.*[:/]([^/]+/[^/]+)$#\1#' <<<"$remote")"
printf 'liveCheckout\t%s\n' "$keeplore_live_checkout"
printf 'productionBranch\t%s\n' "$branch"
printf 'headCommit\t%s\n' "$head_commit"
printf 'uncommittedPaths\t%s\n' "$uncommitted"
printf 'servingEdge\tapache\n'
printf 'documentRootUi\t%s\n' "${keeplore_document_root_ui:-$keeplore_live_checkout/ui}"
printf 'documentRootApi\t%s\n' "${keeplore_document_root_api:-$keeplore_live_checkout/api}"
printf 'sharedRoot\t%s\n' "$keeplore_shared_root"
printf 'sharedPaths\t%s\n' "$keeplore_shared_paths"
printf 'healthUrl\t%s\n' "$keeplore_health_url"
printf 'healthStatus\t%s\n' "$health_status"
printf 'releaseRoot\t%s\n' "$keeplore_release_root"
printf 'activeRelease\t%s\n' "$active_release"

if [[ $branch != main ]]; then
  printf 'The live checkout is on %s, not the registered production branch.\n' \
    "$branch" >&2
  exit 1
fi
remote_repository=${remote%.git}
remote_repository=${remote_repository##*[:/]}
remote_owner=${remote%.git}
remote_owner=${remote_owner%/*}
remote_owner=${remote_owner##*[:/]}
if [[ "$remote_owner/$remote_repository" != "$keeplore_repository" ]]; then
  printf 'The live checkout tracks %s, not the registered %s.\n' \
    "$remote_owner/$remote_repository" "$keeplore_repository" >&2
  printf 'If the repository was renamed, repoint it: git -C %s remote set-url origin https://github.com/%s.git\n' \
    "$keeplore_live_checkout" "$keeplore_repository" >&2
  exit 1
fi
if [[ $uncommitted -ne 0 ]]; then
  printf 'The live checkout holds %s uncommitted path(s); the owner must reconcile them first.\n' \
    "$uncommitted" >&2
  exit 2
fi
