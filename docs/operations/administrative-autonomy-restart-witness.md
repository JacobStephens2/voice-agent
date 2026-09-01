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

The wizard first records the exact `revision` and `stateVersion` returned by the
deployed authenticated `GET /api/administrative-autonomy` route. It then
restarts `voice-agent-api.service` and `voice-agent-worker.service`, verifies
both units, and records a second authenticated API observation. Before reboot,
it appends a durable policy checkpoint and retains the current Linux boot ID in
a root-only transient file. The wizard invokes a real `systemctl reboot` and
ends. Reconnect and run the same command again; it refuses the host-restart
observation unless Linux reports a different boot ID, then rechecks both units
and the deployed authenticated API.

The session cookie is entered through hidden input, passed to `curl` over
standard input rather than a process argument, and never written to the
acceptance record. The raw boot IDs are compared locally and removed after the
observation. The append-only record retains only the Release commit, exact
policy revision/state version, fixed authenticated API provenance, and
sanitized pass/fail outcomes. Failed observations remain in its history and a
later attended retry appends new evidence.

By default the record is:

```text
/var/lib/voice-agent/acceptance/issue-83-administrative-autonomy-restart-<release-commit>.json
```

The final machine check, also run by the wizard, is:

```bash
sudo /usr/bin/env node --experimental-strip-types \
  /opt/voice-agent/current/apps/acceptance/src/administrative-autonomy-restart-cli.ts \
  status \
  --record /var/lib/voice-agent/acceptance/issue-83-administrative-autonomy-restart-<release-commit>.json
```

It exits successfully only when both post-disruption observations are active,
authenticated, schema-valid, and exactly match the pre-restart revision and
state version, and when the reboot observation carries the real boot-identity
change proof. Until this attended post-Promotion procedure runs successfully,
the repository contains the acceptance contract and procedure but does not
claim that a real Agent Host reboot has been witnessed.
