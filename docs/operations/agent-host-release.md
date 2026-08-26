# Agent Host release and recovery

Issues #4, #6, and #7 introduce the read-only Bountywell health inquiry and its
Telephone Session path: a durable Callback Handshake followed by a modular
AssemblyAI, OpenAI, and Inworld conversation through Telnyx SIP and LiveKit
Cloud. Production activation still follows the Human Merge boundary in
ADR-0003. Never promote an unmerged branch.

## Fixed authority

The Fresh Passkey Action registers `bountywell-production` revision 1 with
exactly these capabilities:

- public `https://bountywell.com/api/health` status;
- public `https://bountywell.com/api/data` authentication-boundary status;
- registered local `/api/health` reachability on Bountywell's port 3000;
- allowlisted metadata for `bountywell-api.service`;
- boolean memory/task pressure evidence for that unit's cgroup when those
  properties are available; unavailable properties remain explicitly unknown.

The browser request contains only a CSRF token and idempotency request ID. It
cannot supply a host, URL, unit, filesystem path, or capability. Restart and
other service-control authority are absent. The broker never reads HTTP bodies,
journal output, environment variables, application data, or unrelated host
state. Its projection contains status codes, bounded booleans, fixed provenance
labels, a timestamp, and the same-host uncertainty statement.

## Service and network boundary

`voice-agent-api.service` and `voice-agent-worker.service` run as the dedicated
unprivileged `voice-agent` identity. `voice-agent-subagent.service` runs as
`voice-codex`, and `voice-agent-broker.service` runs as the separate
`voice-broker` identity. All four use `ProtectSystem=strict`, empty capability
sets, private devices/tmp, restricted namespaces, and narrow writable state
directories.

Apache serves `/opt/voice-agent/current/apps/pwa/dist` and proxies only `/api/`
to `127.0.0.1:3472`. The telephone worker connects to LiveKit Cloud and binds
its worker endpoint only to `127.0.0.1:3474`; it has no public listener. The broker listens only on
`/run/voice-agent-broker/broker.sock`, whose group permits the worker to connect.
The socket-only `voice-broker-client` group cannot read the broker's
`voice-broker`-owned state. SQLite and broker state live under separate private
`/var/lib` directories.
Neither service control, metrics, SQLite, nor the broker has a public port.
Prometheus scrapes `/metrics` directly on the API's localhost-only port. Those
metrics cover Durable Tasks, Operations, Callback Handshake outcomes and
attempts, Telephone Sessions, bounded speech-stage/provider timing and failures,
policy decisions, Silent Notifications, spending, whether a Self-Promotion
currently holds Call Admission closed, the latest bounded Bountywell
checks, explicit Voice Agent and Bountywell API probes, SQLite bytes/free-disk
capacity, and Promotion/circuit-breaker state; Apache does not proxy the
endpoint. A restricted timer refreshes probe metrics every 30 seconds, and the
existing node-exporter scrape supplies Agent Host resource health. Apache does
not proxy either surface. The authenticated live Evidence window is bounded to 90
days. Expiry atomically removes the underlying task, Operation, callback state,
and Evidence Events while retaining only sanitized delivery/request tombstones
needed to prevent an old retry from repeating its Operation.

## First release

From a clean checkout on the Agent Host after the pull request has been merged:

```bash
./ops/setup-agent-host.sh
```

The fourteen-stage wizard verifies `origin/main`, captures the LiveKit project
credentials and stored Telnyx/LiveKit route identifiers, builds the exact commit
outside the live path, installs identities and units, obtains the TLS
certificate, walks the owner through two-passkey bootstrap and Recovery Code
confirmation, requires Fresh Passkey Actions for Bountywell and Registered
Telephone revisions, configures the restricted Human Merge trigger, and runs
the real production smokes.
Bootstrap and Recovery Codes are shown only to the human and are not written to
repository or environment files.

The provisioned Grafana dashboard is **Voice Agent · Slice One Operational
Path** in the **Voice Agent** folder. Its first panel explicitly states that
Prometheus, Grafana, and the observed services share the Agent Host failure
domain. This telemetry diagnoses partial failures but cannot independently
detect loss of the entire host or network.

LiveKit credentials are installed as root-owned mode `0600`
`/etc/voice-agent/livekit.env` and are exposed only to the telephone worker.
The Resend sending key, verified domain ID, and notification subdomain live in
root-owned `/etc/voice-agent/resend.env` and are exposed only to the same
background worker. Before every send, the worker verifies through Resend that
the configured subdomain is verified and both open and click tracking are off.
Telnyx SIP credentials stay in Telnyx and LiveKit provider configuration; they
are not copied to the Agent Host, repository, PWA, or shell arguments.

