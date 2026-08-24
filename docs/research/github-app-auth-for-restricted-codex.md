# GitHub App authentication for restricted Codex

_Researched 2026-08-23 from GitHub's official documentation and this
repository's reviewed code and architecture records._

## Recommendation

Use a short-lived GitHub App **installation access token**, not a dedicated
GitHub user, for the Keeplore runner's fixed branch-publication and pull-request
operations. Reuse the existing Keeplore GitHub App for this trial. It was
deliberately registered for this role: it is installed on
`JacobStephens2/keeplore` alone, has exactly `contents: write`,
`pull_requests: write`, and `checks: read`, and is required to have no
production-ruleset bypass. That is the identity ADR-0016 already specifies for
non-production pushes and pull requests
([ADR-0016](../adr/0016-use-a-github-app-and-verified-human-merge-events.md),
[Keeplore onboarding operations](../operations/keeplore-onboarding.md#least-privilege-github-app)).

Do not copy the App private key into `voice-codex`, and do not hand a raw token
to model-generated commands. Keep the private key root-owned and have a small,
reviewed publication boundary mint a token immediately before the fixed push
and pull-request calls. The token should be scoped again to Keeplore and to the
permissions needed for that publication, then revoked or allowed to expire
afterward. GitHub recommends installation tokens for server automation: they
are service identities decoupled from users, can be limited to selected
repositories and fine-grained permissions, and expire after one hour
([GitHub: installation access tokens](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#github-app-installation-access-tokens)).

This removes the device-flow problem and the persistent owner credential now
stored for `voice-codex`. `gh auth login` and `gh auth setup-git` are unnecessary:
GitHub CLI accepts `GH_TOKEN` for headless use and gives it precedence over
stored credentials
([GitHub CLI environment](https://cli.github.com/manual/gh_help_environment),
[GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login)).
Direct REST calls are even easier to allowlist than `gh` for this narrow path.

## Why an installation token fits this Delegation

GitHub Apps have no repository permissions by default, and GitHub recommends
selecting the minimum required permissions. Unlike a user token, an
installation token succeeds according to the App installation's permissions,
not a human account's changing access
([GitHub: choosing App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)).
An installation may be limited to selected repositories, and a token can be
narrowed further when it is minted. `POST
/app/installations/{installation_id}/access_tokens` accepts `repositories` or
`repository_ids` and a `permissions` object; neither can grant more than the
installation already has. The token expires after one hour
([GitHub: create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)).

The repository already has most of the machinery:

- The Keeplore App configuration and private key are separate, root-owned
  files, and the App installation is assessed as selected-repository access to
  Keeplore alone
  ([Keeplore onboarding operations](../operations/keeplore-onboarding.md#least-privilege-github-app)).
- `keeplore_github_token` already invokes the root-credentialed installation
  token helper without an interactive login
  ([`keeplore-config.sh`](../../ops/keeplore/keeplore-config.sh)).
- `github-source-token.sh` already signs an App JWT and exchanges it for an
  installation token, while `git-credential-github-app.sh` emits the official
  HTTPS credential shape
  ([token helper](../../ops/release/github-source-token.sh),
  [Git credential helper](../../ops/release/git-credential-github-app.sh)).
- The current restricted executor keeps model commands offline and performs
  Git and pull-request operations in fixed host code. Its publication seam is
  therefore the right place to inject an ephemeral credential
  ([`keeplore-codex-executor.ts`](../../apps/worker/src/keeplore-codex-executor.ts)).

The current token helper asks for the installation's full grant and prints the
token to its caller. For this use it should accept only a pinned, typed Keeplore
publication request and send a body equivalent to:

```json
{
  "repositories": ["keeplore"],
  "permissions": {
    "contents": "write",
    "pull_requests": "write"
  }
}
```

`metadata: read` remains implicit. `checks: read` should be added only to a
separate observation token if the runner begins reading GitHub check runs. The
App installation may retain `checks: read` because the existing reviewed
least-privilege contract requires it; token-level narrowing prevents the
current publication path from receiving it needlessly. GitHub documents both
repository and permission narrowing on the installation-token endpoint
([GitHub: generating an installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).

## Exact permissions

| Runner operation | App repository permission | Reason |
| --- | --- | --- |
| Fetch or push over HTTPS | `contents: write` for pushes (`read` is enough for reads) | GitHub requires the Contents permission for HTTP Git and accepts the installation token as the HTTP password ([GitHub: choosing permissions for Git access](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access)). |
| Create a pull request | `pull_requests: write` | `POST /repos/{owner}/{repo}/pulls` accepts installation tokens and requires Pull requests write ([GitHub: create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)). |
| Update an existing pull request | `pull_requests: write` | The update endpoint requires Pull requests write ([GitHub: update a pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request)). |
| List or read the scoped pull request | `pull_requests: read` (satisfied by write) | List requires Pull requests read; get accepts Pull requests read or Contents read ([GitHub: pull-request endpoints](https://docs.github.com/en/rest/pulls/pulls)). |
| Read CI check runs, if added | `checks: read` | Listing check runs for a Git ref accepts installation tokens and requires Checks read ([GitHub: list check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)). |

No Administration, Actions, Workflows, Members, Secrets, Deployments, or
organization permission is needed. In particular, pushing the existing
`ui/style.css` commit does not edit `.github/workflows`, so GitHub's separate
Workflows permission is unnecessary
([GitHub: choosing permissions for Git access](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access)).

The current executor does not read GitHub check runs. It runs the registered
PHPUnit command locally, performs the authenticated browser verification, then
uses `gh pr view` only to verify the PR's base, head, head commit, state, and URL
([`keeplore-codex-executor.ts`](../../apps/worker/src/keeplore-codex-executor.ts)).
Therefore the current publication token needs only Contents write and Pull
requests write. If issue #13 later waits for `keeplore-verification`, mint a
second read-oriented token with Checks read and query the documented check-run
endpoint.

## HTTPS Git and pull-request authentication

For HTTP Git, GitHub's documented form is:

```text
https://x-access-token:TOKEN@github.com/OWNER/REPO.git
```

The token is the HTTP password; the username is `x-access-token`
([GitHub: choosing permissions for Git access](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access)).
Do not actually embed the token in the stored remote URL, command line, logs, or
Delegation Result. Use the repository's credential helper so Git receives
`username=x-access-token` and the token through the credential protocol
([`git-credential-github-app.sh`](../../ops/release/git-credential-github-app.sh)).

For API calls, installation tokens work with both REST and GraphQL and are sent
as `Authorization: Bearer TOKEN`
([GitHub: authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
There are two viable fixed-runner implementations:

1. Prefer direct, schema-checked REST calls for list/get/create/update PR. This
   makes the allowed endpoints explicit and makes it impossible for this code
   path to call the merge endpoint accidentally.
2. If retaining `gh pr create` and `gh pr view`, set `GH_TOKEN` only in those
   child processes and set `GH_PROMPT_DISABLED=1`. GitHub CLI documents
   `GH_TOKEN` as its headless automation mechanism; no `hosts.yml` or login is
   required
   ([GitHub CLI environment](https://cli.github.com/manual/gh_help_environment)).

Mint after Codex and all verification finish, not when the potentially
30-minute model run starts. Use the same fresh token for the immediate push and
PR transaction, revoke it with `DELETE /installation/token` in a best-effort
`finally`, and mint a new one for a retry rather than caching it. GitHub states
that installation tokens expire after one hour and may be revoked earlier
([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#expire-tokens)).

## Actor and production-boundary implications

An installation token identifies the App's built-in bot account, not Jacob or
a machine user. GitHub describes this actor as, for example,
`@jenkins[bot]`; installation-token activity is attributed to the App
([GitHub: Apps versus OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps#token-based-identification)).
The resulting Keeplore PR should therefore be authored by the Keeplore App bot.
The local Git commit author remains the fixed author written by the executor;
GitHub associates command-line commits using the commit's configured email,
independently of the push credential
([GitHub: commit email addresses](https://docs.github.com/en/account-and-profile/concepts/email-addresses#commit-email-addresses)).

`contents: write` permits Git ref writes; it is not branch-scoped. It also
satisfies the permission on GitHub's PR merge endpoint. Consequently, a raw
installation token is broader than the single desired call even though the
App is repository-scoped. The reviewed runner must continue to enforce the
assigned `HEAD:refs/heads/codex/keeplore-button-<delegation>` ref, must never
expose the token to Codex, and should allowlist only Git push and PR
list/get/create/update—not PR merge. GitHub documents that the merge endpoint
requires Contents write, showing why permission selection alone cannot prove
“cannot merge”
([GitHub: merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)).

Production protection supplies the independent second barrier. The `main`
ruleset must continue to require a pull request and the verification check,
block force pushes and deletion, and contain no bypass actors. GitHub Apps are
explicitly eligible ruleset bypass actors, so the Keeplore App must not appear
on that list
([GitHub: available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[Keeplore onboarding operations](../operations/keeplore-onboarding.md#production-branch-rules-and-ci)).
For classic branch restrictions, GitHub Apps with Contents write can likewise
be added as authorized push actors; do not grant the Keeplore App direct
production-branch access
([GitHub: protected-branch App restrictions](https://docs.github.com/en/rest/branches/branch-protection#add-app-access-restrictions)).

This preserves the repository's decisive distinction: the App bot opens the
candidate PR, while Promotion accepts only a merge into `main` performed by an
authenticated human GitHub user
([ADR-0016](../adr/0016-use-a-github-app-and-verified-human-merge-events.md),
[Keeplore promotion operations](../operations/keeplore-onboarding.md#promotion-verification-and-rollback)).

## Reuse the existing App or create a coding App?

### Reuse now

Reusing the current Keeplore App is the smallest and most consistent design:

- ADR-0016 already defines one dedicated least-privilege App for both
  non-production publication and verified Human Merge handling
  ([ADR-0016](../adr/0016-use-a-github-app-and-verified-human-merge-events.md)).
- Its accepted permission set is exactly the required set, its installation is
  already limited to Keeplore, and its absence from bypass is already assessed
  and owner-attested
  ([Keeplore onboarding operations](../operations/keeplore-onboarding.md#least-privilege-github-app)).
- The root-owned credentials, JWT implementation, installation token exchange,
  rotation surface, and repository-policy observation already exist. Reuse
  does not grant the App a new repository or a new permission.
- The App's bot actor remains durable even if a human account changes or is
  removed. GitHub documents that App installations are bounded independently
  of a user's resource access
  ([GitHub: Apps versus OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps#what-can-github-apps-and-oauth-apps-access)).

The cost is shared fate: coding publication, deployment reconciliation, and
policy reads appear under one App actor and share one private-key rotation. A
defect in a token broker might mint the full combined grant. Explicit
token-level narrowing, endpoint/ref allowlists, and root-only key custody are
therefore required.

### Split later only for a concrete isolation need

A separate private “Keeplore Coding” App would provide a distinct bot actor,
independent revocation/key rotation, and separate audit attribution. It should
still be installed only on Keeplore with Contents write and Pull requests
write, no checks permission unless used, and no bypass. The deployment App
could then be reduced to the read permissions its remaining paths actually
need.

That split is worthwhile if coding and deployment acquire different operators,
incident-response boundaries, or lifecycles. It is not automatically safer if
the existing deployment App keeps its current write grant: that would add a
second long-lived private key and installation without removing the first
write-capable identity. GitHub lists the need to create and securely store an
App private key and regenerate one-hour tokens on demand as the operational
cost of this model
([GitHub: installation access tokens](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#github-app-installation-access-tokens)).

## Recommended repository architecture

1. **Attended migration:** remove the mistaken persistent `JacobStephens2`
   login from `/var/lib/voice-codex/.config/gh`, then make the trial assert that
   no stored GitHub user credential is required. Keep the separate Codex
   subscription login unchanged. The current wizard and account rejection are
   in [`run-keeplore-button-trial.sh`](../../ops/acceptance/run-keeplore-button-trial.sh).
2. **Root-owned token boundary:** extend the existing Keeplore App helper or add
   a small root-owned Unix-socket publisher. It accepts a typed request
   containing only the registered repository, assigned branch, exact head
   commit, `main` base, and create-or-observe PR operation. It never returns
   the private key. Prefer having the boundary perform the network operations;
   if it returns a token to the fixed runner, return only a freshly narrowed
   token and keep it out of files, arguments, output, and model-child
   environments.
3. **Fixed Git publication:** keep the HTTPS remote token-free. Push exactly
   `HEAD:refs/heads/<assigned-branch>` with the ephemeral credential helper.
   Reject `main`, deletion refspecs, force flags, multiple refspecs, foreign
   repositories, and a head SHA different from the verified worktree.
4. **Fixed PR publication:** use allowlisted REST list/get/create/update calls
   with exact Keeplore repository, `main` base, assigned head, fixed title/body,
   and observed head SHA. Do not implement or proxy the merge endpoint.
5. **Independent GitHub policy:** keep the App absent from every bypass list
   and re-run the existing repository-policy collector/owner attestation before
   live acceptance. Installation-token restriction does not replace branch
   protection.
6. **No persistent user auth:** remove the `gh auth login`, `/user` identity
   check, and `gh auth setup-git` steps. If `gh` remains for PR calls, supply
   only `GH_TOKEN` to each fixed child. Do not put `GH_TOKEN` in
   `trustedEnvironment()` globally, because that environment is also used by
   unrelated Git operations and fixed helpers
   ([executor environment](../../apps/worker/src/keeplore-codex-executor.ts)).

This narrow publisher is not production Operations Broker authority. It can
only publish the already-verified candidate to a non-production ref and manage
its matching PR. It must have no Keeplore deploy command, `main` ref, merge
operation, Voice Agent repository, or arbitrary GitHub API passthrough.

## Migration and regression coverage

Before replacing the user flow, add tests that prove:

- the installation-token request names only repository `keeplore` and the
  exact requested permissions, refuses an all-repositories installation or
  unexpected returned grant, validates `expires_at`, and never logs the token;
- the App private key and configuration remain root-owned and unreadable by
  `voice-codex`; model sandbox probes cannot read the key, ephemeral token,
  former `hosts.yml`, or browser state;
- the Git helper supplies `x-access-token` only for `github.com` and the
  registered Keeplore remote, while stored remotes and process arguments
  contain no token;
- publication accepts only the Delegation's clean verified head and exact
  assigned branch, and rejects `main`, force/delete/multiple refspecs, a foreign
  repository, a stale SHA, and any second changed path;
- PR calls accept only list/get/create/update for the exact Keeplore head and
  `main` base, and a merge/close/foreign-PR request cannot cross the boundary;
- an expired/revoked token causes one freshly minted retry without replaying
  model work, verification, commit, or an already-created PR;
- the App-bot PR observation replaces the current human-login assertion and
  still verifies open state, base, head branch, head SHA, and URL;
- the Keeplore App remains selected-repository only with the exact installed
  grant, and the owner-attested ruleset has no App bypass; and
- the attended trial completes a real non-production push and App-authored PR,
  while `main` is unchanged and Promotion still requires a later Human Merge.

The repository already has scenario coverage for Keeplore credential
separation and the restricted Delegation lifecycle; extend those seams rather
than introducing a second interactive identity flow
([Keeplore GitHub credential scenarios](../../apps/scenario/test/keeplore-github-credentials.scenario.test.ts),
[Keeplore Button Trial scenarios](../../apps/scenario/test/keeplore-button-trial.scenario.test.ts)).

## Bottom line

A GitHub App is a better fit than a new GitHub account here. The repo already
created the right App and policy boundary. The missing piece is not another
GitHub identity; it is a reviewed, narrowly typed way for the fixed Keeplore
publisher to obtain and consume a fresh installation token without giving the
private key, token, arbitrary GitHub API access, merge authority, or production
ref access to Codex.
