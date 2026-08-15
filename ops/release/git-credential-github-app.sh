#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} != get ]]; then exit 0; fi
if [[ -z ${GITHUB_APP_INSTALLATION_TOKEN:-} ]]; then
  printf 'GitHub App installation token is unavailable.\n' >&2
  exit 1
fi
while IFS= read -r line && [[ -n $line ]]; do :; done
printf 'username=x-access-token\npassword=%s\n' \
  "$GITHUB_APP_INSTALLATION_TOKEN"