The Callback Handshake smoke waits for a fresh inbound call from the Registered
Telephone, then requires a human answer and DTMF `1` on the callback leg. It
passes only when the durable Evidence Record contains the sanitized inbound,
notice, callback, machine-detection, DTMF, and authorization events. Unknown,
malformed, wrong-route, rate-limited, machine, and speech-only attempts do not
authorize a Telephone Session, and the callback leg never leaves voicemail.

The telephone Bountywell smoke continues in the authorized callback and waits
for a natural health question. It succeeds only when one read-only Operation
produces the supported spoken conclusion and the same Durable Task Evidence
Record contains the sanitized finalized turn, STT/coordinator/TTS timing,
bounded health evidence, semantic speech text, and final conclusion. Interim
hypotheses, raw or generated audio, credentials, and raw provider streams are
not retained.

The bounded Bountywell smoke uses `production-smoke-<merge-commit>` as its request ID. A
retry returns the same Durable Task and broker Operation rather than issuing a
second inquiry. It succeeds only when the Evidence Record contains all five
registered sources and concludes that Bountywell is healthy. Public health must
be `200`; the public data route's expected `401` remains separate evidence and
cannot substitute for primary health.

## Attended deployment-authority upgrades

Automatic Promotion never replaces root-pinned orchestration, systemd
definitions, or AppArmor profiles. When a reviewed Human Merge changes that
authority, first let the existing pinned promoter install and activate its
immutable Release. Then run the separate attended upgrade from that exact
active Release:

```bash
cd /opt/voice-agent/current
./ops/upgrade-agent-host-deployment-authority.sh
```

The five-stage wizard verifies that the active root-owned, immutable Release is
the latest successful Promotion and has a recorded Human Merge transition. It
then displays every difference between the reviewed Release and
`/usr/local/libexec/voice-agent`, including the independently executed WebAuthn
verifier and without reading credential values. The owner
must then authorize this exact active commit with the PWA's dedicated Fresh
Passkey Action; terminal confirmation cannot expand deployment authority.

Immediately before the ceremony, the privileged helper creates a random,
root-owned five-minute challenge bound to the commit. On the first attended
upgrade, root reads the existing, completed owner-passkey registration only as
untrusted candidate data and displays every label, credential ID, and public-key
fingerprint. The signed-in operator must approve those exact candidates at the
root terminal as a one-time authenticated out-of-band enrollment step. Root
then stages the candidates in an unpublished mode-`0600` file, and a WebAuthn
assertion proves possession of one approved existing owner credential before
root enrolls it. A self-asserted WebAuthn registration or `attestation: none`
response is never accepted as a deployment trust anchor.

Enrollment does not authorize an upgrade: its evidence event is appended
before the selected key is atomically published in the root-only registry. The
event preserves the approved candidates' labels, credential IDs, and public-key
fingerprints, the selected registry snapshot, and digests of both candidate set
and registry so the mutable file remains reconstructible and auditable. The
wizard immediately creates a second root challenge and requires a distinct
WebAuthn assertion from the newly root-enrolled existing credential. Later
upgrades require that assertion directly. Abort the bootstrap if a displayed
candidate is unexpected or the browser does not show an authenticator prompt.

The verifier is one dependency-free program in the exact authority manifest;
it uses only Node.js built-ins, is displayed during review, and is pinned as a
whole. A later Release must match the pin and cannot replace its verifier or
credential registry. The PWA returns assertion material as untrusted data, and
the privileged helper independently checks the root
challenge, origin, relying-party ID, user presence and verification,
credential public key, signature, counter, and expiry before recording any
authorization. A request file created by the running Release is therefore not
authority by itself.

The privileged helper accepts only `--prepare`, the first-use `--enroll`, or
`--activate` plus that active 40-character commit. Enrollment and authority
authorization are separate recorded ceremonies, and activation consumes only
the matching assertion. It stages
the complete deployment-authority manifest as one sibling directory, switches
the pin, activates any reviewed AppArmor profile while retaining the prior
system definition, reruns the reviewed installer to provision any new
identities and private state roots, and re-promotes the same Release through
the newly pinned promoter so new systemd definitions are installed and
health-verified together. The prior
authority and AppArmor definition are restored before the prior promoter
reactivates the Release if the new authority fails. After success, the prior
pin and system-profile evidence are retained under
`/var/lib/voice-agent-deployment-authority/backups/` and the activated commit is
recorded in `current` there. Credential enrollment, authorization, rejection,
activation, failure, and rollback outcomes are appended to `events.jsonl` in
the same root-owned directory before the mutable `current` projection changes.
Do not repair a
missing unit or profile with a one-off copy; the attended upgrade preserves the
reviewed authority and rollback boundary.

