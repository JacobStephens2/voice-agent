import { spawn } from "node:child_process";
import { createSign } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const keeploreRepository = "JacobStephens2/keeplore" as const;
const keeploreRepositoryName = "keeplore" as const;
const keeploreApplicationId = "keeplore-production" as const;
const keeploreProductionBranch = "main" as const;
const keeploreRemote = "https://github.com/JacobStephens2/keeplore.git";
const worktreeRoot = "/var/lib/voice-agent-worktrees/keeplore";
const policyLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const maximumClockSkewMilliseconds = 5 * 60 * 1_000;
const maximumResponseBytes = 1_000_000;
const apiVersion = "2026-03-10";

export interface KeeplorePublicationRequest {
  readonly candidate: {
    readonly automatedVerificationPassed: true;
    readonly headCommit: string;
    readonly visualVerificationPassed: true;
  };
  readonly delegationId: string;
  readonly operation: "create-or-observe-pull-request";
}

export interface KeeplorePublicationResult {
  readonly headCommit: string;
  readonly pullRequest: {
    readonly baseBranch: "main";
    readonly headBranch: string;
    readonly headCommit: string;
    readonly state: "open";
    readonly url: string;
  };
  readonly repository: "JacobStephens2/keeplore";
}

interface GitHubRequest {
  readonly auth: string;
  readonly body?: unknown;
  readonly method: "DELETE" | "GET" | "POST";
  readonly path: string;
}

interface GitHubResponse {
  readonly body: unknown;
  readonly status: number;
}

interface GitResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface AppCredentials {
  readonly appId: number;
  readonly installationId: number;
  readonly privateKey: string;
}

export interface KeeploreCandidatePublisherDependencies {
  readonly credentialHelperPath: string;
  github(request: GitHubRequest): Promise<GitHubResponse>;
  readonly now: () => Date;
  readAppCredentials(): Promise<AppCredentials>;
  readPolicyJournal(): Promise<string>;
  readRegisteredDelegation(delegationId: string): Promise<unknown>;
  resolvePath?(path: string): Promise<string>;
  runGit(
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<GitResult>;
}

interface RegisteredDelegation {
  readonly branch: string;
  readonly delegationId: string;
  readonly sourceCommit: string;
  readonly worktreePath: string;
}

interface PullRequestObservation {
  readonly base: {
    readonly ref: string;
    readonly repository: string;
  };
  readonly head: {
    readonly ref: string;
    readonly repository: string;
    readonly sha: string;
  };
  readonly number: number;
  readonly state: string;
  readonly url: string;
  readonly user: { readonly login: string; readonly type: string };
}

class InstallationAuthenticationError extends Error {}

export function createKeeploreCandidatePublisher(
  dependencies: KeeploreCandidatePublisherDependencies,
): {
  publish(request: unknown): Promise<KeeplorePublicationResult>;
} {
  return {
    async publish(untrustedRequest) {
      const request = parsePublicationRequest(untrustedRequest);
      const delegation = parseRegisteredDelegation(
        await dependencies.readRegisteredDelegation(request.delegationId),
        request.delegationId,
      );
      const credentials = await dependencies.readAppCredentials();
      authorizeRepositoryPolicy({
        appId: credentials.appId,
        installationId: credentials.installationId,
        journal: await dependencies.readPolicyJournal(),
        now: dependencies.now(),
      });
      const resolvedWorktree = await (
        dependencies.resolvePath?.(delegation.worktreePath) ??
        Promise.resolve(delegation.worktreePath)
      );
      if (
        resolvedWorktree !== delegation.worktreePath ||
        !resolvedWorktree.startsWith(`${worktreeRoot}/`)
      ) {
        throw new Error("Registered Delegated Worktree escaped its root");
      }
      await inspectCandidate(
        dependencies,
        delegation,
        request.candidate.headCommit,
      );

      let lastAuthenticationError: InstallationAuthenticationError | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assertDelegationStillActive(dependencies, delegation);
        const token = await mintInstallationToken(
          dependencies,
          credentials,
        );
        try {
          const pullRequest = await publishWithToken({
            delegation,
            dependencies,
            headCommit: request.candidate.headCommit,
            token,
          });
          return {
            headCommit: request.candidate.headCommit,
            pullRequest: {
              baseBranch: keeploreProductionBranch,
              headBranch: delegation.branch,
              headCommit: request.candidate.headCommit,
              state: "open",
              url: pullRequest.url,
            },
            repository: keeploreRepository,
          };
        } catch (error) {
          if (!(error instanceof InstallationAuthenticationError)) throw error;
          lastAuthenticationError = error;
        } finally {
          await revokeInstallationToken(dependencies, token);
        }
      }
      throw lastAuthenticationError ?? new Error("Keeplore publication failed");
    },
  };
}

