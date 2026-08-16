#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <owner/repository> <merge-commit>\n' "$0" >&2
  exit 2
fi

repository=$1
merge_commit=$2
if [[ ! $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
  [[ ! $merge_commit =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Repository or merge commit is malformed.\n' >&2
  exit 2
fi

pull_projection=$(gh api \
  -H 'Accept: application/vnd.github+json' \
  "repos/$repository/commits/$merge_commit/pulls")
pull_numbers=$(jq -r --arg commit "$merge_commit" '
  .[]
  | select(
      .merge_commit_sha == $commit
      and .merged_at != null
      and .base.ref == "main"
    )
  | .number
' <<<"$pull_projection")

while IFS= read -r pull_number; do
  [[ $pull_number =~ ^[1-9][0-9]*$ ]] || continue
  if gh api \
    -H 'Accept: application/vnd.github+json' \
    "repos/$repository/pulls/$pull_number" \
    | jq -e --arg commit "$merge_commit" '
        .merge_commit_sha == $commit
        and .merged_at != null
        and .base.ref == "main"
        and .merged_by.type == "User"
      ' >/dev/null; then
    exit 0
  fi
done <<<"$pull_numbers"

exit 1
