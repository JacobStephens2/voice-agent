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


## Addendum: observed on the Agent Host, 2026-08-30

The findings above were established off-host. These were observed directly on
the Agent Host against `/usr/local/bin/grok` 1.0.13
(`edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1`).

**Two fetch routes agree.** The versioned artifact from
`https://x.ai/cli/grok-1.0.13-linux-x86_64` and the binary produced by
`grok update --version 1.0.13` are byte-identical. Given no checksum is
published, two independent routes agreeing is the strongest corroboration
available. Both report `[alpha]` at 1.0.13, so that label is a property of the
build rather than of the channel it was served from.

**`configSources` is an object, not an array.** Its `layers` carry a `role` of
`managed`, `user`, or `requirements`, a `path`, and an optional
`note: "empty"`. `requirements` is the layer a project cannot override. With
`GROK_HOME` set, all three resolve inside that home rather than under `/etc`.
There is a fourth role, `system-requirements`, which only appears once
`/etc/grok/requirements.toml` exists; see the 2026-08-31 addendum.

**`loginPolicy.apiKeyAuthDisabled` exists and is observable.** This is a real
enforcement point for "no API key route", better than the absence of a variable
in one process's environment. `permissions.managedSettingsPath` reports
`/etc/claude-code/managed-settings.json` on this build.

**The sandbox cannot deny what the identity cannot open.** Confirmed by
elimination as `voice-grok`:

| Profile | Result |
| --- | --- |
| `extends = "workspace"` | starts |
| `+ restrict_network = true` | refuses: read-deny `/run/containerd/containerd.sock` could not be opened |
| `+ deny = ["/var/lib/voice-grok-auth"]` | refuses: read-deny `/var/lib/voice-grok-auth` could not be opened |

After entering Bubblewrap the runner re-opens each read-deny path to confirm
the mask is in effect; `Permission denied` is read as an unenforced deny list
and it refuses to start ("possible `__GROK_INSIDE_BWRAP` spoof"). Both failing
paths are unreadable to the executor identity by ordinary permissions -
`containerd.sock` is `srw-rw---- root:root`, `voice-grok-auth` is `drwxr-x---`.
`restrict_network` implicitly denies the container sockets, which is why it
fails for the same reason. A custom profile may extend only a built-in base,
and `workspace` is the only base that accepts extension here.

**Consequence:** child-process network restriction is unavailable on this host,
and the Credential Custody Boundary must be held by identity permissions and
the systemd unit rather than by sandbox deny rules. Tracked in issue #161.

**The headless envelope, observed.** After an attended device-code login, one
real bounded run returned:

```json
{ "text": "…", "stopReason": "end_turn", "sessionId": "…", "requestId": "…",
  "thought": "…", "num_turns": 1, "total_cost_usd": 0.00503064,
  "usage": { "input_tokens": 13968, "output_tokens": 276,
             "reasoning_tokens": 251, "total_tokens": 14244 },
  "modelUsage": { "grok-4.6-build": { "modelCalls": 1, "costUSD": 0.00503064 } },
  "structuredOutput": { "risks": [], "status": "completed", "summary": "…" } }
```

Every field the implementation inferred was wrong. The identity fields are
camelCase (`stopReason`, `sessionId`, `requestId`), the structured result is
`structuredOutput` rather than `result`, and `usage` is snake_case inside a
camelCase envelope. Three findings matter beyond spelling:

- **There is no `auth_source`.** The authentication route is not reported per
  run at any spelling. It is observable in the credential instead - the
  enrolled entry carries `auth_mode: "oidc"` - and in runner policy through
  `loginPolicy.apiKeyAuthDisabled`.
- **Cost is reported**, `total_cost_usd`, on a subscription-authenticated run.
  The earlier note's expectation that OAuth runs omit cost does not hold here.
- **`modelUsage` names the model actually served.** A run asking for `grok-4.6`
  is answered by `grok-4.6-build`, so the selector and the served model are
  genuinely different values and both are worth recording.
- **`thought` carries the model's reasoning** and must never reach durable
  evidence.

A refusal is returned as a distinct envelope, `{"type":"error","message":…}`,
on standard output with a non-zero exit.

