#!/usr/bin/env bash
#
# Agent Host canary: a Bubblewrap child stacked onto unpriv_bwrap cannot list
# or execute the Auth Crossing. The parent runner is not this probe.
#
# Run it from a Grok contract Delegation so the child profile is the one in
# force. An attended shell is not the witness for the sudoers crossing.
set -euo pipefail

readonly CROSSING=/usr/local/libexec/voice-agent
readonly BROKER=$CROSSING/grok-token-broker

if ! command -v bwrap >/dev/null; then
  printf 'bwrap is not installed; this canary cannot run.\n' >&2
  exit 1
fi

if bwrap --unshare-user --dev-bind / / -- ls "$CROSSING" >/dev/null 2>&1; then
  printf 'A Bubblewrap child listed the Auth Crossing.\n' >&2
  exit 1
fi
if bwrap --unshare-user --dev-bind / / -- "$BROKER" --probe >/dev/null 2>&1; then
  printf 'A Bubblewrap child executed the Auth Crossing.\n' >&2
  exit 1
fi
printf 'Bubblewrap child could not list or execute the Auth Crossing.\n'
