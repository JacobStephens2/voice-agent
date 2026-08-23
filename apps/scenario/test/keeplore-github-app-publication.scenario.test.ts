import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

import {
  createKeeploreCandidatePublisher,
  type KeeploreCandidatePublisherDependencies,
} from "../../../ops/release/keeplore-github-app-publisher.ts";

const now = "2026-08-23T14:00:00.000Z";
const sourceCommit = "1111111111111111111111111111111111111111";
const headCommit = "2222222222222222222222222222222222222222";
const delegationId = "delegation-button-trial";
const branch = `codex/keeplore-button-${delegationId}`;
const worktreePath =
  `/var/lib/voice-agent-worktrees/keeplore/${delegationId}`;
const installationToken = "ghs_fixture-installation-token";

test("the privileged publisher scopes one token and observes the App-authored pull request", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gitInvocations: Array<{
    readonly alternateObjects?: string | undefined;
    readonly args: readonly string[];
    readonly credentialPath?: string | undefined;
    readonly token?: string | undefined;
  }> = [];
  const githubInvocations: Array<{
    readonly auth: "app" | "installation";
    readonly body?: unknown;
    readonly method: string;
    readonly path: string;
  }> = [];
  let pullRequestCreated = false;
  let tokenRevoked = false;
  const pullRequest = observedPullRequest();
  const publisher = createKeeploreCandidatePublisher({
    credentialHelperPath:
      "/usr/local/libexec/voice-agent/git-credential-github-app.sh",
    createIsolatedPushRepository: isolatedPushRepository,
    async github(request) {
      githubInvocations.push({
        auth: request.auth === installationToken ? "installation" : "app",
        ...(request.body === undefined ? {} : { body: request.body }),
        method: request.method,
        path: request.path,
      });
      if (
        request.method === "POST" &&
        request.path === "/app/installations/456/access_tokens"
      ) {
        return {
          body: {
            expires_at: "2026-08-23T14:59:00.000Z",
            permissions: { contents: "write", pull_requests: "write" },
            repositories: [
              { full_name: "JacobStephens2/keeplore", name: "keeplore" },
            ],
            repository_selection: "selected",
            token: installationToken,
          },
          status: 201,
        };
      }
      if (
        request.method === "GET" &&
        request.path.startsWith("/repos/JacobStephens2/keeplore/pulls?")
      ) {
        return {
          body: pullRequestCreated ? [pullRequest] : [],
          status: 200,
        };
      }
      if (
        request.method === "POST" &&
        request.path === "/repos/JacobStephens2/keeplore/pulls"
      ) {
        pullRequestCreated = true;
        return { body: pullRequest, status: 201 };
      }
      if (
        request.method === "GET" &&
        request.path === "/repos/JacobStephens2/keeplore/pulls/101"
      ) {
        return { body: pullRequest, status: 200 };
      }
      if (
        request.method === "DELETE" &&
        request.path === "/installation/token"
      ) {
        tokenRevoked = true;
        return { body: undefined, status: 204 };
      }
      throw new Error(`Unexpected GitHub request: ${request.method} ${request.path}`);
    },
    async readAppCredentials() {
      return {
        appId: 123,
        installationId: 456,
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      };
    },
    async readPolicyJournal() {
      return policyJournal();
    },
    async readRegisteredDelegation() {
      return registeredDelegation();
    },
    async runGit(args, environment) {
      gitInvocations.push({
        args,
        ...(environment?.GIT_ALTERNATE_OBJECT_DIRECTORIES === undefined
          ? {}
          : { alternateObjects: environment.GIT_ALTERNATE_OBJECT_DIRECTORIES }),
        ...(environment?.GITHUB_APP_EXPECTED_PATH === undefined
          ? {}
          : { credentialPath: environment.GITHUB_APP_EXPECTED_PATH }),
        ...(environment?.GITHUB_APP_INSTALLATION_TOKEN === undefined
          ? {}
          : { token: environment.GITHUB_APP_INSTALLATION_TOKEN }),
      });
      const command = args.join(" ");
      if (command.includes("branch --show-current")) {
        return { exitCode: 0, stderr: "", stdout: `${branch}\n` };
      }
      if (command.includes("status --porcelain")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command.includes("rev-parse HEAD")) {
        return { exitCode: 0, stderr: "", stdout: `${headCommit}\n` };
      }
      if (command.includes("remote get-url") && command.endsWith(" origin")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "https://github.com/JacobStephens2/keeplore.git\n",
        };
      }
      if (command.includes("merge-base --is-ancestor")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command.includes("rev-list --count")) {
        return { exitCode: 0, stderr: "", stdout: "1\n" };
      }
      if (command.includes(" diff ") && command.includes("--name-only -z")) {
        return { exitCode: 0, stderr: "", stdout: "ui/style.css\0" };
      }
      if (command.includes(" push ")) {
        return { exitCode: 0, stderr: "", stdout: "published\n" };
      }
      throw new Error(`Unexpected Git command: ${command}`);
    },
    now: () => new Date(now),
  });

  const result = await publisher.publish({
    candidate: {
      automatedVerificationPassed: true,
      headCommit,
      visualVerificationPassed: true,
    },
    delegationId,
    operation: "create-or-observe-pull-request",
  });

  expect(result).toEqual({
    headCommit,
    pullRequest: {
      baseBranch: "main",
      headBranch: branch,
      headCommit,
      state: "open",
      url: "https://github.com/JacobStephens2/keeplore/pull/101",
    },
    repository: "JacobStephens2/keeplore",
  });
  expect(JSON.stringify(result)).not.toContain(installationToken);
  expect(tokenRevoked).toBe(true);
  expect(githubInvocations[0]).toMatchObject({
    auth: "app",
    body: {
      permissions: { contents: "write", pull_requests: "write" },
      repositories: ["keeplore"],
    },
    method: "POST",
    path: "/app/installations/456/access_tokens",
  });
  const push = gitInvocations.find((invocation) =>
    invocation.args.includes("push"),
  );
  expect(push).toMatchObject({
    args: expect.arrayContaining([
      "--git-dir",
      "/run/voice-agent-keeplore-publisher/git-fixture",
      "https://github.com/JacobStephens2/keeplore.git",
      `${headCommit}:refs/heads/${branch}`,
    ]),
    alternateObjects: "/var/lib/voice-agent-worktrees/keeplore.git/objects",
    credentialPath: "JacobStephens2/keeplore.git",
    token: installationToken,
  });
  expect(push?.args.join(" ")).not.toContain(installationToken);
  expect(push?.args).toEqual(
    expect.arrayContaining([
      "core.hooksPath=/dev/null",
      "http.followRedirects=false",
      "http.proxy=",
    ]),
  );
  expect(
    push?.args.filter((argument) => argument.includes(":refs/")),
  ).toEqual([`${headCommit}:refs/heads/${branch}`]);
  expect(push?.args.join(" ")).not.toContain("refs/heads/main");
  expect(push?.args).not.toContain("origin");
  expect(
    gitInvocations
      .filter((invocation) => !invocation.args.includes("push"))
      .every((invocation) =>
        invocation.args.includes(`safe.directory=${worktreePath}`),
      ),
  ).toBe(true);
  expect(
    githubInvocations.some(
      (invocation) =>
        invocation.method === "GET" &&
        invocation.path === "/repos/JacobStephens2/keeplore/pulls/101",
    ),
  ).toBe(true);
});

