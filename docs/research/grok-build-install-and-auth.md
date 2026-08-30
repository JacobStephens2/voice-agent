# Grok Build CLI: install, pinning, self-update, auth, and `inspect --json`

_Researched 2026-08-30 against primary sources only: xAI's Grok Build
documentation on docs.x.ai, the official installer served from `x.ai/cli`,
the `github.com/xai-org/grok-build` Rust source and its shipped user guide,
and the released Linux binary itself (`grok 1.0.13`, downloaded from the
official artifact URL and executed in a throwaway `GROK_HOME`)._

_Upstream revision inspected: `bc7f02eddd3d84085849dc19ed216f11c23b0571`
("Synced from monorepo", 2026-08-28), whose `SOURCE_REV` is
`d5a0335a47221e8c9519936cb693e9b6450227ec`. The earlier note
[`grok-subagent-mvp.md`](grok-subagent-mvp.md) pinned
`07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8` and named 0.2.111 as the candidate
build; stable is now **1.0.13**, and several contracts that note described have
moved or never existed._

## Headline

Five of the assumptions baked into this repository's Grok runner are wrong
against the shipped 1.0.13 binary. The worst is that `grok auth
print-access-token --quiet` **does not exist** - there is no `auth` subcommand
at all - so `ops/grok/grok-token-helper` cannot work. Three config keys in
`ops/grok/config.toml` (`[update] auto_update`, `[auth] auth_provider`,
`[sandbox.profiles.*]`, `[shell] environment_policy`) name tables the CLI does
not read, and every field name our drift check reads out of `grok inspect
--json` is wrong: the report is camelCase and carries none of `version`,
`auto_update`, `authentication`, `model`, or `approval`.

---

## 1. The official install route

There is one supported route on Linux: a `curl | bash` script served from
`x.ai/cli`. xAI publishes no apt/yum repo, no Homebrew formula for Linux, and
no tarball; the artifact is a bare (optionally compressed) executable.

```sh
curl -fsSL https://x.ai/cli/install.sh | bash   # macOS / Linux / Git Bash
irm https://x.ai/cli/install.ps1 | iex          # Windows PowerShell
grok --version
```

