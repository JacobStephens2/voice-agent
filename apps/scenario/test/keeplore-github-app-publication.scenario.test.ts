import { generateKeyPairSync } from "node:crypto";
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
    readonly args: readonly string[];
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
      `${headCommit}:refs/heads/${branch}`,
    ]),
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
    { delegation: registeredDelegation({ repository: "somebody/else" }) },
    { delegation: registeredDelegation({ branch: "main" }) },
    { requestedHead: "3333333333333333333333333333333333333333" },
    { journal: policyJournal({ observedAt: "2026-08-01T13:00:00.000Z" }) },
    { journal: policyJournal({ appId: 999 }) },
    { journal: policyJournal({ installationId: 999 }) },
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
    readonly installationId?: number;
    readonly observedAt?: string;
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
      requiredChecks: ["keeplore-verification"],
    },
    {
      application: "keeplore-production",
      attestedAt: observedAt,
      attestedBy: "owner",
      branch: "main",
      bypassActors: [],
      kind: "branch-bypass",
      observedAt,
      repository: "JacobStephens2/keeplore",
      rulesetsRead: 1,
    },
    {
      appId: overrides.appId ?? 123,
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

function observedPullRequest(): unknown {
  return {
    base: {
      ref: "main",
      repo: { full_name: "JacobStephens2/keeplore" },
    },
    head: {
      ref: branch,
      repo: { full_name: "JacobStephens2/keeplore" },
      sha: headCommit,
    },
    html_url: "https://github.com/JacobStephens2/keeplore/pull/101",
    number: 101,
    state: "open",
    user: { login: "keeplore-publisher[bot]", type: "Bot" },
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
      return options.delegation ?? registeredDelegation();
    },
    async runGit(args) {
      return observedGit(args, headCommit);
    },
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