test("request-controlled repositories, endpoints, and refspecs are rejected", async () => {
  let dependencyUsed = false;
  const publisher = createKeeploreCandidatePublisher({
    credentialHelperPath: "/unused",
    async createIsolatedPushRepository() {
      dependencyUsed = true;
      throw new Error("Push repository must remain untouched");
    },
    async github() {
      dependencyUsed = true;
      throw new Error("GitHub must remain untouched");
    },
    async readAppCredentials() {
      dependencyUsed = true;
      throw new Error("Credentials must remain untouched");
    },
    async readPolicyJournal() {
      dependencyUsed = true;
      throw new Error("Policy must remain untouched");
    },
    async readRegisteredDelegation() {
      dependencyUsed = true;
      throw new Error("Registration must remain untouched");
    },
    async runGit() {
      dependencyUsed = true;
      throw new Error("Git must remain untouched");
    },
    now: () => new Date(now),
  });
  const candidate = {
    automatedVerificationPassed: true,
    headCommit,
    visualVerificationPassed: true,
  };
  const invalidRequests = [
    {
      candidate,
      delegationId,
      operation: "merge-pull-request",
    },
    {
      candidate,
      delegationId,
      operation: "close-pull-request",
    },
    {
      candidate,
      delegationId,
      operation: "create-or-observe-pull-request",
      repository: "somebody/else",
    },
    {
      candidate,
      delegationId,
      endpoint: "/repos/JacobStephens2/keeplore/pulls/101/merge",
      operation: "create-or-observe-pull-request",
    },
    {
      candidate,
      delegationId,
      operation: "create-or-observe-pull-request",
      refspec: "+HEAD:refs/heads/main",
    },
    {
      candidate,
      delegationId,
      operation: "create-or-observe-pull-request",
      refspecs: ["HEAD:refs/heads/one", ":refs/heads/two"],
    },
    {
      candidate: { ...candidate, automatedVerificationPassed: false },
      delegationId,
      operation: "create-or-observe-pull-request",
    },
  ];

  for (const request of invalidRequests) {
    await expect(publisher.publish(request)).rejects.toBeDefined();
  }
  expect(dependencyUsed).toBe(false);
});

