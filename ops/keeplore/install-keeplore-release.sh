#!/usr/bin/env bash
#
# Build an immutable Keeplore Release outside the live checkout from the
# root-owned source mirror. The live working tree is never used as a build root.
#
# Keeplore is PHP served from files, so a Release is linted rather than built,
# and its gitignored runtime state — database credentials, private dependencies,
# backups, logs — is linked in from the shared root. A Release therefore holds
# no secrets and a Promotion never orphans live state.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_require_commit "${1:-}"
keeplore_load_configuration

requested_commit=$1
if [[ ! -d $keeplore_source_mirror || \
  $(stat -c %U "$keeplore_source_mirror") != root ]]; then
  printf 'Root-owned Keeplore source mirror is unavailable.\n' >&2
  exit 1
fi
git_repository=(git -c protocol.allow=never -c protocol.https.allow=always \
  --git-dir="$keeplore_source_mirror")
source_remote="https://github.com/$keeplore_repository.git"
release_token=$(keeplore_github_token)
GIT_TERMINAL_PROMPT=0 GITHUB_APP_INSTALLATION_TOKEN="$release_token" \
  "${git_repository[@]}" \
  -c credential.helper= \
  -c credential.helper="$script_directory/../release/git-credential-github-app.sh" \
  -c credential.useHttpPath=true fetch --force "$source_remote" \
  +refs/heads/main:refs/remotes/origin/main
unset release_token

commit=$("${git_repository[@]}" rev-parse --verify "$requested_commit^{commit}")
if ! "${git_repository[@]}" merge-base --is-ancestor \
  "$commit" refs/remotes/origin/main; then
  printf 'Commit %s is not part of origin/main; a Human Merge is required.\n' \
    "$commit" >&2
  exit 1
fi

for shared_entry in ${keeplore_shared_paths//,/ }; do
  if [[ ! -e "$keeplore_shared_root/$shared_entry" ]]; then
    printf 'Shared Keeplore state %s is missing from %s.\n' \
      "$shared_entry" "$keeplore_shared_root" >&2
    exit 1
  fi
done

getent group keeplore-builder >/dev/null || groupadd --system keeplore-builder
id -u keeplore-builder >/dev/null 2>&1 || useradd \
  --system --gid keeplore-builder --home-dir /var/lib/keeplore-builder \
  --shell /usr/sbin/nologin keeplore-builder
install -d -o root -g root -m 0755 "$keeplore_release_root"
install -d -o keeplore-builder -g keeplore-builder -m 0750 /var/lib/keeplore-builder

release="$keeplore_release_root/$commit"
if [[ -d $release ]]; then
  printf 'Immutable Keeplore Release %s already exists.\n' "$commit"
  exit 0
fi

staging=$(mktemp -d "$keeplore_release_root/.release.XXXXXX")
cleanup() {
  if [[ -n ${staging:-} && -d $staging ]]; then rm -rf -- "$staging"; fi
}
trap cleanup EXIT
"${git_repository[@]}" archive "$commit" | tar -x -C "$staging"
chown -R keeplore-builder:keeplore-builder "$staging"
runuser --user keeplore-builder -- env -i \
  HOME=/var/lib/keeplore-builder \
  PATH=/usr/local/bin:/usr/bin:/bin \
  /bin/bash -c "cd \"\$1\" && $keeplore_build_command" \
  keeplore-builder-build "$staging"
for shared_entry in ${keeplore_shared_paths//,/ }; do
  rm -rf -- "${staging:?}/$shared_entry"
  install -d -o root -g root -m 0755 "$(dirname "$staging/$shared_entry")"
  ln -sfn "$keeplore_shared_root/$shared_entry" "$staging/$shared_entry"
done
printf '%s\n' "$commit" > "$staging/.keeplore-release"
chown -R --no-dereference root:root "$staging"
chmod -R a-w "$staging"
chmod -R a+rX "$staging"
mv "$staging" "$release"
staging=""
trap - EXIT

printf 'Installed immutable Keeplore Release %s.\n' "$commit"
