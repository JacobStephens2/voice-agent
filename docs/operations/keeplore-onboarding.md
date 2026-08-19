# Keeplore onboarding and Human Merge Promotion

Issue #12 enrolls Keeplore and proves its real deployment path with a harmless
Human Merge before any feature Delegation. ADR-0037 fixes the order: the live
working tree is reconciled and preserved first, then CI, production-branch
rules, the least-privilege GitHub App, a versioned Deployment Contract,
immutable Releases, health verification, rollback, and reconciliation are
established. Only after that may a Delegation change Keeplore.

Run the attended procedure with
[`ops/acceptance/run-keeplore-onboarding.sh`](../../ops/acceptance/run-keeplore-onboarding.sh)
on the Agent Host.

## Read-only revalidation before anything else

`ops/keeplore/inspect-keeplore.sh` revalidates the live checkout through Git
plumbing that only reads: `rev-parse HEAD`, `rev-parse --abbrev-ref HEAD`,
`remote get-url origin`, and `status --porcelain`. It never fetches, checks out,
stashes, resets, or writes. It reports the repository, production branch, head
commit, uncommitted path count, serving unit, health status, Release root, and
active Release, and exits non-zero while the working tree is dirty.

The same inspection runs inside the API through
`createNodeKeeploreLiveInspector`, so the PWA shows the owner exactly what the
host sees. Enrollment is denied while any uncommitted path remains, and denied
again if the owner's reconciliation record contradicts the live inspection.
Reconciliation is the owner's action — committing, pushing to a branch, or
stashing deliberately. Automation never resolves it.

## Fixed registration

A Fresh Passkey Action enrolls `keeplore-production` with fixed boundaries:

- repository `JacobStephens2/keeplore` and production branch `main`;
- a source-file read scope that excludes environment and secret files;
- worktree root `/var/lib/voice-agent-worktrees/keeplore`;
- permitted Subagent provider `codex`;
- verification check `keeplore-verification` running the declared command;
- deployment boundaries: live checkout, Release root `/opt/keeplore/releases`,
  source mirror `/var/lib/keeplore-source/repository.git`, and two retained
  Releases.

Voice, repository content, and an ordinary Trusted Browser Session are all
refused. The browser sends only a CSRF token and the reconciliation record; it
cannot supply a repository, path, branch, or capability.

## Production-branch rules and CI

The `main` ruleset must require a pull request, require the
`keeplore-verification` check, block force pushes, block deletion, and grant no
bypass actors — the coding agent and its GitHub App included.
`assessKeeploreBranchProtection` records each violation in the Evidence Record.

`ops/keeplore/github/keeplore-verification.yml` is the minimal CI that runs the
declared verification and reports the required check.

## Least-privilege GitHub App

`assessKeeploreGitHubAppInstallation` accepts exactly `contents: write`,
`pull_requests: write`, and `checks: read` on `JacobStephens2/keeplore` alone.
Any additional permission, any `admin` level, any administration scope, and any
unregistered repository is a violation. The App holds no ruleset bypass.

## Deployment Contract

The versioned contract is activated only by a Fresh Passkey Action and only from
`voice-agent-policy`; repository source can neither activate nor widen it.
Revisions must increase, revisions are immutable in SQLite, and the Release root
must sit inside the registered Release root and outside the live checkout.

## Promotion, verification, and rollback

`ops/keeplore/github/promote-keeplore.yml` runs on a push to `main`,
authenticates that the commit is the merge commit of a pull request merged by an
authenticated human GitHub user, and enqueues that exact commit over a
restricted SSH identity that may run only
`/usr/local/libexec/keeplore/promote-keeplore-main.sh` through passwordless
sudo. A duplicate delivery or workflow re-run promotes nothing twice: the queue
records verified merges and returns early when the commit already serves.

`install-keeplore-release.sh` builds `/opt/keeplore/releases/<commit>` from the
root-owned mirror — never from the live checkout — and makes it read-only.
`promote-keeplore-release.sh` switches `/opt/keeplore/current` atomically,
restarts the registered unit, and applies the declared health semantics. When
verification fails it restores the retained Release and records both the
attempted and restored states in `/var/lib/keeplore-promotions/attempts.jsonl`.
`prune-keeplore-releases.sh` keeps the active Release plus the retention the
contract declares, so a rollback target always exists.

## Reconciliation

`reconcile-keeplore-merges.sh` compares the GitHub `main` head with the active
Release. When they match — or the merge was already processed — it enqueues
nothing. Otherwise it promotes the missed Human Merge through the same verified
path.

## Evidence Record

The onboarding Evidence Record shows the Registered Codebase revision, the
Deployment Contract revision, both policy assessments, the Human Merge
provenance, the immutable Release, the Promotion Attempt, the health evidence,
the retained Release, and the rollback result. It contains no secrets, tokens,
raw logs, or Keeplore application data.

## Manual recovery

```
sudo /usr/local/libexec/keeplore/promote-keeplore-release.sh <previous-commit>
sudo /usr/local/libexec/keeplore/keeplore-health.sh
```