**`grok-build` is not a model id.** The subscription rejects it: *"Invalid
params: unknown model id"*. `grok models` reports `grok-4.6` (default) and
`grok-4.5`. The documented recommendation does not match what the account can
select.

**The credential expires in six hours.** The enrolled entry carries
`expires_at` roughly six hours after `create_time`, beside a `refresh_token`.
Grok refreshes it when Grok owns the login, which it does not when a token
helper reads the file, so the helper refuses an expired token rather than
handing one out mid-Delegation. Automatic refresh under the custody identity is
not implemented.

**Retention is observable.** The entry carries
`coding_data_retention_opt_out`, so the enrollment record can read that setting
rather than ask an operator to recall it.

## Addendum: credential renewal, observed 2026-08-30

The six-hour lifetime noted above raised one question the earlier addendum left
open - what renews the credential - and answering it turned up a second
mechanism that changes where the auth crossing may be configured. Both were
observed against the installed `grok 1.0.13`, using a real subscription login
for the first finding and synthetic scope entries for the rest.

**An authenticated command renews an expired OIDC login, first-party.** With
an entry three days past `expires_at`, `grok --no-auto-update models` exited 0
and rewrote `auth.json` with a new `create_time` and an `expires_at` six hours
out. The command needs no model tokens - it asks the account what it may
select. Re-running it against the now-valid entry left `create_time` unchanged,
so the renewal happens on expiry rather than proactively, and `models` reports
`You are not authenticated.` on the run that renews, because it prints what it
read before the refresh landed. Baseline cost of the command with nothing to
renew: 0.3 s.

| Before | Command | After |
| --- | --- | --- |
| `expires_at 2026-08-27T03:45:10Z` (expired) | `grok --no-auto-update models` | rewritten to `2026-08-30T23:08:58Z` / `2026-08-31T05:08:58Z`, exit 0 |
| valid | same command | unchanged, `You are logged in with grok.com.` |

**A failed refresh deletes the credential.** With an expired entry carrying a
refresh token the issuer will not honour and no auth provider configured, the
same command removed `auth.json` outright. The failure mode is a missing login,
not a stale one, and only an attended `grok login --device-auth` restores it.

**An external auth provider takes precedence over renewal.** With
`auth_provider_command` set and the same expired entry, the provider command
was invoked and the cached entry was left untouched - no refresh was attempted.
With a *valid* cached entry the provider was not invoked at all. So a provider
command is what the runner reaches for when the credential it holds has
expired, which is exactly the moment the refresh grant would otherwise be
spent.

| Cached OIDC entry | `auth_provider_command` | Provider invoked | `auth.json` after |
| --- | --- | --- | --- |
| valid | set | no | unchanged |
| expired | unset | - | **deleted** (refresh refused) |
| expired | set | **yes** | present, unchanged |

**Layer precedence, measured with two distinguishable provider commands.** A
`requirements` layer beats `GROK_AUTH_PROVIDER_COMMAND` in the environment, and
a `$GROK_HOME/requirements.toml` beats a project `.grok/config.toml`. Layers
merge per key: a higher layer that omits `[auth]` leaves a lower layer's
`auth_provider_command` in force. A `$GROK_HOME/requirements.toml` planted by
hand survived repeated runs and was reported by `inspect` with `role:
"requirements"` and its home-local path.

| Lower layer | Higher layer | In force |
| --- | --- | --- |
| `GROK_AUTH_PROVIDER_COMMAND=B` | `$GROK_HOME/requirements.toml` → A | A |
| project `.grok/config.toml` → B | `$GROK_HOME/requirements.toml` → A | A |
| `$GROK_HOME/config.toml` → B | `$GROK_HOME/requirements.toml`, no `[auth]` | B |

Taken together these decide where the Voice Agent's broker may be named. A
host-wide `/etc/grok/requirements.toml` `[auth]` table would bind
`voice-grok-auth` as well, and its `grok` is the only process that can renew
the credential - so the host-wide crossing would send the custody identity to
the broker that reads the credential rather than to the issuer that renews it.
Naming the crossing in the run's own `$GROK_HOME/requirements.toml` keeps it on
the identity that runs models, and still outranks anything a Delegation root
ships. See ADR-0069.

