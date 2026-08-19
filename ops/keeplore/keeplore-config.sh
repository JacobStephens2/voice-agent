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
  keeplore_service_unit=
  keeplore_health_url=
  keeplore_public_health_url=
  keeplore_retained_releases=
  keeplore_build_command=
  keeplore_current_link=
  keeplore_preflight_command=
  keeplore_serving_path=
  keeplore_verification_command=
  while IFS='=' read -r key value; do
    case "$key" in
      KEEPLORE_REPOSITORY) keeplore_repository=$value ;;
      KEEPLORE_LIVE_CHECKOUT) keeplore_live_checkout=$value ;;
      KEEPLORE_RELEASE_ROOT) keeplore_release_root=$value ;;
      KEEPLORE_SOURCE_MIRROR) keeplore_source_mirror=$value ;;
      KEEPLORE_SERVICE_UNIT) keeplore_service_unit=$value ;;
      KEEPLORE_HEALTH_URL) keeplore_health_url=$value ;;
      KEEPLORE_PUBLIC_HEALTH_URL) keeplore_public_health_url=$value ;;
      KEEPLORE_RETAINED_RELEASES) keeplore_retained_releases=$value ;;
      KEEPLORE_BUILD_COMMAND) keeplore_build_command=$value ;;
      KEEPLORE_CURRENT_LINK) keeplore_current_link=$value ;;
      KEEPLORE_PREFLIGHT_COMMAND) keeplore_preflight_command=$value ;;
      KEEPLORE_SERVING_PATH) keeplore_serving_path=$value ;;
      KEEPLORE_VERIFICATION_COMMAND) keeplore_verification_command=$value ;;
      *) ;;
    esac
  done < "$keeplore_configuration"

  keeplore_release_root=${keeplore_release_root:-/opt/keeplore/releases}
  keeplore_source_mirror=${keeplore_source_mirror:-/var/lib/keeplore-source/repository.git}
  keeplore_service_unit=${keeplore_service_unit:-keeplore-api.service}
  keeplore_retained_releases=${keeplore_retained_releases:-2}
  keeplore_build_command=${keeplore_build_command:-npm ci && npm run build}
  keeplore_current_link=${keeplore_current_link:-${keeplore_release_root%/releases}/current}

  if [[ ! $keeplore_repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
    [[ $keeplore_live_checkout != /* ]] || \
    [[ $keeplore_release_root != /* ]] || \
    [[ $keeplore_health_url != http* ]] || \
    [[ $keeplore_current_link != /* ]] || \
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

keeplore_require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    printf 'Run this Keeplore release step as root.\n' >&2
    return 1
  fi
}

# A GitHub App installation token, so no host step depends on an interactive login.
keeplore_github_token() {
  local script_directory
  script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ -x "$script_directory/github-source-token.sh" ]]; then
    "$script_directory/github-source-token.sh"
  else
    "$script_directory/../release/github-source-token.sh"
  fi
}

keeplore_require_commit() {
  if [[ ! ${1:-} =~ ^[0-9a-f]{40}$ ]]; then
    printf 'A 40-character merge commit is required.\n' >&2
    return 1
  fi
}