The restricted Codex runner depends on Bubblewrap user namespaces. Ubuntu
24.04 keeps the host-wide `kernel.apparmor_restrict_unprivileged_userns=1`
protection enabled, so the reviewed authority pins and activates Ubuntu
Noble's `bwrap-userns-restrict` profile instead of weakening that sysctl. The
profile permits Bubblewrap to construct its namespace and strips capabilities
from sandbox children. Candidate preflight requires the active system profile
to match the root pin, and deployment health executes an offline Codex sandbox
probe as `voice-codex`. That probe resolves `current` to the exact immutable
Release before constructing its narrow read-only permission profile because
Bubblewrap enters a canonical working directory while Codex retains logical
paths for read-only mounts.

## Health and rollback

After first setup, `.github/workflows/promote-agent-host.yml` observes pushes to
`main`, but continues only when GitHub associates the exact commit with a merged
pull request whose merger is an authenticated human user. It submits that proof
through a restricted SSH identity to the pinned, root-owned
`/usr/local/libexec/voice-agent/promote-main.sh`. The host stores verified
GitHub `before -> merge commit` transitions under root control, holds a queue
lock, fetches `origin/main`, and attempts each verified, unseen Human Merge in
order. This treats a multi-commit rebase merge as the one production
authorization it actually represents. An unverified direct or bot push leaves
no transition from the last attempted merge, so the queue stops rather than
granting it production authority; concurrent workflow runs cannot coalesce or
reorder Human Merges.

Every promotion atomically switches `/opt/voice-agent/current`, restarts the
four runtime services, and checks:

```bash
sudo /usr/local/libexec/voice-agent/deployment-health.sh
```

The check requires active API, worker, restricted Subagent, and broker units;
the built PWA shell; the Subagent and broker Unix sockets; the broker health
response; the API's localhost-only `/healthz`; and SQLite integrity plus the
expected durable schema. Before a
candidate can run an additive migration, Promotion writes and verifies
`/var/lib/voice-agent/migration-backups/pre-<commit>.sqlite`. If verification
fails, `promote-release.sh` atomically restores the previous symlink and its
systemd unit definitions, restarts that release, and verifies it. A failed
first-ever installation has no prior release and is stopped rather than left
partially active.

Promotion Attempts are serialized and recorded in root-controlled state under
`/var/lib/voice-agent-promotions`, including release install/build failures that
occur before the immutable candidate exists. Three consecutive failures open the
Deployment Circuit Breaker for that commit. A later Human Merge receives the
half-open recovery attempt; repeating the failed commit is rejected. After
reviewing the failed evidence, the owner may perform a Fresh Passkey Action in
the PWA and choose **Resume Promotion queue after review**. The authenticated
API can write only a narrow resume request; a root-owned systemd path unit
binds it to the failed commit in the open circuit. The root-owned systemd path
unit consumes it only while that reviewed identity still matches, retries
exactly that commit, records that
attempt as `fresh-passkey-resume`, and drains later verified Human Merges after
a successful retry. The API can read only the sanitized Prometheus projection
of promotion state.

Every Promotion Attempt reports its Deployment Authority Drift: the pinned paths
at which the Release left serving differs from what the Pinned Deployment
Authority under `/usr/local/libexec/voice-agent` is actually running, compared
over the whole reviewed manifest — the `ops/release/` scripts, the pinned Human Merge and
authorization verifiers, the `ops/systemd/` unit definitions, the AppArmor
profile, and the Keeplore tools — by content rather than by presence. Drift is
a normal state and settles nothing: it never fails the attempt, never counts
toward the consecutive-failure total, and never opens the Deployment Circuit
Breaker. It appears in the attempt's `attempts.jsonl` line as `authorityDrift`,
in the Promotion's Evidence Record, and in the sanitized Prometheus projection
as `voice_agent_promotion_authority_drift` and
`voice_agent_promotion_authority_drift_paths` beside
`voice_agent_promotion_circuit_open`, so a merged change still waiting on the
attended ceremony is visible without a root terminal. The action that applies it
is `./ops/upgrade-agent-host-deployment-authority.sh`.

