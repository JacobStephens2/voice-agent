# Grok Build `loginPolicy`: where `apiKeyAuthDisabled` comes from

_Researched 2026-09-02 against primary sources only: xAI's Grok Build
documentation on docs.x.ai, the configuration reference the `grok` binary
carries and extracts to `~/.grok/docs/user-guide/`, and the shipped 1.0.13
binary itself, exercised in throwaway `GROK_HOME` directories on this
workstation._

_Binary inspected: `/Users/jacob/.grok/downloads/grok-1.0.13-macos-aarch64`,
SHA-256 `8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80`,
reporting `grok 1.0.13 (5e9a58528b76) [stable]`. This is the same released
version as the Agent Host's Linux build recorded in
[`grok-build-install-and-auth.md`](grok-build-install-and-auth.md)
(`edf7952158…`, which reports `[alpha]`); the channel label differs by platform
build, the version does not. **Nothing was run against the Agent Host.**_

## The question

Issue #167 asks where `loginPolicy.apiKeyAuthDisabled` is set: whether it is
host-configurable at all, whether a personal (non-team, non-enterprise) Grok
subscription can express it, and whether `forceLoginTeamUuid` - which travels
in the same struct - is the same kind of setting. ADR-0068 makes that field
load-bearing: it is the one place the runner reports on the subscription being
the only reachable route, and both `describeGrokConfigurationDrift`
(`apps/worker/src/grok-runner-pin.ts:189`) and stage 2 of
`ops/acceptance/run-grok-enrollment.sh` refuse to pass while it is false.

## Headline

**It is host-configurable, and the earlier negative result was a wrong table
name.** `loginPolicy` is not an account, team, or enterprise setting delivered
from xAI's servers. It is resolved entirely from the local configuration
layers, and the key that drives it is `disable_api_key_auth` under
**`[grok_com_config]`** (or its alias **`[auth]`**) - not under
`[login_policy]`, which is not a table the CLI reads at all. The 2026-08-31
addendum in
[`grok-build-install-and-auth.md`](grok-build-install-and-auth.md) tried
`[login_policy] disable_api_key_auth = true`, saw `disableApiKeyAuth` stay
`null`, and concluded the field was not host-configurable on 1.0.13. That
observation is reproducible and correct as an observation; the conclusion drawn
from it is wrong. With the documented spelling the field moves, in the
`requirements` layer, on a personal login, with no team and no enterprise plan
involved.

A personal subscription can therefore express `apiKeyAuthDisabled`.
`forceLoginTeamUuid` is the *same kind* of setting - same table, same `pin`
scope, same local file - but a personal account cannot usefully *satisfy* it,
because it is matched against a team principal a personal login does not carry.

---

## 1. Where the field is set

### 1.1 What the first-party documentation says