One caveat: `/etc/grok` layers remain untested here, since writing there needs
root, so the claim that a home-local `requirements` layer coexists with a
system one rests on the per-key merge observed between the layers that could be
exercised. The enrollment wizard asserts the system layer carries no `[auth]`
and that both broker crossings answer, which is where that coexistence is
established on a real host. Issue #164 carries it, and the unobserved
proactive re-mint, as work of their own.

**Both were observed on 2026-08-31 and both came back negative.** The
coexistence holds, in a role this section did not know about; the proactive
re-mint does not happen at all in a headless run, and neither does any other
use of the auth crossing. Read the 2026-08-31 addendum below before relying on
anything in this section about when a provider command is invoked.

## Addendum: the two unobserved links, observed 2026-08-31

Issue #164 named the two links in ADR-0069's chain that had not been watched
happen: proactive re-minting from the `expires_in` the broker reports, and the
coexistence of a home-local `requirements` layer with `/etc/grok`. Both were
observed on the Agent Host against the installed `grok 1.0.13`
(`edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1`), using the
real enrolled subscription login through the reviewed broker. Both came back
negative, and the second turned up a third finding that decides where a
Delegation authenticates at all.

**`/etc/grok/requirements.toml` is a fourth role, `system-requirements`.** With
it installed and a run's own `$GROK_HOME/requirements.toml` beside it, `inspect
--json` reports both, in two distinct roles, as `voice-grok`:

```json
{ "layers": [
  { "role": "requirements",
    "path": "/var/lib/voice-grok/run/obs164/requirements.toml" },
  { "role": "system-requirements", "path": "/etc/grok/requirements.toml" } ] }
```

The earlier addendum recorded three roles - `managed`, `user`, `requirements` -
because there was no system layer on the host to report a fourth. This one
matters beyond spelling: `apps/worker/src/grok-runner-pin.ts` required exactly
one non-empty layer, with role `requirements`, at the pinned path, so with the
reviewed system layer installed every Delegation would have paused on
`No reviewed requirements layer is in effect at /etc/grok/requirements.toml`.

**The layers merge per key across `/etc` and the home.** With the home-local
layer declaring only `[auth]`, `grok models` as `voice-grok` still reported
`Default model: grok-4.6` - the system layer's own `[models] default`. So the
per-key merge measured earlier between layers reachable without root holds
between these two as well.

**The crossing is in force for the executor and absent for the custody
identity.** As `voice-grok-auth` the same command reports its own empty
home-local `requirements` layer beside the system one, and no `[auth]` in
either, so nothing sends that identity to the broker that reads its credential:

| Identity | `requirements` layer | `system-requirements` layer | `[auth]` in force |
| --- | --- | --- | --- |
| `voice-grok` | the run's own, carrying the crossing | `/etc/grok/requirements.toml` | the broker |
| `voice-grok-auth` | `/var/lib/voice-grok-auth/.grok/requirements.toml`, empty | the same file | none |

**Headless mode never invokes `auth_provider_command`.** This is the finding
that changes the design. With the reviewed crossing staged and reported by
`inspect`, `--output-format json`:

| Run home holds | Result | Broker invoked |
| --- | --- | --- |
| no credential | exit 1 in 0.2 s, `{"type":"error","message":"Not signed in…"}` | **no** |
| an entry that expired 48 s ago | the same error, same speed | **no** |
| the same expired entry, `grok --no-auto-update models` 16 s later | provider invoked, entry re-minted | **yes** |

Same home, same file, same layer: the provider mechanism works in an ordinary
command and is not reached by a headless run. So ADR-0069 as written would
never have authenticated a Delegation at all - the executor stages the crossing
and runs headless, and nothing in that path asks the broker for anything.

**No proactive re-mint, and the run pays for finding out.** A headless run was
started over a credential with three seconds left on it. It spent 305 output
tokens and 4.6 s of model time on one request, got a 401 back, and left the
cached entry untouched. The broker was not invoked a second time. The runner's
own words:

```
Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/responses:
Invalid or expired credentials (auth_kind=none, …, reason=no auth context)
  Model:     grok-4.6
  Auth:      External
  Version:   1.0.13
