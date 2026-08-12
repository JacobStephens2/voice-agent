# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `JacobStephens2/voice-agent`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When changed to `yes`, PRs run through the same labels and states as issues using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, retaining only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment, label, or close**: `gh pr comment`, `gh pr edit`, or `gh pr close`.

GitHub shares one number space across issues and PRs. Resolve an ambiguous number with `gh pr view <number>` and fall back to `gh issue view <number>`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

The Wayfinder map is a GitHub issue labelled `wayfinder:map`, with child issues representing decision tickets.

- **Map**: Create one issue with `gh issue create --label wayfinder:map`.
- **Child ticket**: Link an issue to the map using GitHub sub-issues through `gh api`. If sub-issues are unavailable, add the child to a task list in the map and place `Part of #<map>` at the beginning of the child body.
- **Ticket labels**: Use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: Use GitHub’s native issue dependencies. Add a dependency with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where the database ID comes from `gh api repos/<owner>/<repo>/issues/<number> --jq .id`.
- **Dependency fallback**: If native dependencies are unavailable, add `Blocked by: #<number>` to the child body.
- **Frontier query**: Find the map’s open child issues, then exclude tickets with an open blocker or an assignee. The first remaining ticket in map order is next.
- **Claim**: `gh issue edit <number> --add-assignee @me` must be the session’s first write.
- **Resolve**: Comment with the answer, close the ticket, and append a short linked context pointer to the map’s “Decisions so far” section.
