#!/usr/bin/env bash

# Deployment Authority Drift — what a promoted Release carries across the
# reviewed manifest that the pinned, root-owned authority under
# `/usr/local/libexec/voice-agent` is not yet running. Every reviewed file is
# compared at the pinned path the attended upgrade installs it at, which
# `voice_agent_authority_pinned_paths` decides for this reader and for the
# upgrade alike.
#
# Automatic Promotion never replaces pinned authority, and that boundary is what
# stops a merged commit from expanding root authority on the Agent Host. The
# boundary is correct; its silence is not. Without this comparison a Release is
# merged, promoted, and reported healthy while some of its reviewed content lies
# dormant, and confirming that takes a root terminal and a `cmp` per file.
#
# Drift is a normal state, not a failure. Nothing here decides an attempt's
# result, touches the consecutive-failure count, or opens the Deployment Circuit
# Breaker; it only names what the attended
# `./ops/upgrade-agent-host-deployment-authority.sh` would apply.
#
# Both functions read only the two directories they are handed and write no
# files, so the comparison that a Promotion reports can be exercised without
# root and without the live pinned-authority directory.

voice_agent_authority_drift_action=./ops/upgrade-agent-host-deployment-authority.sh
voice_agent_authority_drift_none='{"diverged":false,"paths":[]}'

# voice_agent_authority_drift_paths <release-root> <pinned-root>
#
# Print, one per line in manifest order, the pinned-relative path of every
# reviewed file whose Release content differs from the pinned copy. A file
# missing from either side diverges as surely as one whose bytes changed.
voice_agent_authority_drift_paths() {
  local release_root=$1 pinned_root=$2
  local drift_manifest_directory pinned_path reported source_path
  drift_manifest_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=deployment-authority-manifest.sh
  source "$drift_manifest_directory/deployment-authority-manifest.sh"

  # One reviewed file can be pinned for two reasons — the Human Merge verifier
  # is both promotion authority and a Keeplore tool — but at two pinned paths,
  # so each copy is compared on its own merits. This guard keeps a manifest that
  # later reached one pinned path twice from reporting it twice.
  reported=" "
  while IFS=$'\t' read -r source_path pinned_path; do
    if [[ -z $pinned_path ]]; then continue; fi
    if [[ $reported == *" $pinned_path "* ]]; then continue; fi
    reported+="$pinned_path "
    if ! cmp -s "$release_root/$source_path" "$pinned_root/$pinned_path"; then
      printf '%s\n' "$pinned_path"
    fi
  done < <(voice_agent_authority_pinned_paths)
}

# voice_agent_authority_drift_json [diverging-path...]
#
# Render the diverging paths as the bounded JSON object a Promotion Attempt
# records. With no divergence the object still appears, so "no drift" is an
# observation rather than an absence.
voice_agent_authority_drift_json() {
  local escaped path separator=""
  if [[ $# -eq 0 ]]; then
    printf '%s' "$voice_agent_authority_drift_none"
    return 0
  fi
  printf '{"action":"%s","diverged":true,"paths":[' \
    "$voice_agent_authority_drift_action"
  for path in "$@"; do
    escaped=${path//\\/\\\\}
    printf '%s"%s"' "$separator" "${escaped//\"/\\\"}"
    separator=,
  done
  printf ']}'
}

# voice_agent_authority_drift_observe <release-root> <pinned-root>
#
# Compare one tree against the pinned authority and leave the result in
# `voice_agent_authority_drift_paths_found` and
# `voice_agent_authority_drift_record` for a caller to record. Every failure
# inside it — an unreadable tree, a comparison that cannot run — leaves an empty
# observation rather than propagating, because a Promotion Attempt's result must
# never turn on what its own reporting could not read.
voice_agent_authority_drift_observe() {
  local release_root=$1 pinned_root=$2
  voice_agent_authority_drift_paths_found=()
  voice_agent_authority_drift_record=$voice_agent_authority_drift_none
  if [[ ! -d $release_root || ! -d $pinned_root ]]; then return 0; fi
  mapfile -t voice_agent_authority_drift_paths_found < <(
    voice_agent_authority_drift_paths "$release_root" "$pinned_root" 2>/dev/null
  ) || voice_agent_authority_drift_paths_found=()
  if [[ ${#voice_agent_authority_drift_paths_found[@]} -eq 0 ]]; then return 0; fi
  voice_agent_authority_drift_record=$(
    voice_agent_authority_drift_json "${voice_agent_authority_drift_paths_found[@]}"
  ) || {
    voice_agent_authority_drift_paths_found=()
    voice_agent_authority_drift_record=$voice_agent_authority_drift_none
  }
}
