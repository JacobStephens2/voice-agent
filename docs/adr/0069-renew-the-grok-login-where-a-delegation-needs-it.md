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

The probe does not renew a login that has not expired yet, because the runner
will not - it renews on expiry rather than proactively, observed both ways. So
a Delegation can still begin with minutes left on the credential and reach
expiry while it runs, and what carries it through is the same crossing running
again: the runner reaches for its auth provider when the credential it holds
has expired, which is observed, and the helper renews on that invocation
exactly as it does on the probe. The helper hands the runner the lifetime
alongside the token, in the JSON form of Grok's provider contract rather than
as a bare token, so the re-mint is expected to come before a request is spent
on an expired token rather than after one fails with it. That last property -
proactive re-minting from `expires_in` - is xAI's documented behaviour and is
the one link in this chain not established on the binary; the ending if it does
not hold is a pause naming authentication, not a wrong credential.

The probe crosses as a status, not a token. `--probe` prints the remaining
lifetime and nothing else, under a second sudoers rule that fixes the whole
argument list exactly as the first one does, so establishing that a Delegation
has a credential never puts one in the executor's memory. The exit codes are
the contract: `apps/worker/src/grok-credential-lifetime.ts` turns them into the
Delegation's ending, in this system's own words, and the helper's standard
error - which names a file path and a scope - reaches no durable record. Each
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
loses to it, observed the same way everything else here was. Layers merge per
key, so the system layer's own boundaries - self-update off, the model
selector, the environment policy - are untouched by a home-local layer that
declares only `[auth]`. The staged file is arguably better attested than the
one it left: it comes from a reviewed Release rather than from a hand-run
enrollment, it is written fresh for each run, and it is removed with the home.

## Consequences

A Delegation begun after expiry now completes, because the check that would
have refused it is the renewal. One begun shortly before expiry completes on
the re-mint the runner makes when the token it holds runs out, through the same
helper. One whose login cannot be renewed at all pauses naming expiry instead
of failing partway through with a provider error the Durable Task could not
explain. The cost is one extra crossing before every run, about a third of a
second when there is nothing to renew.

The enrollment wizard asserts what this decision depends on: that both broker
crossings answer, and that `/etc/grok/requirements.toml` declares no `[auth]`
table. A host that reintroduces one would not fail visibly - Delegations would
keep working until the next expiry, and then stop - which is exactly the kind of
silence this repository refuses to ship, so it is checked at the one attended
moment where it can be.

Nothing here extends what a Delegation may reach. The refresh token is not
disclosed to `voice-grok`, to a model-selected command, or to any durable
record; the only things that cross the boundary are one short-lived access
token, its lifetime, and a status.
