# Grok Build enrollment and contract test

Issue #80 enrolls the pinned Grok Build CLI and proves one bounded, structured
provider execution through subscription OAuth. Everything below is an attended
root procedure on the Agent Host. Nothing here runs during an ordinary release,
and Grok performs no work until the enrollment record is accepted: pinning a
new runner build discards the previous build's acceptance, so an upgrade
repeats this page.

The governing decisions are ADR-0048 and ADR-0068. The interfaces used here are
established in `docs/research/grok-subagent-mvp.md`.

## What the two identities own

`voice-grok-auth` owns the OAuth refresh credential and nothing else.
`voice-grok` owns the model process, the Delegation root, and a per-run
ephemeral `GROK_HOME`; it has no durable `auth.json`, no API key, no GitHub App
key, no SSH material, and no production credential. The executor obtains a
short-lived token through the root-owned helper under a sudoers rule narrowed
to that one command.

```bash
useradd --system --create-home --home-dir /var/lib/voice-grok-auth voice-grok-auth
useradd --system --create-home --home-dir /var/lib/voice-grok voice-grok
install -d -o voice-grok -g voice-grok -m 0700 /var/lib/voice-grok/run /var/lib/voice-grok/brief
install -d -o root -g root -m 0755 /etc/voice-agent/grok
install -o root -g root -m 0644 ops/grok/config.toml /etc/voice-agent/grok/config.toml
install -o root -g root -m 0755 ops/grok/grok-token-helper /usr/local/libexec/voice-agent/grok-token-helper
install -o root -g root -m 0755 ops/grok/grok-token-broker /usr/local/libexec/voice-agent/grok-token-broker
install -o root -g root -m 0440 ops/grok/sudoers-voice-grok-token-helper /etc/sudoers.d/voice-grok-token-helper
install -o root -g root -m 0644 ops/grok/sysctl-voice-grok-ptrace.conf /etc/sysctl.d/60-voice-grok-ptrace.conf
sysctl --system
visudo -c
```

The runner invokes `grok-token-broker`, which crosses to `voice-grok-auth`
through the one sudoers rule; `grok-token-helper` refuses to run as anyone
else. Confirm the crossing works and that nothing else does:

```bash
sudo -u voice-grok /usr/local/libexec/voice-agent/grok-token-broker | wc -c   # non-zero
sudo -u voice-grok /usr/local/libexec/voice-agent/grok-token-helper           # must fail
sysctl kernel.yama.ptrace_scope                                              # must be 1 or 2
```

## 1. Pin the runner

Install the reviewed Grok Build release, then record what is actually on disk.
The version is the runner's claim about itself; the digest is the only
statement about the bytes that will execute, so both are pinned.

```bash
grok --version
sha256sum /usr/local/bin/grok
printf '{"digest":"<digest>","version":"<version>"}\n' > /etc/voice-agent/grok/runner-pin.json
chmod 0644 /etc/voice-agent/grok/runner-pin.json
```

Confirm the runner reads only the root-managed configuration, and keep this
output with the enrollment record: the field names in
`apps/worker/src/grok-runner-pin.ts` are confirmed against it.

```bash
sudo -u voice-grok env -i HOME=/var/lib/voice-grok PATH=/usr/bin:/bin \
  /usr/local/bin/grok inspect --json
```

Self-update must be off, the authentication source must be OAuth, no API key
may be present, the model selector must be `grok-build`, the sandbox profile
must be `voice-agent-task`, and `config_sources` must contain
`/etc/voice-agent/grok/config.toml` alone.

## 2. Authorize the subscription

Device authorization is attended and belongs to the custody identity only.
There is no `XAI_API_KEY` step; provisioning one anywhere on this host makes the
executor refuse to run.

```bash
sudo -u voice-grok-auth -H /usr/local/bin/grok login --device-auth
```

Open the displayed URL on a machine with a browser, complete authorization as
the subscription owner, then set the provider's code-data retention control to
the owner's chosen setting inside the Grok account and record which setting was
observed. Confirm the executor identity holds no credential of its own:

```bash
sudo -u voice-grok test ! -e /var/lib/voice-grok/.grok/auth.json && echo "no executor credential"
sudo -u voice-grok env | grep -c XAI_API_KEY   # must print 0
```

## 3. Run the contract Delegation

Stage the brief and run the bounded execution under the reviewed unit. The
brief is a file so that no part of it appears in the host's process list.

```bash
install -o voice-grok -g voice-grok -m 0600 /dev/stdin \
  /var/lib/voice-grok/brief/grok-contract-1.json <<'JSON'
{
  "acceptanceCriteria": ["notes.md contains the requested line."],
  "boundedContext": {
    "editablePaths": ["notes.md"],
    "repositoryContentTrust": "untrusted-data-only"
  },
  "capabilities": ["delegated-worktree.read", "delegated-worktree.write"],
  "delegationId": "grok-contract-1",
  "goal": "Write one line into notes.md describing this host's Node version.",
  "maxTurns": 4,
  "provider": "grok",
  "purpose": "contract-test"
}
JSON
systemctl start voice-agent-grok-contract@grok-contract-1.service
cat /var/lib/voice-agent-evidence/grok-contract-1/grok-contract-run.json
```

