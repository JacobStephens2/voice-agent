# Grok-first Code Subagent MVP

_Researched 2026-08-23 from xAI's official Grok Build, Grok, API, and legal
documentation; OpenCode's official documentation and pinned source; and this
repository's current Subagent implementation and architecture records._

## Recommendation

Use xAI's official **Grok Build CLI** as the first Code Subagent provider. Pin
the reviewed CLI release and checksum, select the logical model `grok-build`,
authenticate through attended device-code OAuth backed by the owner's Grok
subscription, and invoke it noninteractively with `--prompt-file`,
`--output-format json`, `--json-schema`, `--always-approve`, and
`--no-auto-update`. Grok Build is currently powered by Grok 4.6, and xAI
recommends `grok-build` as the default model for coding and agent sessions
([Grok Build overview](https://docs.x.ai/build/overview),
[settings](https://docs.x.ai/build/settings),
[Grok 4.6](https://docs.x.ai/developers/models/grok-4-6)). Record both the
logical selector and the exact model reported by every run.

OpenCode **does officially support SuperGrok OAuth**, including a documented
device-code flow for a headless, remote, or VPS machine. It is a valid later
adapter, but it adds another provider, model-catalog, credential-store, and
tool-execution layer without improving the first MVP's headless contract.
xAI's first-party CLI already provides structured one-shot output, explicit
session and stop metadata, an approval bypass, tool permissions, sandbox
profiles, and an Agent Client Protocol server
([xAI's OpenCode announcement](https://x.ai/news/grok-opencode),
[OpenCode xAI provider](https://opencode.ai/docs/providers/#xai),
[Grok Build headless mode](https://docs.x.ai/build/cli/headless-scripting)).

Subscription OAuth and the xAI API are separate authentication and billing
routes. The MVP must not set `XAI_API_KEY`, silently fall back to an API key, or
report absent OAuth cost fields as zero dollars. It must prove that the
accepted run used OAuth and preserve the Durable Task when subscription quota
or authentication pauses execution.

## Why Grok Build is the MVP runner

xAI documents the following Grok Build interfaces directly:

- `grok login --device-auth` performs browser-assisted device authorization
  for a terminal without a browser. `grok inspect --json` reports the effective
  configuration, and `grok models` reports available models
  ([CLI reference](https://docs.x.ai/build/cli/reference)).
- `grok -p` runs a single prompt. `--prompt-file` avoids shell quoting and is
  necessary because headless mode does not read a piped prompt from standard
  input. `--output-format json` produces a final machine-readable result;
  `streaming-json` emits progress and tool events. The result includes the
  session ID, stop reason, request ID, and usage fields when the provider makes
  them available
  ([headless mode](https://docs.x.ai/build/cli/headless-scripting),
  [pinned headless guide](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)).
- `--json-schema` constrains the final response to the supplied schema and
  implies JSON output. The pinned CLI source exposes it beside
  `--prompt-json`, `--prompt-file`, `--output-format`, and `--model`
  ([pinned CLI arguments](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-pager/src/app/cli.rs#L483-L527)).
- `--always-approve` (also named `--yolo`) accepts tool requests without a
  telephone round trip. `--allow` and `--deny` still define tool policy, while
  a sandbox independently limits the operating-system effects of approved
  tools. Deny rules and hooks still apply in always-approve mode
  ([permissions](https://docs.x.ai/build/features/permissions),
  [CLI reference](https://docs.x.ai/build/cli/reference)).
- `--cwd`, `--worktree`, `--ref`, `--max-turns`, `--no-plan`, `--no-memory`,
  `--no-subagents`, and `--disable-web-search` allow a typed executor to select
  the working context and bound a run. `grok agent stdio` exposes ACP if a
  later implementation needs a persistent interactive session; one process
  per Durable Task is simpler for the MVP
  ([CLI reference](https://docs.x.ai/build/cli/reference),
  [headless mode](https://docs.x.ai/build/cli/headless-scripting)).

The implementation candidate current at research time is Grok Build 0.2.111.
Pin the accepted binary version and digest, disable self-update with
`--no-auto-update`, and repeat acceptance before promoting an upgrade. The
inspected upstream revision for the contracts above is
`07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8`; xAI publishes a first-party
change log for released builds
([Grok Build change log](https://x.ai/build/changelog)). The pinned revision is
research evidence, not permission to track `main` in production.

## Proposed invocation contract

The runner should construct arguments directly rather than invoke a shell. Its
command should be equivalent to:

```text
grok --no-auto-update \
  --cwd <delegation-root> \
  --model grok-build \
  --prompt-file <task-brief> \
  --output-format json \
  --json-schema <administrative-result-schema> \
  --always-approve \
  --max-turns <reviewed-bound> \
  --no-plan \
  --no-memory \
  --sandbox voice-agent-task
```

The fixed executor, not the model, creates the Delegation root and its
worktrees, task brief, schema, ephemeral home, and reviewed sandbox profile.
It validates the returned JSON independently and records at least:

- provider and pinned runner version;
- logical selector and provider-reported model;
- OAuth authentication route, never the token;
- session ID, request ID, stop reason, token usage, and whether usage is
  incomplete;
- requested and completed repository branches, commits, verification, broker
  operations, and proposed pull requests;
- a sanitized summary and references to sanitized artifacts.

`--always-approve` should mean “do not ask Jacob to approve routine model tool
calls,” not “place the provider process outside every boundary.” The owner can
grant broad read and repository mutation authority while a fixed executor,
operating-system sandbox, typed Operations Broker, publisher, and Evidence
Record keep credentials out of model-selected commands and keep merge-to-main
outside the delegation.

Use `streaming-json` only when the worker needs live tool progress or wants to
project a telephone status update. Use final JSON for the durable result. The
worker must cap each line and total output, ignore unrecognized event types,
redact before persistence, and treat process exit as insufficient unless the
final object passes the reviewed schema.

## Models and subscription access

The MVP needs one model. Configure `[models] default = "grok-build"`, which
xAI documents as the recommended alias for coding and agent sessions. At the
time of this research, Grok Build is powered by Grok 4.6. The API's explicit
`grok-4.6` slug, token prices, and context details describe the metered xAI API;
they do not prove that a consumer subscription invocation is billed through
the API
([settings](https://docs.x.ai/build/settings),
[Grok 4.6 API model](https://docs.x.ai/developers/models/grok-4-6),
[API pricing](https://docs.x.ai/developers/pricing)).

An attended owner enrollment should run `grok login --device-auth` under a
dedicated credential-custody service, then prove a subscription-backed model
request. The resulting run must identify OAuth as its authentication source.
Do not provision `XAI_API_KEY` in this MVP. If xAI changes model entitlement or
the exact model behind `grok-build`, the runner should pause as “provider
contract changed,” not silently select a metered API route or another model.

xAI's OpenCode integration is independent corroboration that a SuperGrok or X
Premium subscription can authorize coding-agent use without an API key. The
official announcement gives separate browser and “Headless / Remote / VPS”
device-code methods, and OpenCode's xAI provider documentation distinguishes
subscription login from pay-as-you-go API-key setup
([xAI OpenCode announcement](https://x.ai/news/grok-opencode),
[OpenCode providers](https://opencode.ai/docs/providers/#xai)). OpenCode's
pinned xAI plugin implements the OAuth device flow and refreshes access tokens
with the scopes `openid`, `profile`, `email`, `offline_access`,
`grok-cli:access`, and `api:access`
([OpenCode xAI OAuth source](https://github.com/anomalyco/opencode/blob/826d9ad46a22bef0294998e08daa3c4904fea28f/packages/opencode/src/plugin/xai.ts)).

This support makes OpenCode a legitimate fallback, not the preferred MVP. The
source inspected here is OpenCode 1.18.21 at
`826d9ad46a22bef0294998e08daa3c4904fea28f`. If it is added later, pin its
accepted version, use `opencode run --format json --model ...`, and isolate its
documented credential file under
`~/.local/share/opencode/auth.json`
([OpenCode CLI](https://opencode.ai/docs/cli/#run),
[OpenCode providers](https://opencode.ai/docs/providers/)).

## Credential custody and isolation

Grok Build's normal login stores credentials in `~/.grok/auth.json` with mode
`0600`, but xAI warns that a process able to read that file can use the
credential. A cached login also takes precedence over `XAI_API_KEY`
([authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)).
Giving the broadly authorized Code Subagent the durable Grok home would
therefore violate this repository's Credential Custody Boundary.

Use two identities:

1. A narrow `voice-grok-auth` service owns the OAuth refresh credential created
   by attended device authorization. It exposes only a caller-authenticated,
   task-scoped token-helper operation.
2. The `voice-grok` executor owns the model process, worktrees, and an
   ephemeral per-task `GROK_HOME`. It has no durable `auth.json`, API key,
   GitHub App key, SSH key, sudo token, or production credential.

Grok Build supports an external authentication provider command. Its current
source describes the token as remaining in process memory and never being
written to `auth.json`; models can name an `auth_provider` in trusted
configuration
([external auth provider](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-shell/src/auth/auth_provider.rs#L1-L14),
[model auth-provider configuration](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md#L345-L370)).
The fixed parent may call that helper, but a model-generated shell process must
be unable to execute it or read the parent's memory. Enforce that with a
root-owned helper and configuration, a sandbox-denied helper path,
authenticated local IPC, a non-inherited one-task capability, a distinct Unix
identity, a stripped shell environment, `NoNewPrivileges`, process-visibility
and ptrace restrictions.

The ephemeral Grok home may contain session and diagnostic state. Quarantine
or delete it after extracting a bounded, sanitized Evidence Record. Never copy
raw stdout, stderr, provider diagnostics, process environments, or session
files into the repository or telephone transcript.

## Filesystem, network, repositories, and host operations

xAI separates tool permission from OS sandboxing. A custom sandbox profile can
grant selected read/write roots, deny paths, and restrict child-process
network. On Linux, `restrict_network` blocks child-process network while Grok's
built-in model requests, `web_search`, and `web_fetch` remain available. A
custom profile with deny rules fails closed when bubblewrap cannot enforce it;
that behavior must be tested on the promoted host
([sandbox guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md)).

Stage every repository worktree involved in a task below one Delegation root
and make that root the process CWD. The reviewed custom profile should allow:

- read access to repository and host material within the owner's authorization;
- write access to the task's worktrees, task scratch space, and ephemeral Grok
  home;
- no direct write access to source checkouts, credentials, the publisher,
  evidence store, system configuration, service units, or live application
  data;
- no model-generated child-process network.

Because the user wants broad network research and reversible host work, expose
those effects through typed interfaces rather than raw credentials:

- keep Grok's built-in public `web_search` and `web_fetch` enabled for a
  Research Delegation;
- use a fixed dependency or source broker for registry and Git network access;
- use the Operations Broker for reviewed service, package, device, production
  observation, and reversible host operations;
- use the existing fixed GitHub App publisher to create branches and pull
  requests after verification; never give Grok a GitHub credential or permit
  direct merge to `main` or `master`;
- reject ad hoc production-data mutation even if application code is
  version-controlled.

Grok's shell environment policy defaults matter because an inherited provider
or publisher secret would become readable to model-selected commands. Trusted
configuration should use a core/minimal inherited environment and an explicit
allowlist rather than the full service environment
([configuration reference](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md)).

Place non-overridable requirements in root-managed configuration and use
`grok inspect --json` before every accepted run to record the effective source
of settings, permissions, MCP servers, plugins, skills, and sandbox. xAI's
enterprise configuration supports system requirements and external
authentication intended to keep security policy outside project control
([enterprise configuration](https://docs.x.ai/build/enterprise)). A repository
must not be able to replace the fixed Operations Broker MCP with a same-named
project server.

## Repository integration

The current implementation already contains the right process boundary but is
Keeplore- and Codex-specific:

- [`apps/worker/src/keeplore-subagent-runner-server.ts`](../../apps/worker/src/keeplore-subagent-runner-server.ts)
  owns one active JSON-stdin/stdout child, bounds output, caches terminal
  results, and supports an interruption signal.
- [`apps/worker/src/subagent-server.ts`](../../apps/worker/src/subagent-server.ts)
  and
  [`apps/worker/src/keeplore-codex-executor.ts`](../../apps/worker/src/keeplore-codex-executor.ts)
  hard-code the Codex/Keeplore executor, prompt, paths, and result contract.
- [`packages/contracts/src/keeplore-delegation.ts`](../../packages/contracts/src/keeplore-delegation.ts)
  fixes the provider to `codex` and describes a much narrower workspace and
  host boundary.
- [`ops/systemd/voice-agent-subagent.service`](../../ops/systemd/voice-agent-subagent.service)
  runs the restricted `voice-codex` identity and deliberately withholds
  production and broker access.

Generalize the runner behind a typed provider adapter rather than weakening
the Keeplore executor in place. Introduce an Administrative Delegation brief
and result that can name multiple repository worktrees, `provider: "grok"`,
the task's broker capabilities, required verification, source revisions,
publication requests, research artifacts, and sanitized usage/evidence. Reuse
the one-active-run, result cache, bounded-output, and stop semantics.

[ADR-0002](../adr/0002-separate-personal-subscription-auth-from-commercial-auth.md)
already allows personal-subscription CLIs.
[ADR-0024](../adr/0024-isolate-provider-logins-and-code-disclosure.md) requires
per-provider identities and attended login, but its current unrelated-repo and
credential assumptions are narrower than the owner's new Administrative
Autonomy authorization. Record that changed authority in a new ADR; do not
silently reinterpret ADR-0024 or expose credentials merely because repository
read access is broad.

## Research Delegation support

The repository's requested Research Delegation can use the existing skill
directly. Grok Build's current skill discovery includes repository-local
`.agents/skills` alongside its Grok- and Claude-compatible locations
([pinned skill discovery](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-agent/src/prompt/skills.rs#L49-L55)).
The fixed research prompt should explicitly name
`.agents/skills/research/SKILL.md`, require primary sources and a Markdown
artifact under `docs/research/`, and allow the skill to create its prescribed
background research agent. Do not pass `--no-subagents` for that profile.

Acceptance must establish behavior rather than trust a self-report: effective
configuration lists the exact skill file, the event stream or audit evidence
shows it was selected, a background child runs, headless execution waits for
the child to finish, and the final branch contains the cited artifact and only
the expected changes. The fixed publisher may then open a pull request; the
research agent may not merge it.

## Usage, quota, and privacy caveats

The consumer subscription is not an unlimited or metered-at-zero API account.
xAI's Grok FAQ describes usage limits and a shared weekly allowance across
eligible Grok surfaces; consumer terms also permit rate limits
([Grok FAQ](https://docs.x.ai/grok/faq),
[consumer terms](https://x.ai/legal/terms-of-service)). Treat quota exhaustion,
HTTP 429, entitlement failure, and an expired login as explicit provider pause
states. Preserve the task, branch, worktrees, and completed commits, then
resume after quota or attended reauthentication. Do not fall back to
`XAI_API_KEY`.

Headless usage fields are provider-dependent. The official guide notes that
OAuth-backed requests may omit monetary cost until the server provides it, and
usage can be marked incomplete
([headless mode](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)).
Persist token counts, model, authentication route, and completeness. Record an
absent cost as “unknown/not supplied,” never `$0`.

Provider disclosure and provider retention are separate decisions. xAI says
API Zero Data Retention applies only when enabled for the team; its consumer
privacy material explains that user content may be used for model improvement
unless the relevant controls are changed
([API security FAQ](https://docs.x.ai/developers/faq/security),
[consumer privacy FAQ](https://x.ai/legal/faq)). During enrollment, record the
actual Grok Build privacy setting and disable code-data retention unless the
owner explicitly chooses otherwise. Do not infer ZDR from SuperGrok status.

## Required acceptance tests

Promotion should require a real subscription-backed end-to-end suite, not
only mocks:

1. **Supply chain and configuration.** Verify the pinned binary digest and
   version, `--no-auto-update`, root requirements, effective model, skill/MCP
   sources from `grok inspect --json`, and fail activation after any unexpected
   provider or configuration change.
2. **OAuth, not API billing.** Complete attended device authorization, execute
   a real `grok-build` request with no `XAI_API_KEY`, prove the reported auth
   source is OAuth, exercise refresh, and prove missing/invalid OAuth fails
   without API fallback.
3. **Credential non-disclosure.** Have model-selected tools attempt to read
   Grok/OpenCode auth stores, service environments, parent process memory,
   token helpers, SSH material, GitHub App keys, publisher IPC, and Operations
   Broker credentials. Every route to raw credentials must fail, and canary
   tokens must be absent from stdout, stderr, sessions, worktrees, and evidence.
4. **Sandbox enforcement.** Prove broad reads and writes within all staged
   task worktrees, rejection of writes outside the Delegation root, blocked
   child-process network, working built-in model/web tools, stripped shell
   environment, and fail-closed behavior when bubblewrap or a deny profile is
   unavailable or malformed.
5. **Headless result contract.** Run a real task with `--prompt-file` and
   `--json-schema`; validate provider, model, session, stop reason, usage, git
   changes, verification, and requested broker/publication operations. Exercise
   malformed JSON, schema failure, oversized output, max-turn exhaustion,
   timeout, signal termination, and provider error.
6. **Durability and Stop.** Interrupt a run and confirm the entire process
   group stops while completed commits and incomplete work remain recoverable.
   Resume by session or a fresh bounded run without resetting, stashing, or
   deleting user work.
7. **Multiple repositories and pull requests.** Discover previously unseen
   repositories, create isolated worktrees and non-production branches per
   changed repository, leave user checkouts untouched, verify each change, and
   have the fixed publisher open one or more pull requests. Direct push or
   merge to `main`/`master` must fail.
8. **Administrative operations.** Exercise typed production observation,
   reversible service/package/device operations, code deployment proposal,
   journaled rollback, and denial of raw sudo and ad hoc production-data
   mutation.
9. **Research skill.** Execute a real headless Research Delegation that
   explicitly selects this repository's `research` skill, uses a background
   child, consults public primary sources through Grok's web tools, waits for
   completion, writes a cited `docs/research/*.md` artifact, and proposes it by
   pull request.
10. **Quota and evidence hygiene.** Simulate or induce entitlement, 401, 429,
    and incomplete-usage responses; verify durable pause/resume, no API-key
    fallback, “unknown” cost handling, redaction of injected canary secrets,
    and quarantine or cleanup of ephemeral raw provider state.

Passing these tests supports the desired “always approve” interaction without
making a consumer OAuth credential, publication key, production credential, or
raw sudo capability available to model-generated code.
