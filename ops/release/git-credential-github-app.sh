#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != get ]]; then exit 0; fi
if [[ -z ${GITHUB_APP_INSTALLATION_TOKEN:-} ]]; then
  printf 'GitHub App installation token is unavailable.\n' >&2
  exit 1
fi
if [[ ${GITHUB_APP_EXPECTED_PATH:-} != JacobStephens2/voice-agent.git && \
      ${GITHUB_APP_EXPECTED_PATH:-} != JacobStephens2/keeplore.git ]]; then
  printf 'GitHub App credential boundary is unavailable.\n' >&2
  exit 1
fi
protocol=
host=
path=
while IFS= read -r line && [[ -n $line ]]; do
  case "$line" in
    protocol=*) protocol=${line#protocol=} ;;
    host=*) host=${line#host=} ;;
    path=*) path=${line#path=} ;;
  esac
done
if [[ $protocol != https || $host != github.com || \
      $path != "$GITHUB_APP_EXPECTED_PATH" ]]; then
  printf 'GitHub App credential request is outside its registered repository.\n' >&2
  exit 1
fi
printf 'username=x-access-token\npassword=%s\n' \
  "$GITHUB_APP_INSTALLATION_TOKEN"
