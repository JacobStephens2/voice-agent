# Restricted Codex Keeplore Button Trial

Issue #13 is the first real code Delegation after Keeplore onboarding. Run the
repeatable attended procedure on the Agent Host:

```bash
./ops/acceptance/run-keeplore-button-trial.sh
```

The wizard deliberately does not run during an ordinary release. A human must
complete the separate provider, repository, and Keeplore browser logins before
the worker admits this Delegation.

The first stage requires `voice-agent-subagent.service`. If the active reviewed
Release contains that unit but systemd reports it absent, do not copy the unit
manually. The root-pinned deployment authority predates the Release; upgrade it
through the attended boundary, then restart this trial:

```bash
cd /opt/voice-agent/current
./ops/upgrade-agent-host-deployment-authority.sh
./ops/acceptance/run-keeplore-button-trial.sh
```

The upgrade wizard prepares a root-owned five-minute challenge before opening
the PWA. Use **Create deployment-authority Fresh Passkey proof** during that
window; an ordinary signed-in browser session or terminal confirmation is not
authorization. On the first run, approve the displayed existing owner-passkey
candidates at the root terminal, assert one approved key to enroll it in the
root-only registry, and then make a second assertion to authorize the upgrade.
Later runs require the authorization assertion directly.

Stage 2 also requires the reviewed `bwrap-userns-restrict` AppArmor profile.
If Bubblewrap reports `RTM_NEWADDR` or `uid_map` permission errors, do not set
`kernel.apparmor_restrict_unprivileged_userns=0` and do not make Bubblewrap
setuid. Promote the reviewed fix, run the attended deployment-authority upgrade
above, and rerun the trial. The upgrade activates Ubuntu Noble's narrow profile
and the health contract proves that the offline Codex sandbox works before the
trial resumes.

## Confirmation and Durable Task

Only an authenticated Telephone Session can reach the coordinator. A request
that names Keeplore, Get Rid Of, Remove, and table view receives this exact
state-changing readback:

> Please confirm this state-changing task: Keeplore production — make
> table-view Get Rid Of and Remove controls match in height, vertical padding,
> typography, and visual weight, while retaining content-based widths and
> leaving card view unchanged.

No Delegation exists before an affirmative reply. Confirmation creates one
Durable Task and a strict Delegation Brief containing the registered Keeplore
revision and exact source commit, the measurable criteria, the permitted
capabilities, and the only editable path (`ui/style.css`). It never contains
the telephone transcript.

## Execution boundary

`voice-agent-subagent.service` runs as `voice-codex`, accepts only typed JSON
over a private Unix socket, and allows one process globally. The identity has a
private home and separate eligible Codex subscription login. It has no sudo or
Linux capabilities, Docker socket, Keeplore production directory, Voice Agent
database, Operations Broker socket, or production credential source.

The runner owns a bare mirror and one persistent worktree per Delegation under
`/var/lib/voice-agent-worktrees/keeplore`. Its Codex invocation ignores user
configuration and rules and selects a custom permission profile with network
disabled. Model-generated commands can read only `ui/artifacts/useby.php` and
`ui/artifacts/useby.js` and can write only `ui/style.css`; they cannot read the
Codex, GitHub, or browser credential stores. Repository instructions, issue
text, test output, and web content are untrusted data and cannot expand those
paths or authority.

Fixed host code—not the model—copies the candidate into a disposable directory
and runs the registered PHPUnit command there in a second network-disabled
profile, injects the candidate CSS into an authenticated
browser after taking that browser offline, commits only `ui/style.css`, pushes
the exact assigned ref, and creates or observes the pull request. Codex returns
only whether a candidate is ready and bounded risks; it never receives GitHub
or browser authority and cannot self-attest verification.

The dedicated GitHub account enrolled by the wizard must have write access to
`JacobStephens2/keeplore` only and no production-branch bypass. It may push the
assigned `codex/keeplore-button-<delegation>` branch and open or update a pull
request against `main`; only a later Human Merge can authorize Promotion.
The wizard rejects the `JacobStephens2` owner account and verifies that the
enrolled identity reports push access to Keeplore. If the wrong identity was
enrolled, remove it only from the `voice-codex` GitHub configuration, rerun the
wizard, and complete device authentication with the dedicated user.

## Verification and result

A completed result is accepted only when all of these are true:

- the observed worktree branch and base commit match the brief;
- the only changed path is `ui/style.css`, with at least one observed commit;
- existing CSS remains byte-for-byte intact and the sole appended rule targets
  exactly the table-only Get Rid Of selector with no width, URL, or at-rule;
- the declared automated command passed;
- authenticated desktop and mobile screenshots exist in the Delegation's
  private evidence directory;
- computed height, vertical padding, font family, font size, font weight, and
  box shadow match between Get Rid Of and Remove at both viewports;
- both widths are content-based and remain different;
- the before/after card-view hashes match;
- GitHub independently reports an open Keeplore pull request from the assigned
  branch to `main`; and
- the worktree is clean.

SQLite stores an immutable event history for acceptance, claims, restart
resumption, stop requests, and terminal results alongside the current query
projection. The result retains only structured status, branch, commits,
changed files, verification, risks, worktree state, and pull-request URL. Raw
Codex events and the telephone transcript do not cross the runner boundary.
The runner also caches each terminal structured result so a worker reconnect
does not repeat publication. The wizard prints the latest structured record with
`apps/worker/src/keeplore-delegation-inspect.ts` for attended review.

## Stop, quarantine, and cleanup

Saying “Stop” records the request durably and sends `SIGUSR1` through the typed
runner. The executor terminates the complete model process group immediately,
allows any already-running fixed host command to reach its boundary, and starts
no later verification, commit, push, or pull-request step. It preserves every
commit and filesystem change and never resets, stashes, checks out, or deletes
the worktree. A queued stop prevents execution entirely; an active stop returns
a structured stopped result with the observed worktree and verification
evidence.
If the originating call or worker reconnects, the authenticated coordinator
resolves the latest pending or running Delegation from durable state before it
applies the stop.

The clean, verified, completed worktree remains ineligible for cleanup while
its pull request is open, so it can receive review work. A later lifecycle may
make it eligible only after the pull request is merged or closed and the
worktree is still clean. Stopped, failed, dirty, out-of-scope, or unverifiable
worktrees are retained with a quarantine reason for inspection.