function parsePublicationRequest(input: unknown): KeeplorePublicationRequest {
  const request = requireRecord(input, "Keeplore publication request");
  requireExactKeys(request, ["candidate", "delegationId", "operation"]);
  if (request.operation !== "create-or-observe-pull-request") {
    throw new Error("Keeplore publication operation is not registered");
  }
  if (
    typeof request.delegationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,120}$/u.test(request.delegationId)
  ) {
    throw new Error("Keeplore publication names an invalid Delegation");
  }
  const candidate = requireRecord(
    request.candidate,
    "Keeplore publication candidate",
  );
  requireExactKeys(candidate, [
    "automatedVerificationPassed",
    "headCommit",
    "visualVerificationPassed",
  ]);
  if (
    candidate.automatedVerificationPassed !== true ||
    candidate.visualVerificationPassed !== true
  ) {
    throw new Error("Keeplore candidate is not verified");
  }
  requireCommit(candidate.headCommit, "Keeplore candidate head");
  return {
    candidate: {
      automatedVerificationPassed: true,
      headCommit: candidate.headCommit,
      visualVerificationPassed: true,
    },
    delegationId: request.delegationId,
    operation: request.operation,
  };
}

function parseRegisteredDelegation(
  input: unknown,
  requestedDelegationId: string,
): RegisteredDelegation {
  const record = requireRecord(input, "Registered Delegation");
  const brief = requireRecord(record.brief, "Registered Delegation brief");
  const codebase = requireRecord(
    brief.registeredCodebase,
    "Registered Codebase",
  );
  const worktree = requireRecord(record.worktree, "Delegated Worktree");
  if (
    record.status !== "running" ||
    record.stopRequested !== false ||
    brief.delegationId !== requestedDelegationId ||
    codebase.applicationId !== keeploreApplicationId ||
    codebase.repository !== keeploreRepository ||
    codebase.productionBranch !== keeploreProductionBranch ||
    typeof codebase.revision !== "number" ||
    !Number.isInteger(codebase.revision) ||
    codebase.revision < 1 ||
    worktree.state !== "running"
  ) {
    throw new Error("Publication request does not match a running Delegation");
  }
  requireCommit(codebase.sourceCommit, "Registered source");
  if (worktree.baseCommit !== codebase.sourceCommit) {
    throw new Error("Delegated Worktree base does not match its brief");
  }
  const expectedBranch = `codex/keeplore-button-${requestedDelegationId}`;
  const expectedPath = `${worktreeRoot}/${requestedDelegationId}`;
  if (worktree.branch !== expectedBranch || worktree.path !== expectedPath) {
    throw new Error("Delegated Worktree is outside its registered assignment");
  }
  return {
    branch: expectedBranch,
    delegationId: requestedDelegationId,
    sourceCommit: codebase.sourceCommit,
    worktreePath: expectedPath,
  };
}

