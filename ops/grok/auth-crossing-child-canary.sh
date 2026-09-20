#!/usr/bin/env bash
#
# Agent Host canary: this process, already a model-selected Bubblewrap child
# under unpriv_bwrap, cannot list or execute the Auth Crossing. Nested bwrap
# is not this probe: it can fail on audit deny capability before the file
# deny is tested. The parent runner is not this probe.
#
# Run it from a Grok contract Delegation so the child profile is the one in
# force. An attended shell that can list the 0755 directory fails this
# canary closed; that shell is not the witness.
set -euo pipefail

readonly CROSSING=/usr/local/libexec/voice-agent
readonly BROKER=$CROSSING/grok-token-broker

if ls "$CROSSING" >/dev/null 2>&1; then
  printf 'This process listed the Auth Crossing; it is not a denied Bubblewrap child.\n' >&2
  exit 1
fi
if "$BROKER" --probe >/dev/null 2>&1; then
  printf 'This process executed the Auth Crossing; it is not a denied Bubblewrap child.\n' >&2
  exit 1
fi
printf 'This process could not list or execute the Auth Crossing.\n'