test("foreign, production, stale, and policy-mismatched assignments mint no token", async () => {
  const cases: Array<{
    readonly delegation?: unknown;
    readonly journal?: string;
    readonly requestedHead?: string;
  }> = [
    { delegation: null },
    { delegation: registeredDelegation({ repository: "somebody/else" }) },
    { delegation: registeredDelegation({ branch: "main" }) },
    { requestedHead: "3333333333333333333333333333333333333333" },
    { journal: policyJournal({ observedAt: "2026-08-01T13:00:00.000Z" }) },
    { journal: policyJournal({ appId: 999 }) },
    { journal: policyJournal({ appSlug: "some-other-app" }) },
    { journal: policyJournal({ bypassActors: ["keeplore-publisher"] }) },
    { journal: policyJournal({ installationId: 999 }) },
    { journal: policyJournal({ requiredChecks: [] }) },
  ];

  for (const boundaryCase of cases) {
    let githubCalls = 0;
    const publisher = createKeeploreCandidatePublisher(
      boundaryDependencies({
        delegation: boundaryCase.delegation,
        githubCalled: () => {
          githubCalls += 1;
        },
        ...(boundaryCase.journal === undefined
          ? {}
          : { journal: boundaryCase.journal }),
      }),
    );
    await expect(
      publisher.publish({
        candidate: {
          automatedVerificationPassed: true,
          headCommit: boundaryCase.requestedHead ?? headCommit,
          visualVerificationPassed: true,
        },
        delegationId,
        operation: "create-or-observe-pull-request",
      }),
    ).rejects.toBeDefined();
    expect(githubCalls).toBe(0);
  }
});

test("a tokenized or changed push remote is rejected before token minting", async () => {
  let githubCalls = 0;
  const publisher = createKeeploreCandidatePublisher({
    ...boundaryDependencies({
      githubCalled: () => {
        githubCalls += 1;
      },
    }),
    async runGit(args) {
      const command = args.join(" ");
      if (command.includes("remote get-url --push")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "https://token@github.com/somebody/else.git\n",
        };
      }
      return observedGit(args, headCommit);
    },
  });

  await expect(publisher.publish(publicationRequest())).rejects.toBeDefined();
  expect(githubCalls).toBe(0);
});

