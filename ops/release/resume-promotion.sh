#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run the Fresh Passkey Promotion resume as root.\n' >&2
  exit 1
fi

request=/var/lib/voice-agent-promotion-resume/resume.request
repository_config=/etc/voice-agent/promotion-repository
if [[ ! -f $request || -L $request ]]; then exit 0; fi
if [[ $(stat -c %U "$request") != voice-agent ]]; then
  printf 'Promotion resume request has an invalid owner.\n' >&2
  exit 1
fi
if [[ ! -f $repository_config ]]; then
  printf 'Promotion repository configuration is unavailable.\n' >&2
  exit 1
fi

processing_request=$(mktemp /run/voice-agent-promotion-resume.XXXXXX)
rm -f -- "$processing_request"
mv "$request" "$processing_request"
cleanup() { rm -f -- "$processing_request"; }
trap cleanup EXIT
requested_commit=$(<"$processing_request")
if [[ ! $requested_commit =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Promotion resume request does not identify a commit.\n' >&2
  exit 1
fi

repository=$(<"$repository_config")
if [[ ! -d /var/lib/voice-agent-source/repository.git || \
  $(stat -c %U /var/lib/voice-agent-source/repository.git) != root ]]; then
  printf 'Root-owned Voice Agent source mirror is unavailable.\n' >&2
  exit 1
fi
exec 8>/run/voice-agent-main-promotion-queue.lock
flock -x 8
exec 9>/run/voice-agent-promotion.lock
flock -x 9
script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=promotion-state.sh
source "$script_directory/promotion-state.sh"
promotion_state_initialize
if [[ $circuit_state != open || $last_failed_commit != "$requested_commit" ]]; then
  printf 'Deployment Circuit Breaker no longer matches reviewed commit %s.\n' \
    "$requested_commit" >&2
  exit 0
fi
commit=$requested_commit
flock -u 9

if ! "$script_directory/install-release.sh" "$repository" "$commit"; then
  "$script_directory/record-promotion-failure.sh" \
    "$commit" fresh-passkey-resume-build
  exit 1
fi
VOICE_AGENT_FRESH_PASSKEY_RESUME=1 \
  "$script_directory/promote-release.sh" "$commit"
flock -u 8
"$script_directory/promote-main.sh" "$repository" --drain
printf 'Fresh Passkey Action resumed the Promotion queue at %s.\n' "$commit"