([README, "Installing the released binary"](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/README.md),
[Grok Build overview](https://docs.x.ai/build/overview))

The real download URLs, read from the installer itself
(`https://x.ai/cli/install.sh`, fetched 2026-08-30) and corroborated by
[`crates/codegen/xai-grok-update/src/version.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-update/src/version.rs#L14-L27):

| Purpose | URL |
| --- | --- |
| Primary base (Cloudflare-fronted) | `https://x.ai/cli` |
| Fallback base (direct GCS) | `https://storage.googleapis.com/grok-build-public-artifacts/cli` |
| Channel pointer (plain-text version) | `https://x.ai/cli/<channel>` where channel is `stable`, `alpha`, or `enterprise` |
| Binary | `https://x.ai/cli/grok-<version>-<os>-<arch>` |
| Compressed variants tried first | `…<artifact>.zst`, then `…<artifact>.gz` |

`os` is `linux`/`macos`/`windows`, `arch` is `x86_64`/`aarch64`. Verified live:

```
$ curl -fsSL https://x.ai/cli/stable
1.0.13
$ curl --head https://x.ai/cli/grok-1.0.13-linux-x86_64      -> 200, 166079904 bytes
$ curl --head https://x.ai/cli/grok-1.0.13-linux-x86_64.zst  -> 200,  48218237 bytes
```

The installer's own layout, again from the script:

- downloads to `$HOME/.grok/downloads/grok-<os>-<arch>`;
- symlinks `$HOME/.grok/bin/grok` **and** `$HOME/.grok/bin/agent` at it
  (`GROK_BIN_DIR` overrides the bin dir);
- additionally symlinks into `~/.local/bin` or `/usr/local/bin` when one of
  those is already on `PATH` and writable;
- appends a `# >>> grok installer >>>` block to `~/.bashrc` / `~/.zshrc` /
  `~/.config/fish/config.fish`, after backing the file up;
- writes shell completions under `~/.grok/completions/`;
- **writes `[cli] installer = "internal"` (and `channel` when non-stable) into
  `$HOME/.grok/config.toml`**, editing the file in place if it already exists.

That last point matters for us: the documented install path mutates the user
config file we intend to treat as fixed. An enterprise install (deployment
key) additionally pulls `managed_config.toml` and `requirements.toml` from
`https://cli-chat-proxy.grok.com/v1/deployment/config` into `~/.grok/`.

An unattended install into a fixed path should therefore bypass the script and
`curl` the versioned artifact URL directly, or set `GROK_BIN_DIR` and accept
the `~/.grok/config.toml` and rc-file writes.

## 2. Version pinning

Two documented mechanisms, both real:

1. **At install.** The installer takes a positional version argument:

   ```sh
   curl -fsSL https://x.ai/cli/install.sh | bash -s 1.0.13
   ```

   The script validates it against `^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._]+)?$`
   and, when present, skips the channel-pointer fetch entirely (installer
   header comment and `TARGET` handling, `https://x.ai/cli/install.sh`).

2. **After install.** `grok update --version <VERSION>` - "Install a specific
   version (e.g. 0.1.150 or 0.1.151-alpha.2)". Confirmed from the shipped
   binary:

   ```
   $ grok update --help
   Options:
         --check                 Check for updates without installing
         --json                  Emit machine-readable JSON output (for --check)
         --force-reinstall       Force re-download and install even if already up to date
         --version <VERSION>     Install a specific version (e.g. 0.1.150 or 0.1.151-alpha.2)
         --alpha / --stable      Switch release channel
   ```

   ([`cli.rs` `Command::Update`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/cli.rs#L88-L117))

Version floors and ceilings can also be pinned by an admin through
`cli.minimum_version`, `cli.maximum_version`,
`cli.required_minimum_version`, and `cli.required_maximum_version`, all marked
`pin` (that is, settable in `requirements.toml` and not overridable)
([config reference](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md#L99-L111)).

## 3. Checksums, digests, signatures

**xAI publishes none for the CLI artifacts.** This is stated outright in the
updater source:

> "Loopback-only: downloads are verified by a smoke test, not a checksum, so an
> arbitrary redirect base would be an install-hijack vector."
> — [`version.rs:31`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-update/src/version.rs#L28-L34)

Corroborating evidence:

- The installer's only integrity check is a smoke test: it `chmod +x`es the
  download and runs `"$binary_tmp" --version </dev/null`, keeping the existing
  install if that fails (`https://x.ai/cli/install.sh`).
- Probing the artifact directory for the sidecars a signed release would carry
  returns 404 for every one:
  `grok-1.0.13-linux-x86_64.sha256`, `.sha256sum`, `.sig`, `.minisig`,
  `.intoto.jsonl` — all HTTP 404, while the binary and `.zst`/`.gz` are 200.
- `https://api.github.com/repos/xai-org/grok-build/releases` returns `[]` —
  there are no GitHub releases and therefore no release assets or attestations
  there.
- [`SECURITY.md`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/SECURITY.md)
  is a HackerOne pointer only; it says nothing about artifact signing.

The one integrity signal available is GCS object metadata returned with the
download: `x-goog-hash: md5=…` and `crc32c=…`, plus the `ETag`. That is a
transport-level content hash from the CDN, **not** a checksum xAI publishes out
of band, so it cannot detect a compromised bucket. For our own pin we must
compute and record the digest ourselves. Values observed 2026-08-30:

```
sha256(grok-1.0.13-linux-x86_64.zst) = 27d8a63b30bad9ca3a3145e031f43f0be3a8b29fb0ef5fe785e4a61a44b6b496
sha256(grok-1.0.13-linux-x86_64)     = edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1
$ grok --version
grok 1.0.13 (5e9a58528b76)
```

Signing does exist inside the product, but for a different object:
`requirements.toml` is "Ed25519-signed at rest once a key is embedded"
([`xai-grok-config/src/lib.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-config/src/lib.rs#L1-L14)).
Do not mistake that for binary signing.

## 4. Self-update: on by default, three ways off

**The CLI checks for and installs updates by default.** The central gate is:

```rust
fn should_check_for_updates(no_auto_update_flag: bool) -> bool {
    if cfg!(debug_assertions) { return false; }
    if no_auto_update_flag { return false; }
    !std::env::var_os("GROK_DISABLE_AUTOUPDATER")
        .is_some_and(|v| env_flag_enabled(&v.to_string_lossy()))
}
```

([`xai-grok-pager-bin/src/main.rs:2484`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager-bin/src/main.rs#L2482-L2494))

Release builds therefore update unless suppressed. Three suppressions, all
primary-sourced:

| Mechanism | Scope | Source |
| --- | --- | --- |
| `--no-auto-update` | this process | [`cli.rs:721`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/cli.rs#L719-L723), declared `hide = true` |
| `GROK_DISABLE_AUTOUPDATER=1` | environment | `should_check_for_updates` above |
| `[cli] auto_update = false` | config file | [config reference `cli.auto_update`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md#L99); read at [`main.rs:1554`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager-bin/src/main.rs#L1553-L1556) |

The headless guide is explicit that scripts must pass the flag: "When using
headless mode (`-p`) or ACP (`grok agent stdio`) in scripts, CI, or other
automated environments, pass `--no-auto-update`", and names `[cli] auto_update
= false` in `~/.grok/config.toml` as the persistent equivalent
([`14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md),
[docs.x.ai headless scripting](https://docs.x.ai/build/cli/headless-scripting)).

`cli.auto_update` is marked `pin`, so a root-owned
`/etc/grok/requirements.toml` can hold it off in a way a project or user
config cannot override. That is the strongest form of the pin available to us,
and it is stronger than the flag alone.

**Placement gotcha, verified on the binary:** `--no-auto-update` is a global
flag on the root command and on `agent`, not on every subcommand.
`grok inspect --json --no-auto-update` exits 2 with
`error: unexpected argument '--no-auto-update' found`. Put it before the
subcommand, or rely on the env var / config key for subcommands.

## 5. Non-interactive access token: `grok auth print-access-token` is NOT real

**Contradicted.** There is no `auth` subcommand in Grok Build. The full
subcommand list from the shipped binary is: `agent, clone, completions,
dashboard, doctor, du, export, help, inspect, leader, login, logout, mcp,
memory, models, plugin, sessions, setup, trace, update, version, worktree,
wrap`. Running our helper's exact command:

```
$ grok auth print-access-token --quiet
error: unexpected argument 'print-access-token' found
Usage: grok [OPTIONS] [PROMPT] [COMMAND]
$ echo $?
2
```

(`auth` was swallowed as the positional `[PROMPT]`.) This matches the
`Command` enum in
[`cli.rs:6-150`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/cli.rs#L6-L150),
which has no `Auth` variant, and the
[docs.x.ai CLI reference](https://docs.x.ai/build/cli/reference), which lists no
token command. There is also no global `--quiet`.

The only occurrence of the phrase in the whole tree is an *analogy* in
`xai-grok-shell/README.md`, describing what an external auth provider is:
"The command is a credential helper … exactly like `gcloud auth
print-access-token` or a git credential helper." That is almost certainly the
sentence our implementation pattern-matched on.

**There is no first-party command that prints a short-lived access token from
an existing device-OAuth login.** The direction of the supported interface is
the opposite of what we assumed: Grok does not *emit* tokens for scripts, it
*consumes* them from a helper we provide (item 6).

Two real options for a script that must reach the credential from an attended
`grok login --device-auth`:

1. **Read `~/.grok/auth.json` directly.** xAI's own installer does exactly
   this, and documents the shape inline:

   ```sh
   # Read a token from ~/.grok/auth.json for the given scope key.
   # Format: {"scope_url": {"key": "token"}, ...}
   OIDC_SCOPE="https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"
   LEGACY_SCOPE="https://accounts.x.ai/sign-in"
   ```

   (`https://x.ai/cli/install.sh`). The file is `0600`, and the docs warn
   plainly that "Anyone with filesystem access to those paths can use the
   credentials"
   ([`02-authentication.md`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)).
   This is an undocumented-for-third-parties file format that the CLI owns and
   rewrites on refresh; treating it as an interface is a drift risk, but it is
   the only route that starts from an existing device-OAuth login. Note also
   that Grok hot-reloads this file: "Grok picks up changes to `~/.grok/auth.json`
   automatically … Grok uses the new credentials on the next API call without a
   restart" (same doc).

2. **Do not extract a token at all - invert the flow** and give the runner
   `auth.auth_provider_command`, letting our custody service mint on demand
   (item 6). This is the shape xAI actually supports, and it is what our
   architecture wanted anyway; only the plumbing was guessed wrong.

## 6. The external `auth_provider` contract

There are **two distinct mechanisms** with confusingly similar names. Our
`ops/grok/config.toml` names neither correctly.

### 6a. Session-level external auth provider — `auth.auth_provider_command`

This is the one we want. Config key and its relatives:

```toml
# ~/.grok/config.toml
[auth]
auth_provider_command = "/usr/local/bin/my-auth-provider"
auth_provider_label   = "Acme Corp"   # optional, TUI login button label
auth_token_ttl        = 3600          # optional, seconds
```

Environment equivalents: `GROK_AUTH_PROVIDER_COMMAND`,
`GROK_AUTH_PROVIDER_LABEL`, `GROK_AUTH_TOKEN_TTL`. The key is also valid as
`grok_com_config.auth_provider_command`
([`02-authentication.md`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md),
[config reference lines 55-56](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md#L55-L56)).

Invocation and stream contract, quoted from the authentication guide:

1. "Grok runs your command via `sh -c \"<command>\"`"
2. Your binary runs whatever auth flow it needs
3. "**stderr** carries human-readable output, such as login URLs and status
   messages" - surfaced to the user; the first `https://` URL becomes a
   clickable link in the TUI
4. "**stdout** is captured by Grok and saved as the access token"
5. "**Exit 0 = success; exit non-zero = Grok falls back to interactive login**"

"**Do not print anything to stdout except the token.** No progress messages,
no debug output."

Accepted stdout formats (parser:
[`token_output.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-shell/src/auth/token_output.rs)):

- a **bare token** on one line, or
- a **JSON object**: `{"access_token": "...", "refresh_token": "...",
  "expires_in": 3600, "issuer": "https://idp.example.com"}`. Only
  `access_token` is required. `expires_in` enables proactive re-minting;
  `refresh_token` is stored for reference only - "Grok refreshes by re-running
  your binary, not with an OAuth refresh grant."

Failure semantics are fail-closed and precise. From the parser's own doc
comment: "A non-zero exit, non-UTF-8 or empty stdout, an empty `access_token`,
or JSON-object output that is not a valid token payload are all errors."
Output starting with `{` **must** parse as a token payload, specifically so
that `{"error":"expired"}` can never be mistaken for a bearer. Tokens
containing control characters are rejected outright.

Two invocation modes, distinguished by an environment variable Grok sets:

| `GROK_AUTH_EXPIRED` | Meaning | Budget | stderr |
| --- | --- | --- | --- |
| `=1` | headless re-mint over a credential Grok already holds | ~7s (`EXTERNAL_AUTH_REFRESH_TIMEOUT`) then killed, stdin closed | swallowed |
| unset | a sign-in (`grok login`, sign-in screen, escalation after a failed headless mint) | 300s | shown to the user |

([`02-authentication.md` "Token Refresh"](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md),
[`external_auth.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-shell/src/auth/external_auth.rs))

The command runs through a group-killing runner, "so a provider that spawns
helpers is torn down as a unit on timeout" (`external_auth.rs`). Each run
"fully replaces the stored credential, so emit the same JSON fields (such as
`issuer`) on every invocation, including refreshes."

**Custody correction.** The earlier note claimed the token "remains in process
memory and is never written to `auth.json`". For *this* mechanism that is
false: the docs' own stream table says stdout is "parsed and **stored in
auth.json**", and `parse_output` builds a full `GrokAuth` session credential
with `auth_mode: AuthMode::External`. The memory-only property belongs to the
other mechanism below.

### 6b. Per-model credential helper — `[auth_provider.<name>]`

A separate, named-table mechanism a *model* opts into:

```toml
[auth_provider.acme]
command       = "/usr/local/bin/mint"
args          = ["--silent"]   # when set (even empty), execs directly instead of via the shell
token_ttl_secs = 900           # fallback lifetime when output carries no expires_in
timeout_secs   = 30            # default 30, clamped to 1..=600
cwd            = "~/acme"

[model.my-model]
auth_provider = "acme"
```

([`auth_provider.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-shell/src/auth/auth_provider.rs),
[config reference `auth_provider.<name>` and `model.<id>.auth_provider`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md#L77-L81))

This path shares the same stdout parser, and here the memory-only claim holds:
"The minted token stays in memory only … never `auth.json`". It is honored
"only from the trusted config layers", and a ref revived from bytes without its
trusted table becomes `fail_closed` and refuses to mint. `auth_provider` is
also on the list of tables an untrusted config layer may not introduce
([`config_override.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-config/src/config_override.rs#L79-L100)).

Note this mechanism attaches to a **custom model**, not to the built-in
`grok-build` selector. Using it would mean defining a `[model.*]` entry, which
is a larger change than pointing `auth.auth_provider_command` at our broker.

## 7. What `grok inspect --json` actually emits

Every field name our drift check reads is wrong. The report struct is
`#[serde(rename_all = "camelCase")]`
([`inspect/mod.rs:53-83`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-shell/src/inspect/mod.rs#L53-L83)),
so even the fields that exist are camelCase, not snake_case. Observed
top-level keys from `grok inspect --json` on 1.0.13:

```json
["grokVersion","channel","cwd","projectRoot","projectTrusted",
 "projectInstructions","permissions","loginPolicy","hooks","skills","agents",
 "plugins","marketplaces","mcpServers","lspServers","configSources",
 "externalCompat"]
```

Two more appear only when non-empty (`skip_serializing_if = "Vec::is_empty"`):
`configWarnings` and `mcpConfigProblems`.

Field-by-field verdict on our drift check:

| Our key | Verdict | Reality |
| --- | --- | --- |
| `version` | **wrong name** | `grokVersion` (string, e.g. `"1.0.13"`) |
| `auto_update.enabled` | **absent** | no update state in the report at all. Use `grok update --check --json`, or read the config layer paths from `configSources` |
| `authentication.source` | **absent** | no authentication object. Nearest is `loginPolicy` = `{disableApiKeyAuth, forceLoginTeamUuid, apiKeyAuthDisabled}` - policy, not the active auth route |
| `authentication.api_key_present` | **absent** | not reported. `loginPolicy.apiKeyAuthDisabled` is a policy bit, not a presence bit |
| `model.default` | **absent** | `inspect` reports no model at all. `grok models` is the model-listing command; `[models] default` is a config key |
| `approval.always_approve` | **absent** | nearest is the `permissions` object: `{sources, loaded, skipped, mcpServerAllowlist, marketplaceAllowlist, managedSettingsPath, managedSettingsExists, managedSettingsActive}` |
| `sandbox.profile` | **absent** | `inspect` reports no sandbox state. `[sandbox] profile` is a config key |
| `config_sources` | **wrong name, right idea** | `configSources` = `{"layers": [{"role": …, "path": …, "note"?: …}]}` |
| `mcp_servers` | **wrong name** | `mcpServers` |
| `plugins` | **correct** | `plugins` (array of `{name, scope, path, enabled, …}`) |
| `skills` | **correct** | `skills` (array of `{name, description, source, userInvocable, …}`) |

`configSources.layers[].role` is one of `"system-managed"`, `"managed"`,
`"user"`, `"system-requirements"`, `"requirements"`, `"mdm"`, `"project"`, and
`note` is `"empty"` or `"parse error"` when a present file contributes nothing
([`inspect/mod.rs:267-290`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-shell/src/inspect/mod.rs#L267-L290)).
Verified empirically with a user and a project config in place:

```json
{"layers":[{"role":"user","path":"…/.grok/config.toml"},
           {"role":"project","path":"…/proj/.grok/config.toml"}]}
```

Note that layers with no on-disk file are simply omitted, so an empty `layers`
array is the normal result on a clean machine - our drift check cannot treat
"no unexpected source" as "the expected source was proven present". It has to
assert the *presence* of the `system-managed` / `system-requirements` layer at
`/etc/grok/...` positively.

`projectTrusted` is worth reading too: when false, "repo-local project hooks,
plugins, and MCP/LSP entries are gated out of the listings below" - so an
untrusted project makes the very listings we audit come back empty for reasons
unrelated to policy.

## 8. Where system/enterprise configuration is read from

On Unix the system config directory is hard-coded to **`/etc/grok`**:

```rust
pub fn system_config_dir() -> Option<PathBuf> {
    if cfg!(unix) { Some(PathBuf::from("/etc/grok")) } else { None }
}
```

([`paths.rs:25`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-config/src/paths.rs#L25-L31))

Full merge order, lowest to highest priority
([`xai-grok-config/src/lib.rs:1-14`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-config/src/lib.rs#L1-L14),
[config reference "Where settings come from"](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md#L10-L26)):

1. `/etc/grok/managed_config.toml` (root-owned system layer)
2. `$GROK_HOME/managed_config.toml` (server-synced, user-writable)
3. `$GROK_HOME/config.toml`
4. `$GROK_HOME/requirements.toml` (signed cache)
5. `/etc/grok/requirements.toml` (root-owned, admin-enforced)
6. macOS MDM managed preferences (`ai.x.grok`) — macOS only

Project layers (`.grok/config.toml`) also participate, and `requirements.toml`
is the layer whose `pin` keys "cannot be overridden … against every other
file, the environment, and the command line." For our purposes: the file that
must hold the boundary is **`/etc/grok/requirements.toml`**, not a
`managed_config.toml` (which a developer's own file overrides) and certainly
not `/etc/voice-agent/grok/config.toml`, which the CLI never reads.

The permissions doc names the same file for the specific thing we care about:
locking always-approve off is done "in `requirements.toml` (user-level under
`~/.grok/`, or system-wide under `/etc/grok/` for enforcement users cannot
remove)"
([`22-permissions-and-safety.md`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)).

---

## Verdicts on our current assumptions

### CONFIRMED

- **`--no-auto-update` exists** and is the documented flag for headless/CI use.
  It is a hidden flag but accepted by 1.0.13
  ([`cli.rs:721`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/cli.rs#L719-L723)).
  Caveat: it must precede a subcommand.
- **The CLI self-updates by default**, so the pin does need active defence
  (`should_check_for_updates`).
- **Every runner flag in `buildGrokInvocation` exists** in 1.0.13: `--cwd`,
  `--model`, `--prompt-file`, `--output-format json`, `--json-schema`,
  `--always-approve`, `--max-turns`, `--no-plan`, `--no-memory` (hidden but
  accepted), `--sandbox`, `--no-auto-update`. All probed directly against the
  binary with a known-bad control flag.
- **Version pinning is supported** both at install (`bash -s <version>`) and
  after (`grok update --version <v>`).
- **`GROK_HOME` is honoured** as the CLI's state root, and `auth.json` lives
  under it at `0600`.
- **`[models] default` and `[sandbox] profile` are real config keys** with the
  spellings we used, both marked `pin`.
- **`/etc/grok` is the system configuration root** and is read before user
  config, which is what ADR-0068's "root-managed configuration" needs.
- **`restrict_network` and `deny` are real custom-profile fields**, and
  child-network blocking is Linux-only (seccomp); built-in web tools are
  unaffected
  ([`18-sandbox.md`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md)).

### CONTRADICTED

1. **`grok auth print-access-token --quiet` does not exist.** No `auth`
   subcommand, no `--quiet`. `ops/grok/grok-token-helper` exits 2 on every
   invocation. There is no first-party command that prints an access token.
   The comment in that file - "The token subcommand below is confirmed against
   the pinned runner during enrollment" - describes a check that was never run.
2. **`[update] auto_update = false` is not a config key.** The real key is
   **`[cli] auto_update`**. Our `ops/grok/config.toml` `[update]` table is
   inert.
3. **`[auth] auth_provider = "<path>"` is not a config key.** The
   session-level key is **`[auth] auth_provider_command`** (or
   `GROK_AUTH_PROVIDER_COMMAND`). Bare `auth_provider` exists only as
   `[auth_provider.<name>]` tables plus `[model.<id>] auth_provider = "<name>"`.
4. **`[shell] environment_policy = "minimal"` is not a config key.** The real
   table is top-level **`[shell_environment_policy]`** with
   `inherit = "all" | "core" | "none"` plus `exclude`, `include_only`, `set`,
   `ignore_default_excludes`. There is no `"minimal"` value. Worse, the
   documented default is `inherit = "all"` **with**
   `ignore_default_excludes = true`, which "leaves the environment untouched" -
   so absent explicit configuration, tool subprocesses inherit everything,
   including `*KEY*` / `*SECRET*` / `*TOKEN*` names.
5. **`[sandbox.profiles.voice-agent-task]` in `config.toml` is the wrong
   location.** Custom profiles live in a separate file: `~/.grok/sandbox.toml`
   (global) or `.grok/sandbox.toml` (per-project), under `[profiles.<name>]`.
   Our profile is currently defined where nothing reads it, which means
   `--sandbox voice-agent-task` names a profile that does not exist.
6. **Every field name in our `grok inspect --json` drift check is wrong** (see
   the table in item 7). The report is camelCase, and `auto_update`,
   `authentication`, `model`, and `approval` have no counterpart at any
   spelling. A drift check written against these keys does not fail closed -
   it reads `undefined` for each and would need explicit presence assertions to
   detect that.
7. **The external auth provider's token *is* written to `auth.json`.** The
   prior note's memory-only claim applies to the per-model
   `[auth_provider.<name>]` path, not to `auth.auth_provider_command`. Our
   custody design leans on the wrong one.
8. **`/etc/voice-agent/grok/config.toml` is not a path Grok reads.** Root-owned
   policy must go in `/etc/grok/requirements.toml` (enforceable) or
   `/etc/grok/managed_config.toml` (overridable by the user's own file).
9. **Version and revision drift.** The prior note's candidate 0.2.111 and pin
   `07b2f714…` are far behind: stable is 1.0.13 and the public mirror's head is
   `bc7f02ed…`. A major-version bump has happened since that research.

### UNVERIFIABLE FROM PRIMARY SOURCES

- **Whether `~/.grok/auth.json`'s scope-keyed shape is a stable interface.**
  xAI's own installer parses it, and the OIDC scope constant
  `https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828` is published in
  that script, but no document declares the file a supported interface for
  third parties. Reading it is undocumented-but-demonstrated, not contracted.
- **Whether any checksum or signature exists for release artifacts through a
  private/enterprise channel.** The public evidence is uniformly negative
  (404s, no GitHub releases, "verified by a smoke test, not a checksum"), and
  the `enterprise` channel pointer exists, but I could not exercise the
  enterprise install path without a `GROK_DEPLOYMENT_KEY`.
- **Whether a run's authentication route (OAuth vs `XAI_API_KEY`) is
  observable in any machine-readable output.** `inspect --json` does not report
  it. The headless docs show an example distinguishing `xai.api_key` from
  `cached_token` in an `authMethods` set, but I did not establish which
  documented output object carries that field, or whether it appears in
  `--output-format json` results. Our acceptance requirement "prove the
  reported auth source is OAuth" is not yet backed by a located field.
- **Whether `grok update --check --json` reports the pinned/current version in
  a stable shape.** The flag exists; I did not run it (it contacts xAI) and no
  document specifies its schema.
- **Whether `--no-auto-update` suppresses the *staged-update adoption on
  respawn* path as well as the check.** `should_check_for_updates` gates the
  checks, and `is_managed_install` shows a staged update is adopted when the
  running binary is the one `<grok_home>/bin/grok` resolves to; I did not trace
  every adoption call site. A binary installed outside `$GROK_HOME/bin` is
  reported "unmanaged" and skips the update, which is an additional, incidental
  protection for a fixed-path install.

## Limitations

- Everything above describes **Grok Build 1.0.13 on linux-x86_64**, downloaded
  2026-08-30, and public mirror revision `bc7f02ed…`. xAI ships weekly on the
  stable channel; treat all of it as re-verifiable, not permanent.
- I ran `--version`, `--help`, `update --help`, `inspect --json`, and flag
  probes only. **No authenticated run, no model request, no login** was
  performed, so items about live auth behaviour (5, and the auth-route
  question above) rest on source and docs, not on observation.
- `github.com/xai-org/grok-build` is a periodic sync of an internal monorepo,
  not the build that ships. The 1.0.13 binary's build id (`5e9a58528b76`) does
  not correspond to any commit in the public tree, so source-derived claims are
  strongly indicative but only the binary-derived ones (flags, `inspect` keys,
  subcommands, exit codes) are direct evidence about the shipped artifact.
- The `x.ai/cli` channel pointers returned `1.0.13` for both `stable` and
  `alpha` at the time of this research; that is unusual and may be transient.
- I did not test `/etc/grok` layers empirically, since writing there requires
  root. The path and precedence come from source and the config reference.