function authorizeRepositoryPolicy(input: {
  readonly appId: number;
  readonly installationId: number;
  readonly journal: string;
  readonly now: Date;
}): void {
  const observations = input.journal
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      try {
        return [requireRecord(JSON.parse(line), "policy observation")];
      } catch {
        return [];
      }
    });
  const rules = latestObservation(observations, "branch-rules");
  const bypass = latestObservation(observations, "branch-bypass");
  const app = latestObservation(observations, "github-app");
  if (rules === undefined || bypass === undefined || app === undefined) {
    throw new Error("Keeplore publication policy is absent or stale");
  }
  for (const observation of [rules, bypass, app]) {
    if (
      observation.application !== keeploreApplicationId ||
      !freshTimestamp(observation.observedAt, input.now)
    ) {
      throw new Error("Keeplore publication policy is absent or stale");
    }
  }
  if (
    rules.repository !== keeploreRepository ||
    rules.branch !== keeploreProductionBranch ||
    rules.observedBy !== "github-app-installation" ||
    !hasRequiredStringMembers(rules.activeRules, [
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]) ||
    !hasStringMember(rules.requiredChecks, "keeplore-verification")
  ) {
    throw new Error("Keeplore production rules do not preserve Human Merge");
  }
  if (
    bypass.repository !== keeploreRepository ||
    bypass.branch !== keeploreProductionBranch ||
    bypass.attestedBy !== "owner" ||
    !freshTimestamp(bypass.attestedAt, input.now) ||
    !Array.isArray(bypass.bypassActors) ||
    bypass.bypassActors.length !== 0 ||
    typeof bypass.rulesetsRead !== "number" ||
    !Number.isInteger(bypass.rulesetsRead) ||
    bypass.rulesetsRead < 1
  ) {
    throw new Error("Keeplore production-rule bypass is not currently attested");
  }
  if (
    app.observedBy !== "github-app-credentials" ||
    app.appId !== input.appId ||
    app.installationId !== input.installationId ||
    app.repositorySelection !== "selected" ||
    !hasExactStringMembers(app.repositories, [keeploreRepository]) ||
    !hasExactPermissions(app.permissions, {
      checks: "read",
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    })
  ) {
    throw new Error("Keeplore GitHub App grant is not the reviewed installation");
  }
}

async function inspectCandidate(
  dependencies: KeeploreCandidatePublisherDependencies,
  delegation: RegisteredDelegation,
  headCommit: string,
): Promise<void> {
  const git = (args: readonly string[]) =>
    dependencies.runGit(
      [
        "-C",
        delegation.worktreePath,
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      safeGitEnvironment(),
    );
  const [
    branch,
    status,
    head,
    remote,
    pushRemote,
    ancestor,
    commitCount,
    changed,
  ] =
    await Promise.all([
      git(["branch", "--show-current"]),
      git(["status", "--porcelain=v1", "--untracked-files=all"]),
      git(["rev-parse", "HEAD"]),
      git(["remote", "get-url", "--all", "origin"]),
      git(["remote", "get-url", "--push", "--all", "origin"]),
      git([
        "merge-base",
        "--is-ancestor",
        delegation.sourceCommit,
        headCommit,
      ]),
      git([
        "rev-list",
        "--count",
        `${delegation.sourceCommit}..${headCommit}`,
      ]),
      git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "-z",
        `${delegation.sourceCommit}...${headCommit}`,
      ]),
    ]);
  if (
    branch.exitCode !== 0 ||
    branch.stdout.trim() !== delegation.branch ||
    status.exitCode !== 0 ||
    status.stdout.length !== 0 ||
    head.exitCode !== 0 ||
    head.stdout.trim() !== headCommit ||
    remote.exitCode !== 0 ||
    remote.stdout.trim() !== keeploreRemote ||
    pushRemote.exitCode !== 0 ||
    pushRemote.stdout.trim() !== keeploreRemote ||
    ancestor.exitCode !== 0 ||
    commitCount.exitCode !== 0 ||
    commitCount.stdout.trim() !== "1" ||
    changed.exitCode !== 0 ||
    !hasExactStringMembers(splitNullDelimited(changed.stdout), ["ui/style.css"])
  ) {
    throw new Error("Keeplore candidate is not the clean verified assignment");
  }
}