test("every returned but overbroad installation token is revoked", async () => {
  const invalidGrants = [
    { expires_at: "2026-08-23T16:00:00.000Z" },
    {
      permissions: {
        checks: "read",
        contents: "write",
        pull_requests: "write",
      },
    },
    {
      repositories: [
        { full_name: "somebody/else", name: "else" },
      ],
    },
  ];

  for (const [index, invalidGrant] of invalidGrants.entries()) {
    const token = `ghs_invalid-installation-token-${index}`;
    let revoked = 0;
    let pushes = 0;
    const publisher = createKeeploreCandidatePublisher({
      ...boundaryDependencies(),
      async github(request) {
        if (request.path === "/app/installations/456/access_tokens") {
          return {
            body: { ...installationTokenResponse(token), ...invalidGrant },
            status: 201,
          };
        }
        if (request.method === "DELETE" && request.path === "/installation/token") {
          expect(request.auth).toBe(token);
          revoked += 1;
          return { body: undefined, status: 204 };
        }
        throw new Error(`Unexpected invalid-grant request: ${request.method} ${request.path}`);
      },
      async runGit(args) {
        if (args.includes("push")) pushes += 1;
        return observedGit(args, headCommit);
      },
    });

    await expect(publisher.publish(publicationRequest())).rejects.toBeDefined();
    expect(revoked).toBe(1);
    expect(pushes).toBe(0);
  }
});

test("foreign pull requests and any bot other than the reviewed App are rejected", async () => {
  const invalidPullRequests = [
    observedPullRequest({ userLogin: "some-other-app[bot]" }),
    observedPullRequest({
      headCommit: "3333333333333333333333333333333333333333",
    }),
    observedPullRequest({ headRepository: "somebody/else" }),
    observedPullRequest({ baseBranch: "develop" }),
  ];

  for (const [index, pullRequest] of invalidPullRequests.entries()) {
    const token = `ghs_wrong-pr-installation-token-${index}`;
    let createRequests = 0;
    const publisher = createKeeploreCandidatePublisher({
      ...boundaryDependencies(),
      async github(request) {
        if (request.path === "/app/installations/456/access_tokens") {
          return { body: installationTokenResponse(token), status: 201 };
        }
        if (request.method === "GET" && request.path.includes("/pulls?")) {
          return { body: [pullRequest], status: 200 };
        }
        if (request.method === "POST" && request.path.endsWith("/pulls")) {
          createRequests += 1;
        }
        if (request.method === "DELETE" && request.path === "/installation/token") {
          return { body: undefined, status: 204 };
        }
        throw new Error(`Unexpected foreign-PR request: ${request.method} ${request.path}`);
      },
      async runGit(args) {
        if (args.includes("push")) {
          return { exitCode: 0, stderr: "", stdout: "published\n" };
        }
        return observedGit(args, headCommit);
      },
    });

    await expect(publisher.publish(publicationRequest())).rejects.toBeDefined();
    expect(createRequests).toBe(0);
  }
});

