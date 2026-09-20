# Renew the Grok login where a Delegation needs it

ADR-0068 enrolls a subscription-authenticated Grok Build CLI whose credential
turns out to last about six hours. The entry at
`/var/lib/voice-grok-auth/.grok/auth.json` carries `expires_at` roughly six
hours after `create_time`, beside a `refresh_token`, and nothing in the path
that reaches it renews anything: the executor runs as `voice-grok` with no
credential, the crossing is a broker, and the helper on the far side reads the
file. So roughly six hours after each attended login every Delegation stopped,
with `ops/grok/grok-token-helper` refusing an expired token rather than handing
one out mid-run - a clear failure standing in for a renewal nobody had written.

The renewal is first-party. grok 1.0.13 spends the refresh token itself: an
authenticated command over an expired OIDC entry performs the refresh and
rewrites the entry six hours out, observed against the installed binary rather
than inferred from xAI's documentation, which describes no such thing.
`grok --no-auto-update models` is the cheapest such command - it asks the
account what it may select and spends no model tokens - and it renews only what
has actually expired; a valid entry is left alone. This repository therefore
implements no OAuth refresh of its own, and the refresh token, the issuer, and
the client id stay where they were: with one identity, unread by anything else.

It runs where the credential is needed rather than on a schedule. Before every
Delegation the executor asks the broker to probe, and the helper renews an
expired login and answers with the credential's remaining lifetime. There is no
periodic timer, and that is the point: a renewal that only ever runs when a
Delegation is about to need one has no failure that can go unnoticed, and no
unattended process holds the credential open between Delegations.

**A headless run never reaches the auth crossing, so the run's own login is
what does.** This was the one link in the chain not established on the binary,
and observing it on 2026-08-31 refuted it. With the reviewed crossing staged
and reported by `inspect`, a headless `--output-format json` run does not
invoke `auth_provider_command` at all: a run whose home holds no credential
fails in a fifth of a second with "Not signed in", and one whose credential
expired forty-eight seconds ago fails the same way, while `grok models` in that
same home a few seconds later invokes the provider and re-mints. The executor
therefore signs each run's own Grok home in through the broker - one
`grok login`, which invokes the crossing, needs no browser when one answers,
and completes in about half a second - and only then spawns the model. It
stages the reviewed crossing again afterwards, because the login removes
`$GROK_HOME/requirements.toml` on its way out, and reads it back a second time
so the model never runs under a layer this contract has not seen.

**There is no proactive re-mint, so the credential must outlast the run.** A
run begun with three seconds left on its credential spent 305 output tokens and
4.6 seconds of model time on one request, got a 401 back, and left the cached
entry untouched; the broker was not invoked a second time. xAI's documented
`expires_in` contract does not hold for a headless run on this build - the
runner spends the token it was handed until it fails. So the lifetime is
checked against the run's own time bound before anything is spent, and a
Delegation the login cannot outlast pauses naming authentication rather than
paying for a request that will be refused.

The bound it is checked against is the run's whole time bound, thirty minutes,
rather than an estimate of how long this particular Delegation will take. There
is no such estimate to have: the executor knows what it will permit and not
what the model will need. The cost is the last half hour of each six-hour
credential, which a Delegation waits out rather than spends. It is checked
twice, at the probe and again against what the login actually minted, and the
second is the one the observation forces - the first only saves an invocation
of the crossing when the answer is already known, and both call the same rule.

That pause clears without an attended action: the login is renewed on expiry,
so the next probe past `expires_at` returns a full six hours. When one does
slip through anyway, the ending is still a pause naming authentication rather
than a failed run - the runner's own standard error carries the 401,
`apps/worker/src/grok-run-outcome.ts` reads it as a provider refusal, and the
recorded envelope is the fixture that test runs on.

The probe crosses as a status, not a token. `--probe` prints the remaining
lifetime and nothing else, under a second sudoers rule that fixes the whole
argument list exactly as the first one does, so establishing that a Delegation
has a credential never puts one in the executor's memory. The exit codes and
that lifetime are the contract: `apps/worker/src/grok-credential-lifetime.ts`
turns them into the Delegation's ending, in this system's own words, and the
helper's standard error - which names a file path and a scope - reaches no
durable record. Each
ending is a pause. An expired login that would not renew, an unenrolled custody
identity, and a credential that is not the subscription login pause with
`provider-authentication`; a reachable deployment-key or API-key route and a
crossing that did not land on the custody identity pause with
`provider-contract-drift`. None of them is a defect in this system and none is
a reason to select another provider.

