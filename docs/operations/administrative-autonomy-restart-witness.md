# Administrative Autonomy Agent Host restart witness

Issue #83 requires the exact authenticated Administrative Autonomy Policy
revision to persist through both service restart and Agent Host restart. The
automated SQLite close/reopen scenario covers **simulated service-process
recovery** only. It is not an Agent Host Restart Witness.

The real witness is deliberately post-Promotion. It changes systemd service
state and performs an actual reboot, so it must run attended from the immutable
Release produced by Human Merge and activated by Promotion. A branch worktree,
test process, or mocked `systemctl` result cannot satisfy this criterion.

## Preconditions

- Issue #83's reviewed commit is the active immutable Release at
  `/opt/voice-agent/current`.
- The owner has activated the intended Administrative Autonomy Policy revision
  through a Fresh Passkey Action.
- The owner can sign in to the deployed PWA with a Trusted Browser Session and
  can use `sudo` on the Agent Host.

From the active Release, run:

```bash
cd /opt/voice-agent/current
./ops/acceptance/run-administrative-autonomy-restart-witness.sh
```

The wizard creates or resumes one Release-scoped campaign in the fixed Voice
Agent SQLite store. The wizard and its standalone acceptance CLI refuse to run
from a branch worktree or another checkout at the same commit: their resolved
source path must be the active, root-owned immutable Release. For each phase it
opens the PWA with the campaign's current single-use challenge. The signed-in
owner chooses **Record server
observation**, and the authenticated API reads the exact policy revision,
state version, Administrative Execution Manifest fingerprint, active immutable
Release, API process instance, and Linux boot identity from its own composition
boundary. It also reads the Release-bound worker startup fingerprint from the
fixed store and checks the worker's fixed localhost health endpoint. The
request can supply none of those values.

The API captures its real entrypoint and Restart Witness module paths when the
process is composed. Every observation requires those captured root-owned,
non-writable files to belong to the Release that is active at observation time,
and walks the entire active Release to reject any unowned, writable, broken, or
escaping transitive entry. An API process left running across Promotion
therefore fails closed instead of following the moved `current` symlink and
claiming the new Release's identity. The wizard performs the equivalent fixed
ownership, mode, and canonical-symlink checks directly; it never sources a
Release verifier through a path it has not already proved.

After the baseline, the wizard restarts `voice-agent-api.service` and
`voice-agent-worker.service`. The service-restart observation passes only for a
new API process instance and a new live worker process instance on the same
Linux boot. The wizard then invokes a real `systemctl reboot` and ends.
Reconnect and run the same command again; the host-reboot observation passes
only when the API itself reads a changed Linux boot identity while the accepted
post-service API and worker fingerprints remain stable. A skipped service
restart, unavailable worker, policy, manifest, state-version, or Release change
fails the campaign.

Authentication and CSRF proof remain entirely inside the owner browser and its
Credential Custody Boundary. The shell receives only campaign, phase, and
challenge identities from the server-owned store; it receives no API response,
cookie, token, policy value, process identity, or boot identity. Every valid
challenge is consumed once. A failed environmental check is appended as
sanitized evidence and the server issues a new phase-scoped challenge for the
retry. Raw API service and Linux boot identities are never durable evidence;
the store retains only domain-separated one-way fingerprints in its private
comparison projection. If a reboot request fails or the API still observes the
old boot, the wizard clears its procedural reboot marker so the append-only
campaign can resume with its new challenge and request another real reboot.
The CLI can only create/resume, inspect, evaluate, and export the server-recorded
campaign through the fixed production database path. Superseded startup
fingerprints form a bounded private comparison projection; accepted phase
observations remain append-only evidence.

By default the record is:

```text
/var/lib/voice-agent/acceptance/issue-83-administrative-autonomy-restart-<release-commit>.json
```

The final machine check, also run by the wizard, is:

```bash
sudo /usr/bin/env node --experimental-strip-types \
  /opt/voice-agent/current/apps/acceptance/src/administrative-autonomy-restart-cli.ts \
  status
```

It exits successfully only when the three server-recorded observations exactly
match the baseline policy, manifest, state version, and Release, both service
instances changed without a reboot and then stayed stable, and the boot
identity later changed. The
`export` command creates the immutable sanitized JSON record only after those
checks pass. Until this attended post-Promotion procedure runs successfully,
the repository contains the acceptance contract and procedure but does not
claim that a real Agent Host reboot has been witnessed.