test("the credential helper returns a token only for the exact registered HTTPS path", () => {
  const helper = "../../../ops/release/git-credential-github-app.sh";
  const environment = {
    GITHUB_APP_EXPECTED_PATH: "JacobStephens2/keeplore.git",
    GITHUB_APP_INSTALLATION_TOKEN: installationToken,
    PATH: "/usr/bin:/bin",
  };
  const accepted = spawnSync(helper, ["get"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
    env: environment,
    input: "protocol=https\nhost=github.com\npath=JacobStephens2/keeplore.git\n\n",
  });
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain(`password=${installationToken}\n`);

  for (const credentialRequest of [
    "protocol=https\nhost=example.com\npath=JacobStephens2/keeplore.git\n\n",
    "protocol=https\nhost=github.com\npath=somebody/else.git\n\n",
    "protocol=http\nhost=github.com\npath=JacobStephens2/keeplore.git\n\n",
  ]) {
    const rejected = spawnSync(helper, ["get"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      env: environment,
      input: credentialRequest,
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).not.toContain(installationToken);
  }
});

test("one fresh token retry observes an already-created pull request without recreating it", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let tokensMinted = 0;
  let tokensRevoked = 0;
  let pushes = 0;
  let createRequests = 0;
  let pullRequestExists = false;
  const pullRequest = observedPullRequest();
  const publisher = createKeeploreCandidatePublisher({
    ...boundaryDependencies(),
    async github(request) {
      if (request.path === "/app/installations/456/access_tokens") {
        tokensMinted += 1;
        const token = `ghs_retry-installation-token-${tokensMinted}`;
        return {
          body: {
            expires_at: "2026-08-23T14:59:00.000Z",
            permissions: { contents: "write", pull_requests: "write" },
            repositories: [
              { full_name: "JacobStephens2/keeplore", name: "keeplore" },
            ],
            repository_selection: "selected",
            token,
          },
          status: 201,
        };
      }
      if (request.path === "/installation/token") {
        tokensRevoked += 1;
        return { body: undefined, status: 204 };
      }
      if (request.method === "GET" && request.path.includes("/pulls?")) {
        return { body: pullRequestExists ? [pullRequest] : [], status: 200 };
      }
      if (request.method === "POST" && request.path.endsWith("/pulls")) {
        createRequests += 1;
        pullRequestExists = true;
        return { body: { message: "token expired after request acceptance" }, status: 401 };
      }
      if (request.method === "GET" && request.path.endsWith("/pulls/101")) {
        return { body: pullRequest, status: 200 };
      }
      throw new Error(`Unexpected retry request: ${request.method} ${request.path}`);
    },
    async readAppCredentials() {
      return {
        appId: 123,
        installationId: 456,
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      };
    },
    async runGit(args) {
      if (args.includes("push")) {
        pushes += 1;
        return { exitCode: 0, stderr: "", stdout: "published\n" };
      }
      return observedGit(args, headCommit);
    },
  });

  const result = await publisher.publish({
    candidate: {
      automatedVerificationPassed: true,
      headCommit,
      visualVerificationPassed: true,
    },
    delegationId,
    operation: "create-or-observe-pull-request",
  });

  expect(result.pullRequest.url).toBe(
    "https://github.com/JacobStephens2/keeplore/pull/101",
  );
  expect(tokensMinted).toBe(2);
  expect(tokensRevoked).toBe(2);
  expect(pushes).toBe(2);
  expect(createRequests).toBe(1);
});

function publicationRequest(): unknown {
  return {
    candidate: {
      automatedVerificationPassed: true,
      headCommit,
      visualVerificationPassed: true,
    },
    delegationId,
    operation: "create-or-observe-pull-request",
  };
}

function installationTokenResponse(token: string): Record<string, unknown> {
  return {
    expires_at: "2026-08-23T14:59:00.000Z",
    permissions: { contents: "write", pull_requests: "write" },
    repositories: [
      { full_name: "JacobStephens2/keeplore", name: "keeplore" },
    ],
    repository_selection: "selected",
    token,
  };
}

function registeredDelegation(
  overrides: { readonly branch?: string; readonly repository?: string } = {},
): unknown {
  return {
    brief: {
      delegationId,
      registeredCodebase: {
        applicationId: "keeplore-production",
        productionBranch: "main",
        repository: overrides.repository ?? "JacobStephens2/keeplore",
        revision: 1,
        sourceCommit,
      },
    },
    status: "running",
    stopRequested: false,
    worktree: {
      baseCommit: sourceCommit,
      branch: overrides.branch ?? branch,
      path: worktreePath,
      state: "running",
    },
  };
}

