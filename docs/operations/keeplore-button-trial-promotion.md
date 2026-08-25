# Promoting and verifying the Keeplore Button Trial

Issue #13 ends with a reviewed Keeplore pull request and a preserved Delegated
Worktree. Issue #14 is everything after the owner accepts it. Run the attended
procedure on the Agent Host:

```bash
cd /opt/voice-agent/current
./ops/acceptance/run-keeplore-button-trial-promotion.sh
```

Nothing in this procedure can be started by the Subagent. Pushing the assigned
branch and opening the pull request are the Administrative Publisher App's whole
authority; the App cannot merge, and a push, an opened pull request, or a merge
recorded against a bot is denied with evidence and enqueues no Promotion
Attempt. Only an authenticated human merging into Keeplore's registered
production branch authorizes Promotion, and only of that exact merge commit.

## What the Promotion does

`promote-keeplore-main.sh` re-verifies the commit is a Human Merge and records
the merger and merge time. Before anything is built it reads the check runs
GitHub reports for that merge commit and refuses unless the registered required
check — `KEEPLORE_REQUIRED_CHECK`, `keeplore-verification` by default — is
recorded as `success`. Every check it saw, and the active Deployment Contract
revision, are written onto the Promotion Attempt. It then installs an immutable
Release under the Release root — outside the live checkout — and hands it to
`promote-keeplore-release.sh`.
That script runs the Deployment Contract's preflight against the candidate
before anything switches, switches `current` atomically behind Apache, and
verifies the declared health semantics. No Delegated Worktree is touched at any
point.

When the active Deployment Contract revision declares appearance verification,
health alone no longer completes the attempt. Before switching, the promoter
captures a card-view baseline from the Release production is currently serving.
After the switch and a passing health check, it measures the authenticated
production table view at the desktop and mobile verification viewports and
applies the same acceptance bar the Delegation's candidate was held to:

- Get Rid Of and Remove share every matched computed property — height,
  vertical padding, typography, borders, colour, and box shadow — at both
  viewports (ADR-0055 and `keeploreMatchedControlProperties`);
- both retain content-based widths, and those widths still differ;
- card view hashes identically to the baseline taken from the retained Release;
  and
- authenticated desktop and mobile screenshots exist under
  `/var/lib/voice-agent-evidence/keeplore-production/<commit>/`.

A failure at any of those restores the retained Release, records the attempt as
failed at the `appearance-verification` stage with the failing properties named,
and reports failure. Nothing treats the feature as complete. An unreadable
verdict counts as a failed one — a Promotion must never complete by not looking.

The browser that takes this measurement is the promoter's own root-owned
session at `/var/lib/voice-agent/browser/keeplore-production.json`. It is not
the Subagent's `/var/lib/voice-codex/browser/keeplore.json`, and the verifier
injects no stylesheet: whatever the switched Release serves is what is measured.

## Appearance verification is per contract revision

`KEEPLORE_APPEARANCE_VERIFICATION=1` in the root-owned
`/etc/voice-agent/keeplore.conf` turns it on, and the wizard activates it as an
attended step, bumping `KEEPLORE_CONTRACT_REVISION` at the same time — changing
how a Human Merge is verified is a new revision, and every attempt records the
revision it was built under. It is off by default and must stay off until this trial's change
is merged: the two controls are supposed to differ before it, so an
unconditional check would roll back the onboarding merge and every unrelated
Keeplore change.

The promoter and the shared boundaries it sources are reviewed root authority.
Changing either requires a Human Merge, a Promotion, and the attended
deployment-authority upgrade before it becomes host authority — see
`voice_agent_authority_keeplore_tools` in
`ops/release/deployment-authority-manifest.sh`.

## Duplicates and reconciliation

A repeated webhook delivery returns the recorded result and deploys nothing. A
reconciliation pass that rediscovers a merge already processed leaves it alone,
and a merge with a recorded failed Promotion Attempt is left for owner review
rather than retried automatically. `promote-keeplore-main.sh` is itself
idempotent: a commit already serving exits successfully without switching.

## The trial's Evidence Record

Slice three ends in one record, not several. Print it for attended review:

```bash
sudo -u voice-agent env \
  VOICE_AGENT_DATABASE_PATH=/var/lib/voice-agent/voice-agent.sqlite \
  KEEPLORE_MERGE_COMMIT=<merge commit> \
  KEEPLORE_PULL_REQUEST_STATE=merged \
  KEEPLORE_COMPLETION_CALLBACK=authorized \
  VOICE_AGENT_EVIDENCE_RECORD_URL=https://voice.stephens.page/?task=<task id> \
  node --experimental-strip-types \
  apps/worker/src/keeplore-trial-promotion-inspect.ts
```

It joins the Delegation in SQLite, the host's append-only Promotion Attempt
journal, and the promoter's own appearance observation, and links the confirmed
telephone request, the Delegation Brief and Result, the branch and commits, the
pull request, the Human Merge and its actor, the Release, the health and
appearance verification, any rollback, the worktree decision, the notice the
owner received, and one terminal conclusion. It exits non-zero unless the trial
is complete and verified in production.

The owner receives the Completion Callback they asked for only when the call
actually reached and authorized them. Every other ending — unanswered,
voicemail, failed, or never requested — is reported as the generic Silent
Notification, which carries the authenticated Evidence Record link and no
operational evidence.

## The Delegated Worktree

The clean, completed worktree stays while the pull request is open, so it can
receive review work. Once the pull request is merged or closed it becomes
eligible for removal, and only then, and only if it is clean, completed, and
unquarantined. A stopped, failed, dirty, or quarantined worktree is retained
with its reason for inspection and is never removed automatically.

`resolve-keeplore-worktree.sh` performs that lifecycle, and the wizard runs it:

```bash
sudo /opt/voice-agent/keeplore/resolve-keeplore-worktree.sh <pull request number>
```

It reads the pull request's state from GitHub rather than accepting an
operator's word for it, asks the Voice Agent's own policy what should happen,
and removes the worktree as `voice-codex` — the identity that owns it — only on
a `remove` decision whose path is inside the registered worktree root. It emits
the decision as JSON on standard output and the human sentence on standard
error. Retaining is not a failure: it exits successfully and says why.

## The owner's notice

`apps/worker/src/keeplore-trial-completion-notice.ts` sends the trial's terminal
notice. The Completion Callback machinery in `task-continuity` runs while a
Telephone Session is live; the trial finishes a Human Merge, a Promotion, and a
verification after that call ended, so its notice has no live session to hang
off.

A Completion Callback is claimed only when the Durable Task recorded a
`completion.callback.outcome` of `authorized` — the outcome is read from
evidence, never typed by an operator. Every other ending, including a callback
that was never requested, sends the generic Silent Notification with the
authenticated Evidence Record link and no operational evidence. Its idempotency
key is the task's own identity, so re-running the wizard does not send a second
email.

## Accepting slice three

Acceptance is recorded in `/var/lib/voice-agent/acceptance/slice-three.json`
through `apps/acceptance/src/slice-three-cli.ts`. A production verification is
refused unless a Human Merge of that same commit is already recorded, and
acceptance is refused while health, appearance, card view, either screenshot, or
the absence of a rollback is unmet. A failed verification stays in the history;
a later passing verification of the same merge supersedes it without erasing it.

Check status at any time:

```bash
pnpm acceptance:slice-three status --record /var/lib/voice-agent/acceptance/slice-three.json
```

If the Promotion rolled back, slice three is not accepted. Read the recorded
verdict, fix the change through a new Delegation, and start again from the
pull request — do not re-run the Promotion against the same commit expecting a
different result.
