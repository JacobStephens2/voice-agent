#!/usr/bin/env bash
#
# Shared, root-owned Keeplore deployment boundaries. Sourced by every Keeplore
# release script so no caller can point Promotion at another checkout.

keeplore_load_configuration() {
  keeplore_configuration=${KEEPLORE_CONFIGURATION:-/etc/voice-agent/keeplore.conf}
  if [[ ! -f $keeplore_configuration ]]; then
    printf 'Root-owned Keeplore registration %s is unavailable.\n' \
      "$keeplore_configuration" >&2
    return 1
  fi
  if [[ $(stat -c %U "$keeplore_configuration") != root ]]; then
    printf 'Keeplore registration is not root-owned.\n' >&2
    return 1
  fi

  keeplore_repository=
  keeplore_live_checkout=
  keeplore_release_root=
  keeplore_source_mirror=
  keeplore_document_root_api=
  keeplore_document_root_ui=
  keeplore_shared_root=
  keeplore_shared_paths=
  keeplore_reload_command=
  keeplore_health_url=
  keeplore_public_health_url=
  keeplore_retained_releases=
  keeplore_build_command=
  keeplore_current_link=
  keeplore_preflight_command=
  keeplore_serving_path=
  keeplore_verification_command=
  keeplore_github_app_configuration=
  keeplore_github_app_key_path=
  while IFS='=' read -r key value; do
    case "$key" in
      KEEPLORE_REPOSITORY) keeplore_repository=$value ;;
      KEEPLORE_LIVE_CHECKOUT) keeplore_live_checkout=$value ;;
      KEEPLORE_RELEASE_ROOT) keeplore_release_root=$value ;;
      KEEPLORE_SOURCE_MIRROR) keeplore_source_mirror=$value ;;
      KEEPLORE_DOCUMENT_ROOT_API) keeplore_document_root_api=$value ;;
      KEEPLORE_DOCUMENT_ROOT_UI) keeplore_document_root_ui=$value ;;
      KEEPLORE_SHARED_ROOT) keeplore_shared_root=$value ;;
      KEEPLORE_SHARED_PATHS) keeplore_shared_paths=$value ;;
      KEEPLORE_RELOAD_COMMAND) keeplore_reload_command=$value ;;
      KEEPLORE_HEALTH_URL) keeplore_health_url=$value ;;
      KEEPLORE_PUBLIC_HEALTH_URL) keeplore_public_health_url=$value ;;
      KEEPLORE_RETAINED_RELEASES) keeplore_retained_releases=$value ;;
      KEEPLORE_BUILD_COMMAND) keeplore_build_command=$value ;;
      KEEPLORE_CURRENT_LINK) keeplore_current_link=$value ;;
      KEEPLORE_PREFLIGHT_COMMAND) keeplore_preflight_command=$value ;;
      KEEPLORE_SERVING_PATH) keeplore_serving_path=$value ;;
      KEEPLORE_VERIFICATION_COMMAND) keeplore_verification_command=$value ;;
      KEEPLORE_GITHUB_APP_CONFIGURATION) keeplore_github_app_configuration=$value ;;
      KEEPLORE_GITHUB_APP_KEY_PATH) keeplore_github_app_key_path=$value ;;
      *) ;;
    esac
  done < "$keeplore_configuration"

  keeplore_release_root=${keeplore_release_root:-/opt/keeplore/releases}
  keeplore_source_mirror=${keeplore_source_mirror:-/var/lib/keeplore-source/repository.git}
  keeplore_shared_root=${keeplore_shared_root:-/opt/keeplore/shared}
  keeplore_shared_paths=${keeplore_shared_paths:-private/environment_variables.php,private/vendor,database/backups,logs}
  keeplore_reload_command=${keeplore_reload_command:-/usr/sbin/apache2ctl graceful}
  keeplore_retained_releases=${keeplore_retained_releases:-2}
  keeplore_build_command=${keeplore_build_command:-find . -name '*.php' -not -path './vendor/*' -print0 | xargs -0 -r -n1 php -l}
  keeplore_current_link=${keeplore_current_link:-${keeplore_release_root%/releases}/current}
  keeplore_github_app_configuration=${keeplore_github_app_configuration:-/etc/voice-agent/keeplore-github-app.conf}
  keeplore_github_app_key_path=${keeplore_github_app_key_path:-/etc/voice-agent/keeplore-github-app-private-key.pem}

  if [[ ! $keeplore_repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
    [[ $keeplore_live_checkout != /* ]] || \
    [[ $keeplore_release_root != /* ]] || \
    [[ $keeplore_health_url != http* ]] || \
    [[ $keeplore_current_link != /* ]] || \
    [[ $keeplore_github_app_configuration != /* ]] || \
    [[ $keeplore_github_app_key_path != /* ]] || \
    [[ $keeplore_shared_root != /* ]] || \
    [[ ! $keeplore_retained_releases =~ ^[1-9][0-9]*$ ]]; then
    printf 'Keeplore registration is incomplete or malformed.\n' >&2
    return 1
  fi
  case "$keeplore_release_root" in
    "$keeplore_live_checkout"|"$keeplore_live_checkout"/*)
      printf 'Keeplore Release root must sit outside the live checkout.\n' >&2
      return 1
      ;;
  esac
}

# Apache serves the active Release; Keeplore has no application service unit.
keeplore_reload_edge() {
  # shellcheck disable=SC2086
  $keeplore_reload_command
}

keeplore_require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    printf 'Run this Keeplore release step as root.\n' >&2
    return 1
  fi
}

# Run a credential helper under only Keeplore's pinned App identity.
keeplore_run_github_app_helper() {
  local helper=$1 script_directory
  script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ -x "$script_directory/$helper" ]]; then
    helper="$script_directory/$helper"
  else
    helper="$script_directory/../release/$helper"
  fi
  VOICE_AGENT_GITHUB_APP_CONFIGURATION="$keeplore_github_app_configuration" \
    VOICE_AGENT_GITHUB_APP_KEY_PATH="$keeplore_github_app_key_path" \
    "$helper"
}

# A GitHub App installation token, so no host step depends on an interactive login.
keeplore_github_token() {
  keeplore_run_github_app_helper github-source-token.sh
}

# A GitHub App JWT for observing only the App identity configured for Keeplore.
keeplore_github_app_jwt() {
  keeplore_run_github_app_helper github-app-jwt.sh
}

# The Agent Host's append-only repository-policy journal. The Voice Agent may
# read it and never write it, exactly like the Promotion Attempt journal.
keeplore_repository_policy_journal() {
  local state_directory=/var/lib/keeplore-promotions
  install -d -o root -g voice-agent -m 0750 "$state_directory"
  local journal="$state_directory/repository-policy.jsonl"
  touch "$journal"
  chown root:voice-agent "$journal"
  chmod 0640 "$journal"
  printf '%s' "$journal"
}

# A GitHub read. The credential goes in on standard input, never on the command
# line, so it never appears in another account's process list.
keeplore_github_api() {
  local path=$1 credential=$2
  curl --fail --silent --show-error --max-time 15 --config - <<CONFIG
url = "https://api.github.com/$path"
header = "Accept: application/vnd.github+json"
header = "Authorization: Bearer $credential"
header = "X-GitHub-Api-Version: 2022-11-28"
CONFIG
}

keeplore_require_commit() {
  if [[ ! ${1:-} =~ ^[0-9a-f]{40}$ ]]; then
    printf 'A 40-character merge commit is required.\n' >&2
    return 1
  fi
}