**When renewal fails, the login is gone rather than stale.** The runner clears
`auth.json` when the issuer refuses a refresh, so a revoked or expired refresh
token leaves the custody identity holding nothing. Nothing here retries and
nothing falls back: the Delegation pauses with a detail naming expiry, its
Delegation root and completed commits untouched, and it resumes after an
attended `grok login --device-auth`. This is the same shape ADR-0068 gives
every other provider refusal, and it is why the probe runs before the model is
spawned rather than after a request has failed.

## Where the auth crossing is named

One consequence is unavoidable and worth stating plainly, because it moves a
boundary ADR-0068 established. An external auth provider takes precedence over
renewing an expired cached login: with `auth_provider_command` configured, an
expired entry sends the runner to the provider and no refresh is attempted at
all. `/etc/grok/requirements.toml` binds every identity on the host, so naming
the broker there would bind `voice-grok-auth` too - and the one process that
can renew this credential would be sent to the broker that exists to read it.
The crossing is therefore named in each run's own
`$GROK_HOME/requirements.toml`, staged by the executor from the reviewed
Release beside the sandbox profile it already stages there, and read back
before the run to confirm it is the reviewed one and carries nothing else.

That is a weaker place than the host-wide layer only in one respect, and the
respect that matters is preserved: `requirements` is still the role a project
directory cannot override, so a `.grok/config.toml` inside a Delegation root
loses to it, observed the same way everything else here was. The two coexist,
observed on the Agent Host with both installed: `inspect --json` reports the
host-wide file in a role of its own, `system-requirements`, beside the run's
`requirements` layer, and they merge per key - with the home-local layer
declaring only `[auth]`, the system layer's own boundaries are still in force,
`models default` included. The staged file is arguably better attested than the
one it left: it comes from a reviewed Release rather than from a hand-run
enrollment, it is written fresh for each run, and it is removed with the home.

The fourth role is not a spelling detail. The pin check required exactly one
non-empty layer, with role `requirements`, at the pinned path; installing the
reviewed `/etc/grok/requirements.toml` would have paused every Delegation on
that check. It now requires exactly two: the system layer at the pinned path,
and this run's own crossing at this run's own home.

## Consequences

A Delegation begun after expiry now completes, because the check that would
have refused it is the renewal. One begun inside the run's own time bound of
expiry does not start at all: the runner will not re-mint part way through, so
it pauses naming authentication until the credential expires and the next probe
renews it. One whose login cannot be renewed at all pauses naming expiry
instead of failing partway through with a provider error the Durable Task could
not explain. The cost is two crossings before every run rather than one - the
probe at about a third of a second when there is nothing to renew, and the
login at about half a second - and a Delegation that has to wait out the last
half hour of a six-hour credential rather than spending it.

The enrollment wizard asserts what this decision depends on: that both broker
crossings answer, and that `/etc/grok/requirements.toml` names no
`auth_provider_command`. A host that reintroduced one would not fail visibly -
Delegations would keep working until the next expiry, and then stop - which is
exactly the kind of silence this repository refuses to ship, so it is checked at
the one attended moment where it can be, and again before every run: the
executor reads the pinned layer back rather than inferring it from `inspect`,
which reports the policy the layer produced and not the keys that produced it.

The check is written against the key rather than the table, and issue #167 is
why. That layer now carries `[grok_com_config] disable_api_key_auth = true`,
which is what makes `loginPolicy.apiKeyAuthDisabled` true; `[auth]` is an alias
of `[grok_com_config]`, so a check on the table name would have read one
spelling and missed the other. The key is refused by name anywhere in the file
rather than by the heading it sits under, because TOML has more spellings for a
key - an inline table, a quoted key, a sub-table - than a line-oriented reader
has, and the word has no legitimate use in this layer at all. Adding the refusal
does not reopen the hazard above: it configures no provider and starts no
command, so the custody identity's own renewal is untouched.

Nothing here extends what a Delegation may reach. The refresh token is not
disclosed to `voice-grok`, to a model-selected command, or to any durable
record; the only things that cross the boundary are one short-lived access
token, its lifetime, and a status.
