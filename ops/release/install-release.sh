#!/usr/bin/env bash
set -euo pipefail
exec 8>&-
exec 9>&-

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this installer as root.\n' >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <repository-path> <merged-commit>\n' "$0" >&2
  exit 1
fi

repository=$1
script_directory=$(cd "$(dirname "$0")" && pwd)
if [[ ! -f /etc/voice-agent/promotion-repository ]] || \
  [[ $repository != "$(</etc/voice-agent/promotion-repository)" ]]; then
  printf 'Release repository does not match the root-owned registration.\n' >&2
  exit 1
fi
voice_agent_source_mirror=/var/lib/voice-agent-source/repository.git
keeplore_source_mirror=/var/lib/keeplore-source/repository.git
voice_agent_source_remote=https://github.com/JacobStephens2/voice-agent.git
if [[ ! -d $voice_agent_source_mirror || \
  $(stat -c %U "$voice_agent_source_mirror") != root ]]; then
  printf 'Root-owned Voice Agent source mirror is unavailable.\n' >&2
  exit 1
fi
voice_agent_git_repository=(git -c protocol.allow=never \
  -c protocol.https.allow=always \
  --git-dir="$voice_agent_source_mirror")
source_token=$("$script_directory/github-source-token.sh")
GIT_TERMINAL_PROMPT=0 GITHUB_APP_INSTALLATION_TOKEN="$source_token" \
  GITHUB_APP_EXPECTED_PATH=JacobStephens2/voice-agent.git \
  "${voice_agent_git_repository[@]}" \
  -c credential.helper= \
  -c credential.helper="$script_directory/git-credential-github-app.sh" \
  -c credential.useHttpPath=true fetch --force "$voice_agent_source_remote" \
  +refs/heads/main:refs/remotes/origin/main
unset source_token
commit=$("${voice_agent_git_repository[@]}" rev-parse --verify "$2^{commit}")
if ! "${voice_agent_git_repository[@]}" merge-base --is-ancestor \
  "$commit" refs/remotes/origin/main; then
  printf 'Commit %s is not part of origin/main; a Human Merge is required.\n' "$commit" >&2
  exit 1
fi

getent group voice-agent >/dev/null || groupadd --system voice-agent
id -u voice-agent >/dev/null 2>&1 || useradd \
  --system --gid voice-agent --home-dir /nonexistent --shell /usr/sbin/nologin voice-agent
getent group voice-broker >/dev/null || groupadd --system voice-broker
getent group voice-broker-client >/dev/null || groupadd --system voice-broker-client
id -u voice-broker >/dev/null 2>&1 || useradd \
  --system --gid voice-broker --home-dir /nonexistent --shell /usr/sbin/nologin voice-broker
getent group voice-agent-builder >/dev/null || groupadd --system voice-agent-builder
id -u voice-agent-builder >/dev/null 2>&1 || useradd \
  --system --gid voice-agent-builder \
  --home-dir /var/lib/voice-agent-builder --shell /usr/sbin/nologin \
  voice-agent-builder
getent group voice-subagent-client >/dev/null || \
  groupadd --system voice-subagent-client
getent group voice-codex >/dev/null || groupadd --system voice-codex
id -u voice-codex >/dev/null 2>&1 || useradd \
  --system --gid voice-codex \
  --home-dir /var/lib/voice-codex --shell /usr/sbin/nologin \
  voice-codex
if [[ -d $keeplore_source_mirror ]]; then
  if [[ $(stat -c %U "$keeplore_source_mirror") != root ]]; then
    printf 'Keeplore source mirror is not root-owned.\n' >&2
    exit 1
  fi
  setfacl -R -m u:voice-codex:r-X "$keeplore_source_mirror"
  find "$keeplore_source_mirror" -type d \
    -exec setfacl -m d:u:voice-codex:r-X {} +
fi

install -d -o root -g root -m 0755 /opt/voice-agent /opt/voice-agent/releases
install -d -o voice-agent -g voice-agent -m 0750 /var/lib/voice-agent
install -d -o voice-agent -g voice-agent -m 0750 /var/lib/voice-agent/migration-backups
install -d -o voice-broker -g voice-broker -m 0750 /var/lib/voice-agent-broker
install -d -o root -g voice-agent -m 0750 /var/lib/voice-agent-promotions
install -d -o root -g voice-agent -m 1730 /var/lib/voice-agent-promotion-resume
install -d -o voice-agent-builder -g voice-agent-builder -m 0750 \
  /var/lib/voice-agent-builder
install -d -o voice-codex -g voice-codex -m 0700 \
  /var/lib/voice-codex /var/lib/voice-codex/.codex \
  /var/lib/voice-codex/run /var/lib/voice-codex/tmp
install -d -o voice-codex -g voice-subagent-client -m 0770 \
  /var/lib/voice-agent-worktrees/keeplore \
  /var/lib/voice-agent-worktrees/keeplore.git
install -d -o voice-codex -g voice-subagent-client -m 0750 \
  /var/lib/voice-agent-evidence

release="/opt/voice-agent/releases/$commit"
if [[ ! -d "$release" ]]; then
  staging=$(mktemp -d /opt/voice-agent/.release.XXXXXX)
  cleanup() {
    if [[ -n ${staging:-} && -d $staging ]]; then
      rm -rf -- "$staging"
    fi
  }
  trap cleanup EXIT
  "${voice_agent_git_repository[@]}" archive "$commit" | tar -x -C "$staging"
  chown -R voice-agent-builder:voice-agent-builder "$staging"
  runuser --user voice-agent-builder -- env -i \
    HOME=/var/lib/voice-agent-builder \
    COREPACK_HOME=/var/lib/voice-agent-builder/corepack \
    PATH=/usr/local/bin:/usr/bin:/bin \
    /bin/bash -c \
      'cd "$1" && corepack pnpm install --frozen-lockfile && corepack pnpm -r --if-present build' \
      voice-agent-builder-build "$staging"
  printf '%s\n' "$commit" > "$staging/.voice-agent-release"
  chown -R root:root "$staging"
  chmod -R a-w "$staging"
  chmod -R a+rX "$staging"
  mv "$staging" "$release"
  staging=""
  trap - EXIT
fi

printf 'Installed immutable Voice Agent release %s.\n' "$commit"
printf 'Promote it with: sudo %s/ops/release/promote-release.sh %s\n' "$release" "$commit"