function policyJournal(
  overrides: {
    readonly appId?: number;
    readonly appSlug?: string;
    readonly bypassActors?: readonly string[];
    readonly installationId?: number;
    readonly observedAt?: string;
    readonly requiredChecks?: readonly string[];
  } = {},
): string {
  const observedAt = overrides.observedAt ?? "2026-08-23T13:00:00.000Z";
  return [
    {
      activeRules: [
        "deletion",
        "non_fast_forward",
        "pull_request",
        "required_status_checks",
      ],
      application: "keeplore-production",
      branch: "main",
      kind: "branch-rules",
      observedAt,
      observedBy: "github-app-installation",
      repository: "JacobStephens2/keeplore",
      requiredChecks: overrides.requiredChecks ?? ["keeplore-verification"],
    },
    {
      application: "keeplore-production",
      attestedAt: observedAt,
      attestedBy: "owner",
      branch: "main",
      bypassActors: overrides.bypassActors ?? [],
      kind: "branch-bypass",
      observedAt,
      repository: "JacobStephens2/keeplore",
      rulesetsRead: 1,
    },
    {
      appId: overrides.appId ?? 123,
      appSlug: overrides.appSlug ?? "keeplore-publisher",
      application: "keeplore-production",
      installationId: overrides.installationId ?? 456,
      kind: "github-app",
      observedAt,
      observedBy: "github-app-credentials",
      permissions: {
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      repositories: ["JacobStephens2/keeplore"],
      repositorySelection: "selected",
    },
  ]
    .map((observation) => JSON.stringify(observation))
    .join("\n");
}

function observedPullRequest(
  overrides: {
    readonly baseBranch?: string;
    readonly headCommit?: string;
    readonly headRepository?: string;
    readonly userLogin?: string;
  } = {},
): unknown {
  return {
    base: {
      ref: overrides.baseBranch ?? "main",
      repo: { full_name: "JacobStephens2/keeplore" },
    },
    head: {
      ref: branch,
      repo: {
        full_name: overrides.headRepository ?? "JacobStephens2/keeplore",
      },
      sha: overrides.headCommit ?? headCommit,
    },
    html_url: "https://github.com/JacobStephens2/keeplore/pull/101",
    number: 101,
    state: "open",
    user: {
      login: overrides.userLogin ?? "keeplore-publisher[bot]",
      type: "Bot",
    },
  };
}

function boundaryDependencies(
  options: {
    readonly delegation?: unknown;
    readonly githubCalled?: () => void;
    readonly journal?: string;
  } = {},
): KeeploreCandidatePublisherDependencies {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    credentialHelperPath:
      "/usr/local/libexec/voice-agent/git-credential-github-app.sh",
    createIsolatedPushRepository: isolatedPushRepository,
    async github() {
      options.githubCalled?.();
      throw new Error("GitHub must not be called by a rejected publication");
    },
    now: () => new Date(now),
    async readAppCredentials() {
      return {
        appId: 123,
        installationId: 456,
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      };
    },
    async readPolicyJournal() {
      return options.journal ?? policyJournal();
    },
    async readRegisteredDelegation() {
      return "delegation" in options
        ? options.delegation
        : registeredDelegation();
    },
    async runGit(args) {
      return observedGit(args, headCommit);
    },
  };
}

async function isolatedPushRepository() {
  return {
    directory: "/run/voice-agent-keeplore-publisher/git-fixture",
    async dispose() {},
  };
}

function observedGit(args: readonly string[], observedHead: string) {
  const command = args.join(" ");
  if (command.includes("branch --show-current")) {
    return { exitCode: 0, stderr: "", stdout: `${branch}\n` };
  }
  if (command.includes("status --porcelain")) {
    return { exitCode: 0, stderr: "", stdout: "" };
  }
  if (command.includes("rev-parse HEAD")) {
    return { exitCode: 0, stderr: "", stdout: `${observedHead}\n` };
  }
  if (command.includes("remote get-url")) {
    return {
      exitCode: 0,
      stderr: "",
      stdout: "https://github.com/JacobStephens2/keeplore.git\n",
    };
  }
  if (command.includes("merge-base --is-ancestor")) {
    return { exitCode: 0, stderr: "", stdout: "" };
  }
  if (command.includes("rev-list --count")) {
    return { exitCode: 0, stderr: "", stdout: "1\n" };
  }
  if (command.includes(" diff ") && command.includes("--name-only -z")) {
    return { exitCode: 0, stderr: "", stdout: "ui/style.css\0" };
  }
  throw new Error(`Unexpected Git inspection: ${command}`);
}