async function mintInstallationToken(
  dependencies: KeeploreCandidatePublisherDependencies,
  credentials: AppCredentials,
): Promise<string> {
  const now = dependencies.now();
  const response = await dependencies.github({
    auth: createAppJwt(credentials, now),
    body: {
      permissions: { contents: "write", pull_requests: "write" },
      repositories: [keeploreRepositoryName],
    },
    method: "POST",
    path: `/app/installations/${credentials.installationId}/access_tokens`,
  });
  if (response.status !== 201) {
    throw new Error("Keeplore publication token could not be minted");
  }
  const token = requireRecord(response.body, "installation token response");
  if (
    typeof token.token !== "string" ||
    token.token.length < 20 ||
    token.token.length > 1_000 ||
    !freshTokenExpiry(token.expires_at, now) ||
    token.repository_selection !== "selected" ||
    !hasNarrowedTokenPermissions(token.permissions) ||
    !tokenNamesOnlyKeeplore(token.repositories)
  ) {
    throw new Error("GitHub returned an unbounded publication token");
  }
  return token.token;
}

function createAppJwt(credentials: AppCredentials, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64Url(
    JSON.stringify({ exp: expiresAt, iat: issuedAt, iss: credentials.appId }),
  );
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credentials.privateKey).toString("base64url")}`;
}

async function publishWithToken(input: {
  readonly delegation: RegisteredDelegation;
  readonly dependencies: KeeploreCandidatePublisherDependencies;
  readonly headCommit: string;
  readonly token: string;
}): Promise<PullRequestObservation> {
  const push = await input.dependencies.runGit(
    [
      "-C",
      input.delegation.worktreePath,
      "--no-replace-objects",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${input.dependencies.credentialHelperPath}`,
      "-c",
      "credential.useHttpPath=true",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "http.extraHeader=",
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.proxy=",
      "-c",
      "http.sslVerify=true",
      "-c",
      "remote.origin.proxy=",
      "push",
      "--porcelain",
      "origin",
      `${input.headCommit}:refs/heads/${input.delegation.branch}`,
    ],
    {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GITHUB_APP_INSTALLATION_TOKEN: input.token,
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
  );
  if (push.exitCode !== 0) {
    if (reportsAuthenticationFailure(push.stderr)) {
      throw new InstallationAuthenticationError(
        "GitHub rejected the installation credential",
      );
    }
    throw new Error("Keeplore branch publication failed");
  }

  await assertDelegationStillActive(input.dependencies, input.delegation);
  let observation = await findPullRequest(input);
  if (observation === undefined) {
    await assertDelegationStillActive(input.dependencies, input.delegation);
    const created = await githubInstallationRequest(input.dependencies, {
      auth: input.token,
      body: {
        base: keeploreProductionBranch,
        body: "Restricted Keeplore Button Trial. Human Merge required; no deployment was performed.",
        draft: false,
        head: input.delegation.branch,
        maintainer_can_modify: false,
        title: "Match Keeplore table action controls",
      },
      method: "POST",
      path: `/repos/${keeploreRepository}/pulls`,
    });
    if (created.status !== 201) {
      throw new Error("Keeplore pull request could not be created");
    }
    observation = parsePullRequest(created.body);
  }
  const independentlyObserved = await githubInstallationRequest(
    input.dependencies,
    {
      auth: input.token,
      method: "GET",
      path: `/repos/${keeploreRepository}/pulls/${observation.number}`,
    },
  );
  if (independentlyObserved.status !== 200) {
    throw new Error("Keeplore pull request could not be independently observed");
  }
  const exact = parsePullRequest(independentlyObserved.body);
  assertMatchingPullRequest(exact, input.delegation.branch, input.headCommit);
  return exact;
}

async function assertDelegationStillActive(
  dependencies: KeeploreCandidatePublisherDependencies,
  expected: RegisteredDelegation,
): Promise<void> {
  const current = parseRegisteredDelegation(
    await dependencies.readRegisteredDelegation(expected.delegationId),
    expected.delegationId,
  );
  if (
    current.branch !== expected.branch ||
    current.sourceCommit !== expected.sourceCommit ||
    current.worktreePath !== expected.worktreePath
  ) {
    throw new Error("Registered Delegation changed during publication");
  }
}