Your session expired and your sign-in helper could not renew it in the
background. Run /login to sign in again.
```

xAI's documented `expires_in` contract - quoted at item 6a above, and the one
thing ADR-0069 rested on rather than observed - does not hold for a headless
run on this build. The runner spends the token it was handed until it fails.

Issue #164 asked for this to be started "a few minutes before `expires_at`";
three seconds was used instead, because the credential on the host was three
hours from expiry and the shorter window puts expiry inside a run rather than
waiting for one. It is the same question either way - whether the crossing is
invoked a second time before a request is spent - and the two runs above
establish that it is not invoked at all in this mode, at any distance from
expiry.

**`grok login` is what reaches the provider, and it needs no browser.** Run in
the executor's own stripped environment with standard input closed, it invoked
the broker, printed `✓ Signed in as …`, and wrote the minted credential into
the run's home in 0.56 s. The entry it writes carries `auth_mode: "external"`,
an `expires_at` equal to the moment of the call plus the `expires_in` the
broker reported, and no `refresh_token` - the refresh grant stays with
`voice-grok-auth`, which is the property the whole crossing exists to preserve.

**`grok login` removes `$GROK_HOME/requirements.toml`.** Observed twice on
clean homes: the staged layer is present before the login and gone after it,
while `sandbox.toml` beside it survives. A run left in that state would spawn
the model under no layer this contract has reviewed, so the executor stages the
crossing again after the login and reads it back a second time.

**A login whose provider fails does not fail.** With the crossing pointed at a
command exiting 10, `grok login` printed the provider's standard error and then
fell back to an interactive device authorization, printing a user code and
waiting - killed at 30 s, still waiting. There is no non-zero exit to read. The
same happens to a payload the parser rejects: a provider returning a negative
`expires_in` sent the login to the browser flow and left the cached entry
alone. So the executor's time bound is what turns a broken crossing into an
ending, rather than the login's exit code.

**The whole sequence, end to end.** Staging the crossing, signing in, staging
it again, and running headless, as `voice-grok` with the executor's own
environment:

| Step | Result |
| --- | --- |
| `grok-token-broker --probe` | `{"expires_in":10818}` |
| `grok --no-auto-update login` | `✓ Signed in as …`, the layer removed |
| stage the crossing again, `inspect --json` | both layers, both roles |
| headless run | `end_turn`, `total_cost_usd` 0.00122978 |
| broker invocations across all four | **1**, by the login |

**One boundary this build will not report.** `loginPolicy.apiKeyAuthDisabled`
is `false` for both identities with the reviewed `/etc/grok/requirements.toml`
installed, and adding a `[login_policy] disable_api_key_auth` table to that
layer does not move it - `disableApiKeyAuth` stays `null`. It is not a
host-configurable setting on 1.0.13. Both the enrollment wizard's second stage
and `describeGrokConfigurationDrift` require it to be true, so neither can pass
on this host today. Issue #167 carries it. It is recorded here because it was
observed in the same session and because the checks that read it are
load-bearing.

**`/usr/local/libexec/voice-agent` is mode 0700 on this host, and the crossing
needs 0755.** The broker is invoked by `voice-grok`, which cannot traverse a
root-only directory: the first attempt to run it returned `command not found`
rather than a permission error. `ops/setup-agent-host.sh` installs that
directory 0755, so this is host drift rather than a design choice, but nothing
checks it and the symptom is a crossing that silently is not there. The
directory was left as it was found; the enrollment wizard's `test -x` on the
broker would not catch it, because it runs as root. Issue #168 carries it.

Every observation above was made through the reviewed broker and helper
installed at their pinned paths by hand, with that directory temporarily 0755.
The attended deployment-authority upgrade, which is what pins them on a real
host, requires a Fresh Passkey Action and was not run; both files, and the
directory mode, were put back afterwards. `/etc/grok/requirements.toml` and the
sudoers rule were left installed - the one-time setup block in
`docs/operations/grok-enrollment.md` installs both, and they were missing.
