# Grok Build enrollment and contract test

Issue #80 enrolls the pinned Grok Build CLI and proves one bounded, structured
provider execution through subscription OAuth. Run the repeatable attended
procedure on the Agent Host:

```bash
./ops/acceptance/run-grok-enrollment.sh
```

The wizard walks the eight stages below, runs every check it can make itself,
and files each Enrollment Event through the reviewed CLI as you go. It stops at
the first boundary that does not hold rather than recording around it. The rest
of this page is the reference the wizard follows: read it when a stage refuses,
or when you are doing this by hand.

Everything here is an attended root procedure. Nothing runs during an ordinary
release, and Grok performs no work until the enrollment record is accepted:
pinning a new runner build discards the previous build's acceptance, so an
upgrade repeats this page.

The governing decisions are ADR-0048, ADR-0068, and ADR-0069. The interfaces used here are
established in `docs/research/grok-subagent-mvp.md` and corrected against the
released binary in
[`docs/research/grok-build-install-and-auth.md`](../research/grok-build-install-and-auth.md).

> **One boundary is weaker than the design intended.** `restrict_network` and
> sandbox `deny` rules both make the runner refuse to start on this host, so
> model-selected child processes are not confined by the sandbox's network
> restriction. Custody is held instead by the executor identity's own
> permissions and the systemd unit. Issue #161 carries the unresolved network
> restriction; read it before treating a Delegation as network-isolated.

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
install -d -o root -g root -m 0755 /etc/voice-agent/grok /etc/grok
install -o root -g root -m 0644 ops/grok/requirements.toml /etc/grok/requirements.toml
install -o root -g root -m 0440 ops/grok/sudoers-voice-grok-token-helper /etc/sudoers.d/voice-grok-token-helper
install -o root -g root -m 0644 ops/grok/sysctl-voice-grok-ptrace.conf /etc/sysctl.d/60-voice-grok-ptrace.conf
sysctl --system
visudo -c
```

`/etc/grok/requirements.toml` is the one configuration layer a project
directory cannot override, and the executor refuses to run unless `inspect`
reports it as the only layer in effect. The reviewed sandbox profile is not
installed here at all: a custom profile must live beside the runner's home, and
each run's home is created fresh, so the executor stages
`ops/grok/sandbox.toml` into it from the Release.

Neither is the auth crossing. `/etc/grok/requirements.toml` carries no `[auth]`
table on purpose: it binds every identity on this host, and an auth provider
configured for all of them would also bind `voice-grok-auth`, whose own `grok`
is the only thing that can renew the six-hour login. The runner prefers a
provider command over renewing an expired cached login, so a host-wide
`auth_provider_command` sends the custody identity to the broker that reads the
credential instead of to the issuer that renews it. The executor stages
`ops/grok/run-requirements.toml` into each run's own home instead, as a
`requirements` layer so that a Delegation root's `.grok/config.toml` still
cannot override it. ADR-0069 records this.

The token helper, the token broker, and `voice-agent-grok-contract@.service`
are not installed by that block. They are reviewed root authority, listed in
`ops/release/deployment-authority-manifest.sh`, and reach the host only through
the attended upgrade below - which shows you every authority difference it will
pin and requires a Fresh Passkey Action to authorize:

```bash
cd /opt/voice-agent/current
./ops/upgrade-agent-host-deployment-authority.sh
```

Run it after the release carrying them is promoted. A host that could start a
Grok Delegation without the reviewed unit would run the model with whatever
boundary the invoking shell happened to have, which is the boundary this unit
exists to replace.

The runner invokes `grok-token-broker`, which crosses to `voice-grok-auth`
through the sudoers rules; `grok-token-helper` refuses to run as anyone else.
The broker answers in two ways: with no argument it prints one access token
payload for the runner, and with `--probe` it prints only the credential's
remaining lifetime, which is what the executor asks for before it spawns a
model. Confirm both crossings work and that nothing else does:

```bash
sudo -u voice-grok /usr/local/libexec/voice-agent/grok-token-broker --probe   # {"expires_in":N}
sudo -u voice-grok /usr/local/libexec/voice-agent/grok-token-broker | wc -c   # non-zero
sudo -u voice-grok /usr/local/libexec/voice-agent/grok-token-helper           # must fail
sysctl kernel.yama.ptrace_scope                                              # must be 1 or 2
```

## The credential's six-hour lifetime

The enrolled entry carries `expires_at` about six hours after `create_time`,
beside a `refresh_token`. Nothing on a schedule renews it. The renewal happens
where the credential is needed: the executor asks the broker to probe before
every Delegation, and the helper on the far side renews an expired login by
running the pinned runner's own `grok --no-auto-update models` under the
custody identity, which spends the refresh token itself and rewrites the entry
six hours out. Observed against grok 1.0.13; see the addendum in
[`docs/research/grok-build-install-and-auth.md`](../research/grok-build-install-and-auth.md).

A run is bounded at thirty minutes, so a Delegation that starts on a freshly
renewed credential cannot reach expiry while it runs. The token the runner
holds carries its lifetime with it, so the runner re-mints through the broker
before spending an expired one rather than failing a request with it.

**A refusal by the issuer deletes the login rather than leaving it stale.** The
runner clears `auth.json` when a refresh fails, so a refresh token the account
has revoked, expired, or invalidated leaves the custody identity with no
credential at all. That ending is a pause, not a failure: the Delegation stops
with `provider-authentication` and a detail naming expiry, its Delegation root
and completed commits untouched, and it resumes after an attended

```bash
sudo -u voice-grok-auth -H /usr/local/bin/grok login --device-auth
```

Nothing retries around this, and nothing falls back to another route.

## Install the runner

xAI supports one route on Linux: a `curl | bash` script from `x.ai/cli`. Do not
pipe it into a root shell. The installer places the binary under a user's
`~/.grok/bin` and symlinks it opportunistically, which is the opposite of what
a pinned host wants, so fetch the exact versioned artifact and install it
yourself. Both the URL shape and the channel pointer are recorded in
[`docs/research/grok-build-install-and-auth.md`](../research/grok-build-install-and-auth.md).

```bash
curl -fsSL https://x.ai/cli/stable                      # the current stable version
VERSION=<the version you reviewed>                     # 1.0.13 at the time of writing
curl -fsSL -o /tmp/grok "https://x.ai/cli/grok-${VERSION}-linux-x86_64"
sha256sum /tmp/grok
install -o root -g root -m 0755 /tmp/grok /usr/local/bin/grok
/usr/local/bin/grok --version
```

Use the absolute path. A personal `~/.local/bin/grok` earlier on `PATH` will
answer `grok --version` instead, which on the first host this ran on reported a
different build than the one just installed.

**xAI publishes no checksum, signature, or digest for these artifacts.** The
installer's only integrity check is that the downloaded file runs and prints a
version, and `xai-org/grok-build` has no GitHub releases; probes for `.sha256`,
`.sig`, and provenance files all return 404. So the digest recorded in the next
section is computed from the bytes you just downloaded. It defends against the
runner changing underneath this host afterwards - self-update, tampering, an
unreviewed reinstall - and it cannot attest that the download itself was
authentic. That is a property of the supply chain, not of this pin, and it is
the reason self-update must stay off.

`--no-auto-update` must come **before** a subcommand; `grok inspect --json
--no-auto-update` exits 2. Release builds self-update by default, so the flag is
load-bearing rather than belt-and-braces.

## 1. Pin the runner

Read the runner's own effective configuration first: `configSources` is what
tells you which layer this build actually reads, and the pin records it
alongside the version and digest.

```bash
/usr/local/bin/grok --version
sha256sum /usr/local/bin/grok
sudo -u voice-grok env -i HOME=/var/lib/voice-grok PATH=/usr/bin:/bin \
  /usr/local/bin/grok --no-auto-update inspect --json
```

`--no-auto-update` precedes the subcommand; after it, the runner exits 2.

Confirm `grokVersion` matches what you installed, `loginPolicy.apiKeyAuthDisabled`
is `true`, nothing is declared under `mcpServers`, `plugins`, `skills`, `hooks`,
`marketplaces`, or `lspServers`, no `externalCompat` vendor surface is enabled,
and `configSources.layers` holds exactly one non-empty layer whose `role` is
`requirements`. Those are the field names grok 1.0.13 actually emits, recorded
in `apps/worker/src/grok-runner-pin.ts`. The model selector, always-approve,
the turn bound, and the sandbox profile are fixed on the command line instead,
where a project directory cannot reach them.

Then pin the three facts together:

```bash
printf '{"configurationPath":"/etc/grok/requirements.toml","digest":"<digest>","version":"<version>"}\n' \
  | sudo tee /etc/voice-agent/grok/runner-pin.json
sudo chmod 0644 /etc/voice-agent/grok/runner-pin.json
```

The executor re-reads the inspection before every run and pauses unless that
requirements layer is the only one in effect.

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
grep -c '^\[auth\]' /etc/grok/requirements.toml   # must print 0
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