async function findPullRequest(input: {
  readonly delegation: RegisteredDelegation;
  readonly dependencies: KeeploreCandidatePublisherDependencies;
  readonly headCommit: string;
  readonly token: string;
}): Promise<PullRequestObservation | undefined> {
  const query = new URLSearchParams({
    base: keeploreProductionBranch,
    head: `JacobStephens2:${input.delegation.branch}`,
    per_page: "2",
    state: "open",
  });
  const response = await githubInstallationRequest(input.dependencies, {
    auth: input.token,
    method: "GET",
    path: `/repos/${keeploreRepository}/pulls?${query.toString()}`,
  });
  if (response.status !== 200 || !Array.isArray(response.body)) {
    throw new Error("Keeplore pull requests could not be observed");
  }
  if (response.body.length === 0) return undefined;
  if (response.body.length !== 1) {
    throw new Error("Keeplore publication branch has multiple pull requests");
  }
  const observed = parsePullRequest(response.body[0]);
  assertMatchingPullRequest(observed, input.delegation.branch, input.headCommit);
  return observed;
}

async function githubInstallationRequest(
  dependencies: KeeploreCandidatePublisherDependencies,
  request: GitHubRequest,
): Promise<GitHubResponse> {
  const response = await dependencies.github(request);
  if (response.status === 401) {
    throw new InstallationAuthenticationError(
      "GitHub installation credential expired or was revoked",
    );
  }
  return response;
}

async function revokeInstallationToken(
  dependencies: KeeploreCandidatePublisherDependencies,
  token: string,
): Promise<void> {
  try {
    await dependencies.github({
      auth: token,
      method: "DELETE",
      path: "/installation/token",
    });
  } catch {
    // Revocation is best effort; the token is already short-lived and is not retained.
  }
}

function parsePullRequest(input: unknown): PullRequestObservation {
  const pullRequest = requireRecord(input, "pull request");
  const base = requireRecord(pullRequest.base, "pull request base");
  const baseRepository = requireRecord(base.repo, "pull request base repository");
  const head = requireRecord(pullRequest.head, "pull request head");
  const headRepository = requireRecord(head.repo, "pull request head repository");
  const user = requireRecord(pullRequest.user, "pull request author");
  if (
    typeof pullRequest.number !== "number" ||
    !Number.isInteger(pullRequest.number) ||
    pullRequest.number < 1 ||
    typeof pullRequest.state !== "string" ||
    typeof pullRequest.html_url !== "string" ||
    typeof base.ref !== "string" ||
    typeof baseRepository.full_name !== "string" ||
    typeof head.ref !== "string" ||
    typeof head.sha !== "string" ||
    typeof headRepository.full_name !== "string" ||
    typeof user.login !== "string" ||
    typeof user.type !== "string"
  ) {
    throw new Error("GitHub returned an invalid pull request");
  }
  return {
    base: { ref: base.ref, repository: baseRepository.full_name },
    head: {
      ref: head.ref,
      repository: headRepository.full_name,
      sha: head.sha,
    },
    number: pullRequest.number,
    state: pullRequest.state,
    url: pullRequest.html_url,
    user: { login: user.login, type: user.type },
  };
}

function assertMatchingPullRequest(
  pullRequest: PullRequestObservation,
  branch: string,
  headCommit: string,
): void {
  if (
    pullRequest.state !== "open" ||
    pullRequest.base.ref !== keeploreProductionBranch ||
    pullRequest.base.repository !== keeploreRepository ||
    pullRequest.head.ref !== branch ||
    pullRequest.head.sha !== headCommit ||
    pullRequest.head.repository !== keeploreRepository ||
    pullRequest.user.type !== "Bot" ||
    !pullRequest.user.login.endsWith("[bot]") ||
    pullRequest.url !==
      `https://github.com/${keeploreRepository}/pull/${pullRequest.number}`
  ) {
    throw new Error("Observed pull request is outside the registered publication");
  }
}

