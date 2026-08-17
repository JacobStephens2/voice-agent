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
unprivileged `voice-agent` identity. `voice-agent-broker.service` runs as the
separate `voice-broker` identity. All three use `ProtectSystem=strict`, empty
capability sets, private devices/tmp, restricted namespaces, and narrow writable
state directories.

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
attempts, policy denials, the latest bounded Bountywell checks, SQLite
bytes/free-disk capacity, and Promotion/circuit-breaker state; Apache does not
proxy the endpoint. The authenticated live Evidence window is bounded to 90
days. Expiry atomically removes the underlying task, Operation, callback state,
and Evidence Events while retaining only sanitized delivery/request tombstones
needed to prevent an old retry from repeating its Operation.

## First release

From a clean checkout on the Agent Host after the pull request has been merged:

```bash
./ops/setup-agent-host.sh
```

The twelve-stage wizard verifies `origin/main`, captures the LiveKit project
credentials and stored Telnyx/LiveKit route identifiers, builds the exact commit
outside the live path, installs identities and units, obtains the TLS
certificate, walks the owner through two-passkey bootstrap and Recovery Code
confirmation, requires Fresh Passkey Actions for Bountywell and Registered
Telephone revisions, configures the restricted Human Merge trigger, and runs
the real production smokes.
Bootstrap and Recovery Codes are shown only to the human and are not written to
repository or environment files.

LiveKit credentials are installed as root-owned mode `0600`
`/etc/voice-agent/livekit.env` and are exposed only to the telephone worker.
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
three services, and checks:

```bash
sudo /usr/local/libexec/voice-agent/deployment-health.sh
```

The check requires active API, worker, and broker units; the built PWA shell;
the broker Unix socket and its health response; the API's localhost-only
`/healthz`; and SQLite integrity plus the expected durable schema. Before a
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

Deployment authority is not loaded from a candidate Release. The setup wizard
pins reviewed orchestration and service definitions under root-owned
`/usr/local/libexec/voice-agent`; automatic Promotions execute only those
copies. Repository install/build hooks run as the isolated
`voice-agent-builder` user with an empty environment. A candidate supplies the
unprivileged application files, while the pinned preflight and pinned systemd
definitions retain the root/service boundary. Updating that pinned deployment
authority is a separate attended setup action, not a consequence of a Human
Merge. Root Git operations use only a root-owned bare mirror under
`/var/lib/voice-agent-source` and the pinned HTTPS GitHub remote; the
human-owned registered checkout and its Git configuration never execute in the
privileged Promotion service. Because the repository is private, the wizard
installs a GitHub App private key from a local PEM into a distinct root-only
credential source. The pinned helper mints short-lived installation tokens for
the fixed HTTPS remote; the systemd resume service receives the PEM only through
`LoadCredential=`. The App must have read-only Contents access and be installed
only on `JacobStephens2/voice-agent`.

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
