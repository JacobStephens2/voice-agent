#!/usr/bin/env bash
#
# Count the Credential Custody Boundary stores the calling identity can reach.
#
# Run it as the identity under test - and, during enrollment, from inside a
# Grok Delegation so that the count describes a model-selected command rather
# than the operator's shell. The list of stores comes from the same module the
# executor uses, so a store added to the boundary is probed without this
# script changing. The Auth Crossing directory is not a store.
set -euo pipefail

exec /usr/bin/node --experimental-strip-types \
  /opt/voice-agent/current/apps/worker/src/grok-custody-probe.ts