function latestObservation(
  observations: readonly Record<string, unknown>[],
  kind: string,
): Record<string, unknown> | undefined {
  return observations
    .filter(
      (observation) =>
        observation.kind === kind &&
        typeof observation.observedAt === "string" &&
        Number.isFinite(Date.parse(observation.observedAt)),
    )
    .sort((left, right) =>
      String(left.observedAt).localeCompare(String(right.observedAt)),
    )
    .at(-1);
}

function freshTimestamp(timestamp: unknown, now: Date): boolean {
  if (typeof timestamp !== "string") return false;
  const observedAt = Date.parse(timestamp);
  const age = now.getTime() - observedAt;
  return (
    Number.isFinite(observedAt) &&
    age >= -maximumClockSkewMilliseconds &&
    age < policyLifetimeMilliseconds
  );
}

function freshTokenExpiry(expiry: unknown, now: Date): boolean {
  if (typeof expiry !== "string") return false;
  const expiresAt = Date.parse(expiry);
  const lifetime = expiresAt - now.getTime();
  return (
    Number.isFinite(expiresAt) &&
    lifetime >= 60_000 &&
    lifetime <= 65 * 60 * 1_000
  );
}

function tokenNamesOnlyKeeplore(repositories: unknown): boolean {
  if (!Array.isArray(repositories) || repositories.length !== 1) return false;
  const repository = repositories[0];
  if (!isRecord(repository)) return false;
  return (
    repository.name === keeploreRepositoryName &&
    repository.full_name === keeploreRepository
  );
}

function hasExactPermissions(
  input: unknown,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (!isRecord(input)) return false;
  const keys = Object.keys(input).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key, index) =>
        key === expectedKeys[index] && input[key] === expected[key],
    )
  );
}

function hasNarrowedTokenPermissions(input: unknown): boolean {
  return (
    hasExactPermissions(input, {
      contents: "write",
      pull_requests: "write",
    }) ||
    hasExactPermissions(input, {
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    })
  );
}

function hasStringMember(input: unknown, expected: string): boolean {
  return Array.isArray(input) && input.includes(expected);
}

function hasRequiredStringMembers(
  input: unknown,
  required: readonly string[],
): boolean {
  return (
    Array.isArray(input) &&
    input.every((value) => typeof value === "string") &&
    required.every((value) => input.includes(value))
  );
}

function hasExactStringMembers(
  input: unknown,
  expected: readonly string[],
): boolean {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    return false;
  }
  const actual = [...input].sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((value, index) => value === sortedExpected[index])
  );
}

function splitNullDelimited(value: string): readonly string[] {
  return value.split("\0").filter(Boolean);
}

function reportsAuthenticationFailure(stderr: string): boolean {
  return /(?:authentication failed|bad credentials|http 401|token.*(?:expired|revoked))/iu.test(
    stderr,
  );
}

