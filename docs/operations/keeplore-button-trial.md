# Restricted Codex Keeplore Button Trial

Issue #13 is the first real code Delegation after Keeplore onboarding. Run the
repeatable attended procedure on the Agent Host:

```bash
./ops/acceptance/run-keeplore-button-trial.sh
```

The wizard deliberately does not run during an ordinary release. A human must
complete the separate Codex subscription and Keeplore browser logins before
the worker admits this Delegation. GitHub requires no user login: publication
uses the reviewed least-privilege Keeplore GitHub App from onboarding.

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

Stage 2 also requires the reviewed `bwrap-userns-restrict` AppArmor profile and
the pinned `voice-agent-keeplore-publisher.service`. Both become active root
authority only through the attended deployment-authority upgrade above after
the Release has been Human Merged and promoted.

The trial's own Codex commands — the stage 2 login and enrollment checks and
the stage 3 browser-state check — run through `as_voice_codex`, from the active
Release rather than from the operator's own directory. Codex reads any project
configuration it finds from its working directory upward, and `voice-codex`
cannot read the operator's home: a Codex command that inherited it exits on an
unreadable configuration file. That failure looks exactly like a missing login,
so an enrolled restricted identity would be sent back through the device flow.
The login check prints whatever Codex reported before it offers the device
flow, because an unreadable configuration file and a missing subscription both
exit the same way. If that line reads `Failed to read project config file`, the
working directory is the fault and the device flow will not repair it.

This applies to the trial's own checks only. A Delegation's model run takes its
working directory from the Brief's registered Keeplore scope; it must never be
pointed at the Release, whose `AGENTS.md` is repository instruction the model
has no business reading.

If Bubblewrap reports `No permissions to create new namespace`, read the
Subagent unit before the AppArmor profile. A namespace restriction on
`voice-agent-subagent.service` denies Bubblewrap's `clone` outright and leaves no
AppArmor denial in the audit log, while `bwrap` still succeeds for `voice-codex`
from an attended shell — see ADR-0054. Both sandbox probes here run under that
unit's own restriction, so a green stage 2 now means the Delegation's sandbox
starts. No narrower restriction works: Bubblewrap requests every namespace in one
call, so denying any single type fails exactly like denying all of them.

If it reports `loopback: Failed to create NETLINK_ROUTE socket`, the unit's
`RestrictAddressFamilies` is missing `AF_NETLINK`, which bwrap needs to bring
loopback up inside the network namespace it unshares — also ADR-0054.

If Bubblewrap reports `RTM_NEWADDR` or `uid_map` permission errors, do not set
`kernel.apparmor_restrict_unprivileged_userns=0` and do not make Bubblewrap
setuid. Promote the reviewed fix, run the attended deployment-authority upgrade
above, and rerun the trial. The upgrade activates Ubuntu Noble's narrow profile
and the health contract proves that the offline Codex sandbox works before the
trial resumes.

If an attended upgrade instead reports `bwrap: Can't chdir to
/opt/voice-agent/releases/<commit>: No such file or directory`, the profile is
active but the reviewed Release predates the canonical sandbox-working-directory
fix. The rollback is expected. Do not add a manual bind mount or replace the
`current` symlink; merge and promote the reviewed fix, then run the attended
upgrade again from that new Release.

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
disabled. Fixed host code stages only `ui/artifacts/useby.php`,
`ui/artifacts/useby.js`, and `ui/style.css` in a disposable non-repository model
workspace. The sandbox receives that directory as its sole writable workspace
root; it cannot read the rest of the Delegated Worktree, the Codex or browser
credential stores, or the publisher socket. Before copying anything back, fixed
host code proves both references stayed byte-identical and validates the
candidate CSS; only `ui/style.css` can reach the persistent worktree.
Repository instructions, issue text, test output, and web content are untrusted
data and cannot expand those paths or authority.

The registered source mirror stays root-owned and non-writable by the runner.
Release installation grants only the named `voice-codex` identity read and
traverse ACLs, including defaults for objects added by later root-owned
fetches. The shared Subagent socket group and telephone worker receive no source
mirror access. Before accepting a source revision, the attended trial proves
that `voice-codex` can read that exact commit.

The runner does not mark the root-owned mirror as a Git `safe.directory` or
clone it directly across the ownership boundary. Fixed host code exports its
reviewed refs to a private temporary Git bundle, imports that bundle into the
runner-owned mirror, verifies the exact registered commit, and removes the
bundle before model work begins. The runner mirror retains only the token-free
Keeplore HTTPS remote.

