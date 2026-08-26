#!/usr/bin/env bash
#
# Re-verify one Keeplore Human Merge that production is already serving.
#
# Ordinary Promotion is idempotent: a commit already serving exits without
# switching. That guard is what makes a duplicate webhook and a reconciliation
# pass safe, and it is also why a Promotion can never verify a merge that
# reached production before appearance verification existed — there is no
# retained Release to take a baseline from, so nothing is measured.
#
# This is the supported way to verify such a merge anyway, and the only one:
# step production back to the Release the merge replaced, promote the merge
# commit again through the same recorded path, and record both moves as
# Promotion Attempts. It never edits the serving symlink by hand, so it leaves
# no unrecorded production state behind. It is an attended operation and is
# never reached by a webhook, a reconciliation pass, or the Voice Agent.

set -euo pipefail

script_directory=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=keeplore-config.sh
source "$script_directory/keeplore-config.sh"
keeplore_require_root
keeplore_require_commit "${1:-}"
keeplore_load_configuration

commit=$1

# One re-promotion at a time: two overlapping runs would each read the other's
# half-finished production state as the Release a merge replaced. The lock is
# held for the whole run and closed in every child, so a process a preflight
# leaves behind cannot keep the next re-promotion out.
exec 7>/run/keeplore-repromotion.lock
if ! flock -n -x 7; then
  printf 'Another Keeplore re-promotion is already running.\n' >&2
  exit 1
fi

serving_commit() {
  if [[ -L $keeplore_current_link ]]; then
    basename "$(readlink -f "$keeplore_current_link")"
  fi
}

# Every exit that is not a completed re-verification says which Release
# production is on and whether it is answering, because the operator's next
# decision depends on that and on nothing else.
report_serving() {
  local serving
  serving=$(serving_commit)
  if "$script_directory/keeplore-health.sh" >/dev/null 2>&1; then
    printf 'Production serves Keeplore Release %s and is healthy.\n' \
      "${serving:-none}" >&2
  else
    printf 'Production serves Keeplore Release %s and is NOT healthy.\n' \
      "${serving:-none}" >&2
  fi
}

# A re-promotion exists to produce an appearance verdict for a merge that never
# got one. Under a Deployment Contract revision that does not ask for one it
# would spend the window switching production twice to learn nothing.
if [[ $keeplore_appearance_verification != 1 ]]; then
  printf 'The active Deployment Contract revision does not verify appearance; a re-promotion would produce no verdict.\n' >&2
  exit 1
fi

if [[ $(serving_commit) != "$commit" ]]; then
  printf 'Keeplore serves %s, not %s: only a merge already serving is re-promoted.\n' \
    "$(serving_commit)" "$commit" >&2
  printf 'A merge that is not serving is promoted normally.\n' >&2
  exit 1
fi

# Refused before anything moves. Discovering this after the step back would
# leave production on the retained Release for a merge that was never
# authorized to be promoted at all.
if ! keeplore_verify_human_merge "$commit"; then
  printf 'Commit %s is not a verified Human Merge into %s of %s.\n' \
    "$commit" "$keeplore_production_branch" "$keeplore_repository" >&2
  exit 1
fi

retained=$(keeplore_retained_release_commit "$commit")
if [[ ! $retained =~ ^[0-9a-f]{40}$ ]] || [[ $retained == "$commit" ]]; then
  printf 'No recorded Promotion of %s names the Release it replaced; there is nothing to step back to.\n' \
    "$commit" >&2
  exit 1
fi
if ! keeplore_immutable_release "$retained"; then
  printf 'Retained Release %s is no longer on disk; there is nothing to step back to.\n' \
    "$retained" >&2
  printf 'Verify the next Keeplore Human Merge instead.\n' >&2
  exit 1
fi
if ! keeplore_immutable_release "$commit"; then
  printf 'Immutable Keeplore Release %s is unavailable; it cannot be promoted again.\n' \
    "$commit" >&2
  exit 1
fi