function safeGitEnvironment(): Readonly<Record<string, string>> {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function requireCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} is not a full commit identity`);
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("Keeplore publication request contains unregistered fields");
  }
}

async function startProductionServer(): Promise<void> {
  if (process.geteuid?.() !== 0) {
    throw new Error("Keeplore publisher must run as root");
  }
  const socketPath =
    process.env.VOICE_AGENT_KEEPLORE_PUBLISHER_SOCKET_PATH ??
    "/run/voice-agent-keeplore-publisher/publisher.sock";
  const databasePath =
    process.env.VOICE_AGENT_DATABASE_PATH ??
    "/var/lib/voice-agent/voice-agent.sqlite";
  const policyJournalPath =
    process.env.KEEPLORE_REPOSITORY_POLICY_JOURNAL ??
    "/var/lib/keeplore-promotions/repository-policy.jsonl";
  const appConfigurationPath =
    process.env.KEEPLORE_GITHUB_APP_CONFIGURATION ??
    "/etc/voice-agent/keeplore-github-app.conf";
  const appKeyPath =
    process.env.KEEPLORE_GITHUB_APP_KEY_PATH ??
    "/etc/voice-agent/keeplore-github-app-private-key.pem";
  const credentialHelperPath =
    "/usr/local/libexec/voice-agent/git-credential-github-app.sh";
  const publisher = createKeeploreCandidatePublisher({
    credentialHelperPath,
    github: productionGitHubRequest,
    now: () => new Date(),
    async readAppCredentials() {
      await Promise.all([
        assertRootOwnedCredential(appConfigurationPath, false),
        assertRootOwnedCredential(appKeyPath, true),
      ]);
      const [configuration, privateKey] = await Promise.all([
        readFile(appConfigurationPath, "utf8"),
        readFile(appKeyPath, "utf8"),
      ]);
      const [appId, installationId, ...extra] = configuration.trim().split("\t");
      if (
        extra.length !== 0 ||
        !/^[0-9]+$/u.test(appId ?? "") ||
        !/^[0-9]+$/u.test(installationId ?? "")
      ) {
        throw new Error("Keeplore GitHub App configuration is invalid");
      }
      return {
        appId: Number(appId),
        installationId: Number(installationId),
        privateKey,
      };
    },
    async readPolicyJournal() {
      await assertRootOwnedCredential(policyJournalPath, false);
      return readFile(policyJournalPath, "utf8");
    },
    async readRegisteredDelegation(delegationId) {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = database
          .prepare(`
            SELECT brief_json, status, stop_requested, worktree_json
            FROM keeplore_delegations WHERE delegation_id = ?
          `)
          .get(delegationId) as
          | {
              readonly brief_json: string;
              readonly status: string;
              readonly stop_requested: number;
              readonly worktree_json: string;
            }
          | undefined;
        if (row === undefined) return undefined;
        return {
          brief: JSON.parse(row.brief_json) as unknown,
          status: row.status,
          stopRequested: row.stop_requested === 1,
          worktree: JSON.parse(row.worktree_json) as unknown,
        };
      } finally {
        database.close();
      }
    },
    resolvePath: realpath,
    runGit: productionGit,
  });

  await unlink(socketPath).catch((error: unknown) => {
    if (!isMissingFile(error)) throw error;
  });
  const server = createServer((request, response) => {
    void handlePublisherRequest(publisher, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o660);
  const stop = () => server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function handlePublisherRequest(
  publisher: ReturnType<typeof createKeeploreCandidatePublisher>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/publish") {
      sendJson(response, 404, { error: "not-found" });
      return;
    }
    sendJson(response, 200, await publisher.publish(await readJson(request)));
  } catch {
    sendJson(response, 422, { error: "publication-refused" });
  }
}

async function productionGitHubRequest(
  request: GitHubRequest,
): Promise<GitHubResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.github.com${request.path}`, {
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${request.auth}`,
        ...(request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        "user-agent": "voice-agent-keeplore-publisher",
        "x-github-api-version": apiVersion,
      },
      method: request.method,
      signal: controller.signal,
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumResponseBytes) {
      throw new Error("GitHub response exceeded its bound");
    }
    return {
      body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function productionGit(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", args, {
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (destination: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumResponseBytes) child.kill("SIGKILL");
      else destination.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (bytes > maximumResponseBytes) {
        reject(new Error("Git output exceeded its bound"));
        return;
      }
      resolve({
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

async function assertRootOwnedCredential(
  path: string,
  privateCredential: boolean,
): Promise<void> {
  const metadata = await lstat(path);
  const mode = metadata.mode & 0o777;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (privateCredential && mode !== 0o400 && mode !== 0o600) ||
    (!privateCredential && (mode & 0o022) !== 0)
  ) {
    throw new Error("Keeplore publisher credential source is not root-owned");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const untrustedChunk of request) {
    const chunk = Buffer.from(untrustedChunk);
    bytes += chunk.length;
    if (bytes > 64 * 1_024) {
      throw new Error("Keeplore publication request exceeded its bound");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(serialized),
    "content-type": "application/json",
  });
  response.end(serialized);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startProductionServer();
}