Deployment authority is not loaded from a candidate Release. The setup wizard
pins reviewed orchestration and service definitions under root-owned
`/usr/local/libexec/voice-agent`; automatic Promotions execute only those
copies. Repository install/build hooks run as the isolated
`voice-agent-builder` user with an empty environment. A candidate supplies the
unprivileged application files, while the pinned preflight and pinned systemd
definitions retain the root/service boundary. Every Promotion installs every
unit definition the manifest pins, so the definitions active under
`/etc/systemd/system` are the pinned set rather than a narrower copy of it; a
reviewed unit change therefore takes effect once the attended upgrade pins it
and the Release is re-promoted. Updating that pinned deployment
authority uses the separate attended wizard above; it is never a consequence
of a Human Merge alone. Root Git operations use only a root-owned bare mirror
under
`/var/lib/voice-agent-source` and the pinned HTTPS GitHub remote; the
human-owned registered checkout and its Git configuration never execute in the
privileged Promotion service. Because the repository is private, the wizard
installs a GitHub App private key from a local PEM into a distinct root-only
credential source. The pinned helper mints short-lived installation tokens for
the fixed HTTPS remote; the systemd resume service receives the PEM only through
`LoadCredential=`. The App must have read-only Contents access and be installed
only on `JacobStephens2/voice-agent`.

## Self-Promotion safe point

Promoting the Voice Agent's own code replaces the runtime doing the promoting,
so `promote-release.sh` does not restart the services out from under whoever is
on the phone. Once the immutable Release exists and its preflight has passed —
and not before, so a live call is never waited out behind a build that might
have failed anyway — the promoter closes **Call Admission** and waits for a
**Promotion Safe Point**.

Call Admission is one durable row in the Voice Agent's own SQLite store, read
inside the same transaction that reserves a Telephone Session. That is the
single gate every entry path already passes through, so an inbound Callback
Handshake, a Completion Callback, and an authenticated resumption all report
temporary unavailability through the bounded behavior they already have for a
refused reservation. Nothing new is spoken, and no new failure mode appears.
It is durable rather than in-process because the process that closes it is the
one about to restart.

The safe point is reached when no Telephone Session is active and no
non-interruptible Operation is unsettled. The non-interruptible kinds are the
ones that mutate Agent Host state — `bountywell.service.restart`,
`bountywell.service.stop`, `bountywell.recovery-timer.arm`, and
`bountywell.recovery-timer.remove` — and their declared safe boundary is their
own settlement. Every other Operation is read-only or idempotent under its own
durable identity and is carried across the switch for the new runtime to finish.

A session reserved but not yet live counts too. An admission granted before the
gate closed can still become a call, and switching between reading a clear safe
point and that activation would interrupt a call that had just begun.

Waiting is the only instrument. A live call is allowed to end naturally or reach
an explicit safe handoff; it is never ended to deploy sooner. The promoter
observes once a second up to the bound the Deployment Contract enrols — 900
observations, about fifteen minutes — which `VOICE_AGENT_SAFE_POINT_OBSERVATIONS`
overrides for one run. Exceeding the bound abandons the attempt: nothing is
switched, the prior Release keeps serving, and admission reopens against it once
that runtime is confirmed healthy. The call is not taken away.

Admission reopens only once a healthy runtime is confirmed — the switched
Release, or whatever is serving after a failed attempt has restored or abandoned
its way back. That decision is made in one place, the promoter's cleanup path,
so a failure anywhere between closing the gate and the end of the attempt still
reopens it: a unit-definition install, a `daemon-reload`, or the migration-backup
integrity check would otherwise leave the prior healthy Release serving with
every caller refused. The gate reopens only after `deployment-health.sh` passes
against whatever is active at that moment. If nothing healthy can be confirmed
the gate stays closed, and callers keep meeting the bounded refusal instead of
reaching a runtime nobody has verified.

Read the gate directly when diagnosing a host that is refusing calls:

```bash
sudo -u voice-agent /usr/bin/node --experimental-strip-types \
  /opt/voice-agent/current/apps/worker/src/self-promotion-cli.ts \
  observe /var/lib/voice-agent/voice-agent.sqlite
```

The same program takes `pause`, `await-safe-point`, and `reopen`. It runs as the
unprivileged owner of the durable store, so reopening a gate a failed Promotion
left closed needs no deployment authority — but read the Promotion evidence
first, because a closed gate after a failed attempt is usually reporting that no
Release was ever confirmed healthy.

The Promotion Evidence Record carries the merge provenance, the safe-point
decision and how many observations it took, the disposition of active work
(including that zero Telephone Sessions were ended for the Promotion), the
Release, both the contract health reading and the Self-Promotion's own runtime
checks, any rollback, and the final admission state.

