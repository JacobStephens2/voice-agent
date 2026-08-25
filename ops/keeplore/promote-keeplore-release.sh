#!/usr/bin/env bash
#
# Promote one immutable Keeplore Release: run the contract's preflight, switch
# atomically behind Apache, verify the declared health semantics, and restore
# the retained Release when verification fails.
#
# KEEPLORE_VERIFICATION_DRILL=1 forces the candidate's verification to fail so
# the owner can prove rollback. The restored Release is still verified for real,
# and no registration or health configuration is mutated.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_require_commit "${1:-}"
keeplore_load_configuration

commit=$1
release="$keeplore_release_root/$commit"
if [[ ! -f "$release/.keeplore-release" ]] || \
  [[ $(<"$release/.keeplore-release") != "$commit" ]]; then
  printf 'Immutable Keeplore Release %s is unavailable.\n' "$commit" >&2
  exit 1
fi

exec 9>/run/keeplore-promotion.lock
flock -x 9
state_directory=/var/lib/keeplore-promotions
install -d -o root -g voice-agent -m 0750 "$state_directory"
attempts="$state_directory/attempts.jsonl"

previous=""
if [[ -L $keeplore_current_link ]]; then
  previous=$(readlink -f "$keeplore_current_link")
  case "$previous" in
    "$keeplore_release_root"/*) ;;
    *) printf 'Current Keeplore Release link is outside the Release root.\n' >&2
       exit 1 ;;
  esac
elif [[ -e $keeplore_current_link ]]; then
  printf 'Current Keeplore Release path is not a symbolic link.\n' >&2
  exit 1
fi

# One append-only line per Promotion Attempt. The Voice Agent projects these
# into the onboarding Evidence Record, so the line carries the Release identity,
# the verification statuses, the restored Release, and any merge provenance.
record_attempt() {
  local result=$1 stage=$2 restored=${3:-} previous_commit
  previous_commit=$(basename "${previous:--}")
  {
    printf '{"attemptedAt":"%s","application":"keeplore-production"' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ -n ${KEEPLORE_CHECKS:-} ]]; then
      printf ',"checks":%s' "$KEEPLORE_CHECKS"
    fi
    printf ',"commit":"%s"' "$commit"
    printf ',"contractRevision":%s' "$keeplore_contract_revision"
    printf ',"previous":"%s"' "$previous_commit"
    printf ',"release":{"id":"keeplore-production-%s","path":"%s"}' \
      "$commit" "$release"
    if [[ -n ${KEEPLORE_MERGE_ACTOR:-} && -n ${KEEPLORE_MERGED_AT:-} ]]; then
      printf ',"merge":{"actor":"%s","mergedAt":"%s","source":"%s"}' \
        "$KEEPLORE_MERGE_ACTOR" "$KEEPLORE_MERGED_AT" \
        "${KEEPLORE_MERGE_SOURCE:-webhook}"
    fi
    if [[ -n ${health_actual_status:-} ]]; then
      printf ',"verification":{"actualStatus":%s' "$health_actual_status"
      if [[ -n ${appearance_verdict:-} ]]; then
        printf ',"appearance":%s' "$appearance_verdict"
      fi
      printf ',"expectedStatus":200}'
    fi
    printf ',"restored":"%s","result":"%s","stage":"%s"}\n' \
      "$restored" "$result" "$stage"
  } >> "$attempts"
  chmod 0640 "$attempts"
  chown root:voice-agent "$attempts" 2>/dev/null || true
}

switch_to() {
  local target=$1
  local candidate
  candidate="$(dirname "$keeplore_current_link")/.keeplore-candidate"
  ln -sfn "$target" "$candidate"
  mv -Tf "$candidate" "$keeplore_current_link"
  keeplore_reload_edge
}

# Preflight the candidate before anything switches.
if [[ ${KEEPLORE_VERIFICATION_DRILL:-0} == 1 && "$previous" == "$release" ]]; then
  printf 'A verification drill needs a candidate other than the serving Release.\n' >&2
  exit 2
fi
if [[ -n ${keeplore_preflight_command:-} ]]; then
  if ! runuser --user keeplore-builder -- env -i \
    HOME=/var/lib/keeplore-builder \
    PATH=/usr/local/bin:/usr/bin:/bin \
    /bin/bash -c "cd \"\$1\" && $keeplore_preflight_command" \
    keeplore-preflight "$release" 9>&-; then
    record_attempt failed preflight
    printf 'Candidate Keeplore Release %s failed the declared preflight.\n' "$commit" >&2
    exit 1
  fi
fi

# The retained Release is the only honest baseline for "card view is
# unchanged": measuring the candidate against itself proves nothing.
if [[ $keeplore_appearance_verification == 1 ]]; then
  if [[ -z $previous || ! -d $previous ]]; then
    record_attempt failed appearance-baseline
    printf 'Appearance verification needs a serving Release to compare against.\n' >&2
    exit 1
  fi
  if ! appearance_baseline=$(printf '{"mode":"baseline"}' \
    | keeplore_run_production_verifier); then
    record_attempt failed appearance-baseline
    printf 'Keeplore appearance baseline could not be captured.\n' >&2
    exit 1
  fi
  baseline_card_hash=$(jq -er '.cardHash' <<<"$appearance_baseline")
fi

switch_to "$release"
healthy=false
if [[ ${KEEPLORE_VERIFICATION_DRILL:-0} == 1 ]]; then
  printf 'Verification drill: treating Release %s as unhealthy.\n' "$commit" >&2
else
  for _attempt in {1..20}; do
    if "$script_directory/keeplore-health.sh" >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 1
  done
fi

if [[ $healthy == true ]]; then
  "$script_directory/keeplore-health.sh"
  health_actual_status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    "$keeplore_health_url" || printf '0')
  # A Release can answer 200 while serving the stylesheet it was meant to
  # change, so health alone never completes a Promotion that asked for
  # appearance verification.
  if [[ $keeplore_appearance_verification == 1 ]]; then
    evidence_directory=$(keeplore_production_evidence_directory "$commit")
    # The verifier writes its screenshots here as voice-agent, so the directory
    # is owned by the identity that fills it rather than by the promoter.
    install -d -o voice-agent -g voice-agent -m 0750 \
      /var/lib/voice-agent-evidence/keeplore-production "$evidence_directory"
    # curl reports 000 for a connection it never completed, which is not a JSON
    # number; health already passed here, so anything else is recorded as 0.
    [[ $health_actual_status =~ ^[1-9][0-9]{2}$ ]] || health_actual_status=0
    appearance_status=0
    appearance_report=$(jq -nc \
      --arg baseline "$baseline_card_hash" \
      --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg commit "$commit" \
      --argjson actual "$health_actual_status" \
      '{
        baselineCardHash: $baseline,
        health: { actualStatus: $actual, expectedStatus: 200 },
        mode: "verify",
        observedAt: $observedAt,
        releaseCommit: $commit
      }' | keeplore_run_production_verifier) || appearance_status=$?
    appearance_verdict=$(jq -ce '.verdict' <<<"${appearance_report:-}" 2>/dev/null || printf '')
    if [[ -n ${appearance_report:-} ]]; then
      printf '%s' "$appearance_report" > "$evidence_directory/appearance.json"
      chown voice-agent:voice-agent "$evidence_directory/appearance.json"
      chmod 0640 "$evidence_directory/appearance.json"
    fi
    if [[ $appearance_status -ne 0 || -z $appearance_verdict || \
      $appearance_verdict == null ]]; then
      # An unreadable verdict is a failed one; nothing else may complete here.
      appearance_verdict=${appearance_verdict:-'{"failures":["Production appearance verification did not report a verdict"],"outcome":"failed"}'}
      healthy=false
    fi
  fi
fi

if [[ $healthy == true ]]; then
  record_attempt succeeded promotion
  "$script_directory/prune-keeplore-releases.sh" || true
  printf 'Promoted Keeplore Release %s.\n' "$commit"
  exit 0
fi

restored_commit=""
if [[ -n $previous && -d $previous ]]; then
  restored_commit=$(basename "$previous")
fi
if [[ ${KEEPLORE_VERIFICATION_DRILL:-0} == 1 ]]; then
  record_attempt failed verification-drill "$restored_commit"
elif [[ ${appearance_verdict:-} == *'"outcome":"failed"'* ]]; then
  record_attempt failed appearance-verification "$restored_commit"
else
  record_attempt failed verification "$restored_commit"
fi
if [[ -n $previous && -d $previous ]]; then
  switch_to "$previous"
  if "$script_directory/keeplore-health.sh"; then
    printf 'Release %s failed verification; restored %s.\n' \
      "$commit" "$(basename "$previous")" >&2
  else
    printf 'Release %s failed verification and the restored Release is unhealthy.\n' \
      "$commit" >&2
  fi
else
  rm -f -- "$keeplore_current_link"
  keeplore_reload_edge || true
  printf 'Release %s failed verification; no prior Release existed.\n' "$commit" >&2
fi
if [[ -n ${appearance_verdict:-} ]]; then
  printf 'Production appearance verification reported: %s\n' \
    "$(jq -r '.failures | join("; ")' <<<"$appearance_verdict")" >&2
fi
exit 1