window=$keeplore_repromotion_window_seconds
# The window is the whole time production serves the retained Release, so the
# restore that ends a failed run has to be paid for out of it rather than added
# to it. A third of the window is reserved for that restore, which is what makes
# the number below a bound on the run and not just on its happy path.
if [[ ! $window =~ ^[1-9][0-9]*$ ]] || (( window < 180 || window > 3600 )); then
  printf 'The declared re-promotion window of %s seconds is outside the supported 180 to 3600.\n' \
    "$window" >&2
  exit 1
fi
restore_reserve=$(( window / 3 ))

printf 'Re-promoting Keeplore Human Merge %s to verify what it renders in production.\n' \
  "$commit"
printf 'Production will serve retained Release %s from the step back until %s is promoted again: at most %s seconds, of which %s are reserved to restore %s if the Promotion fails.\n' \
  "$retained" "$commit" "$window" "$restore_reserve" "$commit"
printf 'Both moves are recorded as Promotion Attempts. A failure inside that window leaves production on a healthy Release and this run reports which one.\n'

deadline=$(( $(date +%s) + window ))
step_back_status=0
KEEPLORE_REPROMOTION_KIND=step-back \
KEEPLORE_REPROMOTION_MERGE_COMMIT="$commit" \
  "$script_directory/promote-keeplore-release.sh" "$retained" 7>&- \
  || step_back_status=$?
if [[ $step_back_status -ne 0 ]]; then
  printf 'The step back to retained Release %s failed; %s was not re-verified.\n' \
    "$retained" "$commit" >&2
  report_serving
  exit 1
fi

# The window is a bound, not a hope. It is spent on the phases that run while
# production is still on the retained Release — the preflight and the appearance
# baseline — so the Promotion is given a deadline it must switch before rather
# than a signal that could cut it in half. Once it has switched, the window is
# over and the Promotion runs to completion: a Promotion killed between
# switching and recording its attempt would leave production somewhere the
# journal does not know about.
candidate_status=0
KEEPLORE_REPROMOTION_KIND=candidate \
KEEPLORE_REPROMOTION_MERGE_COMMIT="$commit" \
KEEPLORE_MERGE_SOURCE=attended \
KEEPLORE_SWITCH_DEADLINE=$(( deadline - restore_reserve )) \
  "$script_directory/promote-keeplore-main.sh" "$commit" 7>&- \
  || candidate_status=$?

if [[ $candidate_status -eq 0 ]]; then
  if [[ $(serving_commit) == "$commit" ]]; then
    printf 'Re-promoted and re-verified Keeplore Human Merge %s.\n' "$commit"
    exit 0
  fi
  # A Promotion that reported success without leaving production on the merge
  # commit is not a completed re-verification, whatever it recorded.
  printf 'The Promotion of %s reported success but production does not serve it.\n' \
    "$commit" >&2
fi

printf 'Re-verifying %s did not complete; it is not verified in production.\n' \
  "$commit" >&2

# Whatever went wrong, this run does not walk away leaving production somewhere
# other than the Release it found it on. The restore is itself a recorded,
# health-verified Promotion Attempt; it is not a symlink edit. It is attempted
# for any serving Release that is not the merge commit, not only the retained
# one, because the promoter's own rollback has more than one landing place.
if [[ $(serving_commit) != "$commit" ]]; then
  printf 'Restoring Release %s so production does not stay off the merge commit.\n' \
    "$commit" >&2
  restore_status=0
  KEEPLORE_REPROMOTION_KIND=restore \
  KEEPLORE_REPROMOTION_MERGE_COMMIT="$commit" \
    "$script_directory/promote-keeplore-release.sh" "$commit" 7>&- \
    || restore_status=$?
  if [[ $restore_status -ne 0 ]]; then
    # The promoter restored the Release it found serving, which is healthy and
    # is named below. The merge stays unverified either way.
    printf 'Restoring Release %s failed.\n' "$commit" >&2
  fi
fi
report_serving
exit 1