Fixed host code—not the model—copies the candidate into a disposable directory
and runs the registered PHPUnit command there in a second network-disabled
profile, injects the candidate CSS into an authenticated browser after taking
that browser offline, and commits only `ui/style.css`. Codex returns only
whether a candidate is ready and bounded risks; it never receives GitHub or
browser authority and cannot self-attest verification.

After those checks leave one clean commit, the fixed runner sends one strict
`create-or-observe-pull-request` request over a private Unix socket. The pinned,
root-owned publisher re-reads the running Delegation from SQLite, independently
checks its branch, base, clean worktree, exact head, single commit, changed path,
and token-free Keeplore remote, then reads the root-owned repository-policy
journal. Publication proceeds only while that journal contains fresh observations
of the selected Keeplore installation, its exact `checks:read`, `contents:write`,
and `pull_requests:write` grant (plus implicit `metadata:read`), protected `main`
rules, and a current owner attestation naming no bypass actors.

The publisher signs the App JWT in its own process and requests an installation
token narrowed to Keeplore with only Contents write and Pull requests write.
The raw token is kept out of files, arguments, logs, evidence, the Subagent, and
the Delegation Result. Git receives it through the pinned ephemeral credential
helper while the stored remote remains token-free. Publisher code constructs
the sole allowed refspec and GitHub endpoints itself, pushes only the exact
assigned `codex/keeplore-button-<delegation>` commit, creates or observes the PR
against `main`, and then independently re-reads an open App-bot PR with the exact
repository, base, branch, and head. It best-effort revokes every token.

An expired or revoked token permits one fresh publication attempt. The retry
reuses the already verified commit, first observes any PR that the prior attempt
created, and never reruns Codex, verification, or commit creation. Other errors
quarantine the worktree. The App still has no ruleset bypass, merge, close,
administration, or deployment authority; only a later Human Merge can authorize
Promotion.

## Verification and result

A completed result is accepted only when all of these are true:

- the observed worktree branch and base commit match the brief;
- the only changed path is `ui/style.css`, with at least one observed commit;
- existing CSS remains byte-for-byte intact and the sole appended rule targets
  exactly the table-only Get Rid Of selector with no width, URL, or at-rule,
  and `white-space` is registered for `nowrap` alone (see ADR-0055);
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

## Publication recovery and credential custody

The App configuration and PEM remain root-owned at
`/etc/voice-agent/keeplore-github-app.conf` and
`/etc/voice-agent/keeplore-github-app-private-key.pem`; systemd copies them into
the pinned root-owned publisher's private runtime credential directory. The
publisher reads those copies only when publication is requested.
`voice-codex` must have no
`gh` login or stored GitHub user token. The wizard removes the obsolete trial
`hosts.yml` after confirmation and proves the model sandbox cannot reach the
publisher socket.

If publication reports `publication-refused`, do not add a user login or copy a
token into the worktree. Check `voice-agent-keeplore-publisher.service`, run the
Keeplore repository-policy collector, and, if the owner attestation is stale,
repeat `record-keeplore-bypass-attestation.sh` with the authenticated owner
account. Then resume the same Durable Task; the fixed publisher reuses the clean
verified candidate. Changes to the publisher program or unit require another
Human Merge, Promotion, and attended deployment-authority upgrade before they
can become root authority.

If a Delegation fails before creating its persistent worktree, check the source
mirror as `voice-codex`. Do not copy it or grant the shared socket group access.
Merge and promote the reviewed ACL repair, run the attended
deployment-authority upgrade so the root installer applies it, and restart the
trial. The source-revision stage will stop before another call if the exact
commit is still unreadable.

## Diagnosing a dropped call

A Telephone Session that ends on a bounded provider fault writes one line to
the worker journal naming the stage, the provider, and a sanitized description
of what the provider said:

```bash
sudo journalctl -u voice-agent-worker.service \
  --grep 'bounded telephone provider failure' --since '1 hour ago'
```

The description carries the error's type, and its status or code when the
provider supplies one. It carries a *provider's* message only for the speech
synthesis and session setup stages, whose providers never receive the caller's
words. Recognition and interpretation errors may quote the transcript, so a
provider error at those stages logs its type alone.

A `TelephoneSessionFault` is different: it is this codebase reporting its own
broken invariant in a fixed string, so its message is logged at every stage.
Seeing one means the fault is ours, not the provider's, whatever the `provider`
field says. The durable Evidence Record is unchanged by this line and still
carries no provider text.

The matching Telephone Session records `provider-failure` as its end reason;
`disconnected`, `completed`, `maximum-duration`, and `prolonged-silence` are
the other outcomes and mean the providers were not at fault.

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