To deliberately return to a retained prior release:

```bash
sudo /usr/local/libexec/voice-agent/rollback-release.sh <previous-commit>
```

The argument must name an installed 40-character commit under
`/opt/voice-agent/releases`. Rollback uses the same serialized switch and health
verification as forward promotion using the pinned, root-owned systemd
definitions. Releases are retained; the scripts do not prune them or delete
SQLite state.

The schema change in this release is additive and the prior Release tolerates
it, so ordinary code rollback does not rewind production data. If database
restoration is explicitly required after diagnosing a migration failure, stop
the two SQLite users and restore the verified pre-migration copy:

```bash
sudo systemctl stop voice-agent-api.service voice-agent-worker.service
sudo -u voice-agent /usr/bin/node --experimental-strip-types \
  /opt/voice-agent/current/packages/sqlite-store/src/database-maintenance-cli.ts \
  restore /var/lib/voice-agent/migration-backups/pre-<commit>.sqlite \
  /var/lib/voice-agent/voice-agent.sqlite
sudo systemctl start voice-agent-api.service voice-agent-worker.service
sudo /usr/local/libexec/voice-agent/deployment-health.sh
```

Off-host backup remains deliberately deferred by ADR-0031; these same-host
pre-migration copies are rollback evidence, not disaster-recovery backups.

## Changing the speech recognition model

The Voice Agent recognizes speech with a **Recognized Speech Model**: a model
this system carries an entry for, bound to the provider identity recorded
against its stage in evidence and to the options that provider's own gateway
accepts. `VOICE_AGENT_STT_MODEL` chooses one, and only one of these is accepted:

| Setting | Provider recorded | Notes |
| --- | --- | --- |
| `assemblyai/universal-streaming-multilingual` | `assemblyai` | The default. An absent setting selects it. |
| `assemblyai/universal-3-5-pro` | `assemblyai` | The contextual generation designated in `research/2026-08-11-livekit-pipeline-providers.md`. |
| `deepgram/flux-general-en` | `deepgram` | The fallback designated in `research/2026-08-11-livekit-pipeline-providers.md`. |

All three are reached through LiveKit Inference on the `LIVEKIT_API_KEY` this
system already holds, so moving between them needs no new credential or billing
path. The setting reaches both the conversation transcriber and the machine
detector's, and its model appears on the provider-failure and speech-timing
evidence for the recognition stage — so a recorded `stage=stt` fault is read
against the model that actually raised it.

Two things change when you select `assemblyai/universal-3-5-pro`, and nothing
else does. The transcriber is started with AssemblyAI's `mode=balanced`, the
provider's own voice-agent preset, alongside the same domain keyterms every
entry carries. And each spoken response is pushed to the running transcriber as
`agent_context` as it is spoken, so the caller's answer is recognized against
the question they were just asked; a response longer than the 1500 characters
that gateway accepts is truncated to its end, which is the part being answered.
No other entry is sent that option — a gateway ignores an option it does not
know without saying so, which would read as a bias that was never applied.
ADR-0060 records the reasoning.

One reading changes if you move to the Deepgram entry. The operational rollup
enumerates only `assemblyai`, `inworld`, and `openai` and folds anything else
into `other`, so with that entry selected the rollup reports
`stage="stt"` against `provider="other"`. That is truthful rather than wrong,
and it needs no schema migration; the entry's own provider and model are still
named exactly on the provider-failure and speech-timing evidence, which is
where a fault is read.

The setting is declared in `ops/systemd/voice-agent-worker.service`. Change it
there, in a pull request:

```
Environment=VOICE_AGENT_STT_MODEL=deepgram/flux-general-en
```

That change reaches the Agent Host only through a Human Merge and a Promotion.
Editing the unit on the host is not a supported path: every Promotion installs
the unit definitions the pinned manifest carries, so a hand-edit is overwritten
by the next release. A unit change also takes effect only once the attended
deployment-authority upgrade above pins it and the Release is re-promoted.

A value naming anything outside the set ends `voice-agent-worker.service` at
start, before it accepts a job. That is deliberate: the failure then arrives as
a failed post-Promotion health verification and an automatic rollback rather
than as a provider error in the middle of a call. ADR-0057 records the
reasoning. The worker's journal names the setting:

```bash
sudo journalctl -u voice-agent-worker.service -n 20 | grep VOICE_AGENT_STT_MODEL
```

Nothing switches provider during a call. A stalled transcriber still spends the
single Bounded Provider Retry and then ends the call through the prerecorded
response; moving off it is this attended change plus a Promotion.