docs.x.ai's Grok Build **Enterprise Deployments** page, section *Restricting
login methods* (<https://docs.x.ai/build/enterprise>), fetched 2026-09-02:

> Two policies control how users authenticate. Set them in `requirements.toml`
> so a user `config.toml`, an environment variable, or a remote setting cannot
> override them.
>
> `disable_api_key_auth` forces interactive IdP login. The `xai.api_key` method
> is no longer offered or accepted, and at request time a first-party xAI API
> key is replaced with the IdP session token, so a leftover `XAI_API_KEY` or
> per-model key cannot skip SSO. Third-party (BYOK) endpoints keep working,
> since their `base_url` is not on x.ai; restrict those through your own
> provider IAM.

with the example, verbatim:

```toml
[grok_com_config]
disable_api_key_auth = true
```

Three things follow directly from that text. The setting lives in a file on the
host. Its table is `[grok_com_config]`. And a *remote setting* is explicitly
named as something it overrides - which is the documentation's own statement
that the server-delivered settings channel is below this, not the source of it.

### 1.2 What the binary's own configuration reference says

The `grok` binary carries its configuration reference and extracts it on launch
to `~/.grok/docs/user-guide/26-config-reference.md`. Lines 58-59 and 256-257 of
that file (identical strings are present in the binary itself, findable with
`strings -a` on the executable):

| Key | Type / Values | Requirements | Managed | Details |
| --- | --- | --- | --- | --- |
| `auth.disable_api_key_auth` | `boolean` | `pin` | `user` | Refuse API-key auth so only the deployment IdP can log in. Also GROK_DISABLE_API_KEY_AUTH; also valid as `grok_com_config.disable_api_key_auth`. |
| `auth.force_login_team_uuid` | `string / string[]` | `pin` | `user` | Require login to this team UUID, or any of an array; empty array fails closed. Also GROK_FORCE_LOGIN_TEAM_ID; also valid as `grok_com_config.force_login_team_uuid`. |

The same file states that `[auth]` is an alias: *"`auth` | `table` | ... Alias
of `[grok_com_config]`; every `grok_com_config.*` key also works as
`auth.*`."* And it defines the `Requirements` column: *"`pin` cannot be
overridden (including env and CLI where the resolver honors the pin)."*

There is no `[login_policy]` table anywhere in that reference. `login_policy`
appears in the binary only as an internal log field
(`crates/codegen/xai-grok-shell/src/auth/manager.rs:721`, *"auth: cached session
rejected by login policy; clearing"*), never as a configuration key.

### 1.3 What the binary demonstrates

Run against the local 1.0.13 binary with `--no-auto-update`, each row a
throwaway `GROK_HOME` containing only the file named, reading
`grok inspect --json | .loginPolicy`:

| Layer and spelling | `disableApiKeyAuth` | `forceLoginTeamUuid` | `apiKeyAuthDisabled` |
| --- | --- | --- | --- |
| empty home | `null` | `null` | `false` |
| `requirements.toml`, `[login_policy] disable_api_key_auth = true` | `null` | `null` | `false` |
| `requirements.toml`, `[auth] disable_api_key_auth = true` | **`true`** | `null` | **`true`** |
| `requirements.toml`, `[grok_com_config] disable_api_key_auth = true` | **`true`** | `null` | **`true`** |
| `requirements.toml`, `= false` | `false` | `null` | `false` |
| user `config.toml`, `[auth] disable_api_key_auth = true` | **`true`** | `null` | **`true`** |
| env `GROK_DISABLE_API_KEY_AUTH=1`, empty home | **`true`** | `null` | **`true`** |
| `requirements.toml` `= true` **+** user `config.toml` `= false` | **`true`** | `null` | **`true`** |
| `requirements.toml` `= true` **+** env `GROK_DISABLE_API_KEY_AUTH=0` | **`true`** | `null` | **`true`** |

The second row reproduces the Agent Host observation exactly
(`{null, null, false}`), which is what identifies the earlier result as a
spelling failure rather than a build limitation. The last two rows confirm the
documented `pin` semantics: the `requirements` layer wins over both the user
file and the environment, in the direction that matters (a lower layer cannot
turn the policy *off*).

`grok inspect` renders the same three values in its human output under a
`Login Policy` heading:

```
  Login Policy
  └ disable_api_key_auth: true
  └ force_login_team_uuid: (none)
  └ api_key_auth_disabled: true
```

**No network, no account, no team.** Every `true` above was produced in a
`GROK_HOME` with no `auth.json` - no login of any kind, personal or otherwise.
The policy is resolved from files before any credential exists, which is the
strongest available demonstration that it is not delivered from xAI's servers.

## 2. Can a personal subscription express it?

**Yes, and there is no dashboard, console page, or API involved.** The setting
is not account-scoped in any form. There is nothing to enable on an account,
because the account is not consulted: the owner of the host writes one key into
a TOML file the `grok` process reads at startup.

Searching the Grok Build documentation for an administrative surface that
carries this returns nothing: docs.x.ai's Settings page
(<https://docs.x.ai/build/settings>) does not mention `disable_api_key_auth` at
all, and the Enterprise Deployments page presents the control only as a
`requirements.toml` key. The word *enterprise* in that page's title describes
the intended audience and the distribution mechanism it discusses (*"Mobile
Device Management (MDM), golden images, configuration management tools, or
onboarding scripts"*), not an entitlement gate on the key.

For this repository, that means the fix is one table in the file ADR-0068
already pins. `ops/grok/requirements.toml` carried no `[auth]` table when this
was written, and its comment gave the reason: an `auth_provider_command`
configured host-wide would bind `voice-grok-auth` too and preempt the credential
refresh ADR-0069 depends on. `disable_api_key_auth` is a different key that
happens to share that table. It configures no provider and starts no command, so
adding it alone does not re-create the ADR-0069 hazard.

_Landed 2026-09-02: that layer now carries `[grok_com_config]
disable_api_key_auth = true`, and the guard that was held by the table's absence
is held by the key instead - `describeSystemRequirementsDrift` and the
enrollment wizard both refuse `auth_provider_command` under any heading, and the
executor reads the pinned layer back before every run._

## 3. Is `forceLoginTeamUuid` the same kind of setting?

**Structurally yes; practically it is the one a personal account cannot use.**

It is the same table, the same `pin` scope, the same file, with the same
environment alias (`GROK_FORCE_LOGIN_TEAM_ID`) - see the reference table in
§1.2. It was set to a fabricated UUID in a throwaway home and appeared verbatim
in `loginPolicy.forceLoginTeamUuid`, which confirms the value is not validated
against a server at load time.

What differs is what it is compared against. docs.x.ai, same section:

> `force_login_team_uuid` pins login to a team. The token's team principal must
> match the configured value, so a personal login or a login to the wrong team
> is rejected with an error and nothing is written to `auth.json`. You can set a
> single team UUID or a list, in which case any team in the list is allowed; an
> empty list rejects every login. **Setting this also turns on
> `disable_api_key_auth`**, because a bare API key does not carry team
> membership. […] The value is the team's UUID, which the access token carries
> as its login principal. Enforcement applies every time a session is issued or
> reused, including cached tokens and silent refreshes. A session that no longer
> complies is cleared, so the user has to log in again.

The binary carries the matching refusals:
`OIDC id_token validation failed: no team principal`,
`OIDC: login principal does not satisfy required policy; rejecting`, and
`Login is blocked by your administrator: force_login_team_uuid is an empty
list, so no team is permitted to sign in`.

So a personal subscription owner *can set* `force_login_team_uuid`, and it
would fail closed against their own login. It is not a usable control here, and
it is not needed: the `disable_api_key_auth` key reaches the same
`apiKeyAuthDisabled` bit on its own.

## 4. The two fields are not duplicates

The struct's three members have distinct meanings, established by holding one
constant and moving the other:

| Field | Meaning |
| --- | --- |
| `disableApiKeyAuth` | the **configured knob**, an optional boolean: `null` when no layer set it |
| `forceLoginTeamUuid` | the **configured team pin**, a string or array, `null` when unset |
| `apiKeyAuthDisabled` | the **effective policy**, always a boolean |

The discriminating observation: a `requirements.toml` containing only
`[grok_com_config] force_login_team_uuid = "…"`, with no `disable_api_key_auth`
anywhere, yields

```json
{ "disableApiKeyAuth": null, "forceLoginTeamUuid": "11111111-…", "apiKeyAuthDisabled": true }
```

- the knob is untouched and the effective policy is on, exactly as the
documentation's *"Setting this also turns on `disable_api_key_auth`"* predicts.
An empty array (`force_login_team_uuid = []`) does the same.

Internally the binary logs these as a pair, `disable_api_key_auth_knob`
alongside `api_key_auth_disabled`, near
`auth: enterprise login policy active` and `has_enterprise_oidc`
(`crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs`), which is
consistent with `apiKeyAuthDisabled` being the resolved value of several
inputs rather than a mirror of one.

**This vindicates the field `describeGrokConfigurationDrift` already reads.**
`grok-runner-pin.ts:189` checks `apiKeyAuthDisabled`, the effective bit, not
`disableApiKeyAuth`, the knob. That is the correct one of the two, and it stays
correct however the policy comes to be true.

## 5. What this means for the decision in #167

The premise behind the alternatives - that the account cannot express the field
- does not hold, so the alternatives are no longer a substitute for it. They
remain worth keeping as defence in depth, but only one of the four is
runner-enforced policy:

| Control | Enforced by | Runner-enforced policy? |
| --- | --- | --- |
| `loginPolicy.apiKeyAuthDisabled` via `requirements.toml` | the Grok process, before any credential is used, at a layer a Delegation root cannot override | **Yes.** The provider refuses the API-key route itself, and per docs.x.ai substitutes the IdP session token for a first-party key at request time |
| the enrolled credential's `auth_mode: "oidc"` | `ops/grok/grok-token-helper:88`, this repository | No. It is *evidence about the credential in use*, checked by our code on every use. It says the token we hand over came from OIDC; it does not stop the runner accepting some other route |
| executor refusing `XAI_API_KEY` / `GROK_DEPLOYMENT_KEY` in its environment | ADR-0068's executor, and `ops/grok/grok-token-helper:58`, this repository | No. Our own precondition, in our own process. It is also narrower than the provider control: docs.x.ai notes a per-model `api_key`/`env_key` in `config.toml` is a separate path an environment check does not see |
| the token helper's refusal of either route | `ops/grok/grok-token-helper`, this repository | No. Same class as above |

The distinction ADR-0068 drew is therefore real and still the right one: three
of these are our own assertions about our own process, and one is the provider
refusing the route. Making `apiKeyAuthDisabled` true is what turns the fourth
row from an aspiration into an installed control, and it also closes the
per-model-key gap the environment check cannot reach.

One consequence to weigh rather than assume: docs.x.ai says enforcement of the
login policy *"applies every time a session is issued or reused, including
cached tokens and silent refreshes"*, and that a non-complying session is
cleared. That sentence is written about `force_login_team_uuid`. Whether
turning on `disable_api_key_auth` alone can invalidate the existing enrolled
`voice-grok-auth` credential is not something these local tests could settle
(see below), and it touches the six-hour renewal path ADR-0069 exists to
protect. The safe order is to install the key and re-observe the credential
before relying on it.

## Confirmed against the Agent Host's own build, 2026-09-02

The matrix in §1.3 was produced on this workstation's macOS `[stable]` 1.0.13.
The two rows that matter were then re-run on the Agent Host's Linux `[alpha]`
1.0.13 (`grok 1.0.13 (5e9a58528b76) [alpha]`, `/usr/local/bin/grok`), in a
throwaway `GROK_HOME` under `mktemp -d`, removed afterwards. Nothing was
installed, no service identity was used, and no credential was touched:

| Throwaway home | `loginPolicy` |
| --- | --- |
| `requirements.toml`, `[grok_com_config] disable_api_key_auth = true` | `{"disableApiKeyAuth":true,"forceLoginTeamUuid":null,"apiKeyAuthDisabled":true}` |
| `requirements.toml`, `[auth] disable_api_key_auth = true` | `{"disableApiKeyAuth":true,"forceLoginTeamUuid":null,"apiKeyAuthDisabled":true}` |
| empty home | `{"disableApiKeyAuth":null,"forceLoginTeamUuid":null,"apiKeyAuthDisabled":false}` |

Both spellings move the field on the Linux build, and the empty home reproduces
the observation the 2026-08-31 addendum recorded. The `[alpha]` / `[stable]`
channel difference noted below does not reach this behaviour.

## What could not be established

- **Runtime refusal was not demonstrated.** With the policy pinned on and a
  fabricated `XAI_API_KEY` in the environment, a headless run returned the same
  `Not signed in` envelope as the identical run with no policy at all - the
  fake key was never accepted as a credential in either case, so the test does
  not discriminate. The refusal path exists in the binary as
  `disabled_by_admin` / *"API-key auth is disabled by your administrator."* and
  *"preferred_method=oidc; API-key auth is not allowed."*, and docs.x.ai
  describes the behaviour, but this note does not contain an executed
  demonstration of it. Proving it needs a real API key, which is precisely the
  thing this repository declines to provision.
- **Effect on an existing cached OIDC session.** Not tested, because it would
  require the Agent Host's enrolled credential, and this investigation was
  read-only and off-host. See the caution in §5.
- **Whether the server-delivered settings channel can ever raise this bit.**
  The binary has a remote settings mechanism (`remote_settings`,
  `x.ai/settings/update`, an `allow_access` gate named
  `grok_build_access_gate`), and docs.x.ai states `requirements.toml` overrides
  remote settings - which implies remote settings can carry *something*.
  Nothing found says login policy is among what it carries, and no observation
  here shows it moving `loginPolicy`. Treated as: no evidence either way, and
  irrelevant to #167 because the local pin wins regardless.
- **Any account-side surface.** No dashboard, console page, or API endpoint for
  this setting was found in first-party documentation. That is a negative
  finding from searching docs.x.ai and the shipped user guide, not a proof of
  absence.
- **The `[alpha]` / `[stable]` channel difference** between the host's Linux
  1.0.13 and this workstation's macOS 1.0.13 is noted but not explained. The
  configuration-parsing findings were since re-confirmed against the Linux build
  (see the section above); what the channel label itself means was not
  established.

## Sources

- xAI, *Grok Build - Enterprise Deployments*, <https://docs.x.ai/build/enterprise>, fetched 2026-09-02. Section *Restricting login methods*.
- xAI, *Grok Build - Settings*, <https://docs.x.ai/build/settings>, fetched 2026-09-02. Checked and found not to carry these keys.
- `~/.grok/docs/user-guide/26-config-reference.md`, extracted on launch by `grok` 1.0.13; `[auth]` table lines 58-59, `[grok_com_config]` table lines 256-257. The same strings are present in the executable.
- `/Users/jacob/.grok/downloads/grok-1.0.13-macos-aarch64` (SHA-256 `8669e0fd…`), run as `GROK_HOME=<throwaway> grok --no-auto-update inspect --json` across the layer matrix in §1.3, and `strings -a` over the executable for `disable_api_key_auth`, `force_login_team_uuid`, `api_key_auth_disabled`, `login_policy`, and the `xai-grok-shell` auth module paths.
- This repository: [`grok-build-install-and-auth.md`](grok-build-install-and-auth.md) (2026-08-31 addendum), `docs/adr/0068-pin-and-prove-the-grok-runner-before-it-works.md`, `apps/worker/src/grok-runner-pin.ts`, `ops/grok/requirements.toml`, `ops/grok/grok-token-helper`, `ops/acceptance/run-grok-enrollment.sh`.