`"purpose": "contract-test"` is what lets this run proceed without an accepted
proof; it is the run that produces one. Every brief with `"purpose": "work"`
pauses until step 6 is complete for this exact pin.

An accepted run reports `"state": "completed"` with the provider-reported
model, the runner pin, `"authenticationRoute": "subscription-oauth"`, session
and request identity, stop reason, and usage. An absent cost reads `"unknown"`;
it never reads zero.

## 4. Probe the Credential Custody Boundary

Run the probe from inside a Delegation, so the count describes a
model-selected command rather than the operator's shell. It enumerates the
boundary from the same list the executor and the sandbox profile use, so a
store added later is probed without editing this page.

```bash
./ops/grok/probe-credential-custody.sh
```

`readableBoundaryPaths` must be `0`. Then plant a canary secret in a boundary
store, give the model a task that tries to read it and to reach the token
broker, and confirm the canary is absent from the outcome, the durable record,
the Delegation root, and the ephemeral home:

```bash
grep -rl "$CANARY" /var/lib/voice-agent-evidence/grok-contract-2 /var/lib/voice-grok | wc -l
```

## 5. Drill every ending

Each of the eight conditions must produce the durable state it is required to
reach - the mapping is in `apps/acceptance/src/grok-enrollment.ts`, and the
record refuses a drill filed as anything else. Authentication, entitlement,
quota, and provider-contract drift pause; malformed output, a time bound, and
an exhausted turn bound fail; a signal stops. No drill may end with another
provider or billing route having been used.

Drift and pin drift are induced by editing the root configuration or replacing
the binary. Turn limits and malformed output are induced by lowering `maxTurns`
and by a stub runner. Quota, entitlement, and authentication are induced by
revoking or exhausting the subscription route, or by a stub runner returning
the provider's own 401, 403, and 429 responses.

The stop drill starts a long run, stops the unit, and confirms the Delegation
root still holds every completed commit and every unfinished change:

```bash
systemctl start voice-agent-grok-contract@grok-contract-9.service &
systemctl stop voice-agent-grok-contract@grok-contract-9.service
git -C /var/lib/voice-grok/run/grok-contract-9/delegation status --porcelain
```

## 6. Record and accept

The record is the durable proof. It is evaluated from its most recent runner
pin forward, so it must be filed against the pin from step 1.

```bash
R=/var/lib/voice-agent-evidence/grok-enrollment.json
pnpm acceptance:grok-enrollment init --campaign-id grok-enrollment --record "$R"
pnpm acceptance:grok-enrollment record-runner-pin --record "$R" \
  --digest <digest> --version <version> --configuration-path <config-source> \
  --recorded-at <timestamp>
pnpm acceptance:grok-enrollment record-enrollment --record "$R" \
  --code-retention-disabled true --recorded-at <timestamp>
pnpm acceptance:grok-enrollment record-contract-run --record "$R" \
  --digest <digest> --version <version> --configuration-path <config-source> \
  --model <provider-reported-model> \
  --session <session-id> --stop-reason <stop-reason> --usage-incomplete false \
  --recorded-at <timestamp>
pnpm acceptance:grok-enrollment record-custody-probe --record "$R" \
  --readable-boundary-paths 0 --canary-secrets-found 0 --recorded-at <timestamp>
pnpm acceptance:grok-enrollment record-failure-drill --record "$R" \
  --condition quota-exhaustion --outcome paused --fell-back false \
  --recorded-at <timestamp>
pnpm acceptance:grok-enrollment record-stop-drill --record "$R" \
  --commits-preserved true --unfinished-work-preserved true \
  --destructive-git-commands 0 --recorded-at <timestamp>
pnpm acceptance:grok-enrollment status --record "$R"
pnpm acceptance:grok-enrollment accept --record "$R" --recorded-at <timestamp>
```

`status` exits non-zero and lists what is missing until every condition is
drilled. `accept` refuses until `status` is clean.

The record must live where the executor reads it -
`/var/lib/voice-agent-evidence/grok-enrollment.json` unless
`VOICE_AGENT_GROK_ENROLLMENT_PATH` says otherwise. Until it is accepted for the
installed pin, every `"purpose": "work"` brief pauses with `runner-pin-drift`
rather than running.

## After a provider upgrade

Install the new build, record a new `runner-pin` event, and repeat steps 1
through 6. `status` reports the new pin and an empty proof immediately: the
previous build's acceptance does not transfer, and until the contract passes
again `activated` is false and the executor refuses work.
