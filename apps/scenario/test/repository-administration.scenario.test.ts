import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as requestHttp, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import {
  createRepositoryAdministrationBroker,
  createRepositoryAdministrationStateReader,
  handleRepositoryAdministrationRequest,
  type RepositoryAdministrationBrokerDependencies,
  type RepositoryAdministrationJournalEntry,
} from "../../../ops/release/repository-administration-broker.ts";

const now = "2026-09-02T10:00:00.000Z";
const activeExecutionDeadline = "2026-09-02T16:00:00.000Z";
const taskId = "administrative-task-host-configuration";
const operationId = "administrative-operation-create-configuration-repository";
const registeredCodebaseId = "agent-host-configuration";
const repositoryName = "voice-agent-host-config";
const fullName = `JacobStephens2/${repositoryName}`;
const productionBranch = "main";
const ownerCredential = "ghp_fixture_owner_credential_value";
const publisherApp = {
  appId: 789,
  appSlug: "voice-agent-administrative-publisher",
};
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("a confirmed Task creates the owner's private repository with no further gate", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));

  const result = await broker.administer(request("create-private-repository"));

  expect(result).toEqual({
    discovery: {
      eligibility: "policy-authorized",
      freshPasskeyActionRequired: false,
      policyRevision: 4,
    },
    operation: "create-private-repository",
    outcome: "created",
    repository: {
      fullName,
      name: repositoryName,
      owner: "JacobStephens2",
      visibility: "private",
    },
  });
  expect(github.invocations).toEqual([
    { method: "GET", path: `/repos/${fullName}` },
    { method: "POST", path: "/user/repos" },
    { method: "GET", path: `/repos/${fullName}` },
  ]);
  expect(github.created).toEqual({
    auto_init: true,
    name: repositoryName,
    private: true,
  });
});

test("a replayed creation observes the repository instead of creating a second one", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));

  const first = await broker.administer(request("create-private-repository"));
  github.invocations.length = 0;
  const replayed = await broker.administer(request("create-private-repository"));

  expect(first).toMatchObject({ outcome: "created" });
  expect(replayed).toEqual({ ...first, outcome: "already-present" });
  expect(github.invocations).toEqual([
    { method: "GET", path: `/repos/${fullName}` },
  ]);
});

test("the broker establishes the standard rules and reads them back independently", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));
  await broker.administer(request("create-private-repository"));
  github.invocations.length = 0;

  const result = await broker.administer(request("protect-production-branch"));

  expect(result).toEqual({
    observed: {
      branch: productionBranch,
      bypassActors: 0,
      observedBy: "repository-administration-broker",
      rejectsBranchDeletion: true,
      rejectsForcePush: true,
      requiresPullRequest: true,
    },
    operation: "protect-production-branch",
    outcome: "installed",
    repository: {
      fullName,
      name: repositoryName,
      owner: "JacobStephens2",
      visibility: "private",
    },
  });
  expect(github.invocations).toEqual([
    { method: "GET", path: `/repos/${fullName}/rulesets` },
    { method: "POST", path: `/repos/${fullName}/rulesets` },
    { method: "GET", path: `/repos/${fullName}/rulesets/1` },
  ]);
  const installed = github.rulesets[0];
  expect(installed?.enforcement).toBe("active");
  expect(installed?.bypass_actors).toEqual([]);
  expect(
    (installed?.rules as ReadonlyArray<{ readonly type: string }>).map(
      (rule) => rule.type,
    ).sort(),
  ).toEqual(["deletion", "non_fast_forward", "pull_request"]);
});

test("a partial failure between creation and protection replays to the same rules", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));
  await broker.administer(request("create-private-repository"));
  await broker.administer(request("protect-production-branch"));
  github.invocations.length = 0;

  const replayed = await broker.administer(request("protect-production-branch"));

  expect(replayed).toMatchObject({ outcome: "already-installed" });
  expect(github.rulesets).toHaveLength(1);
  expect(github.invocations).toEqual([
    { method: "GET", path: `/repos/${fullName}/rulesets` },
    { method: "GET", path: `/repos/${fullName}/rulesets/1` },
  ]);
});

test("rules the broker cannot observe as standard are refused, never rewritten", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));
  await broker.administer(request("create-private-repository"));
  github.rulesets.push({
    bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    enforcement: "active",
    id: 1,
    name: "voice-agent-production-branch",
    rules: [{ type: "pull_request" }],
    target: "branch",
  });

  await expect(
    broker.administer(request("protect-production-branch")),
  ).rejects.toThrow();
  expect(github.rulesets).toHaveLength(1);
  expect(github.rulesets[0]?.rules).toEqual([{ type: "pull_request" }]);
});

test("a ruleset a bypass actor can step around is refused", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));
  await broker.administer(request("create-private-repository"));
  github.rulesets.push({
    bypass_actors: [{ actor_id: 5, actor_type: "Integration" }],
    conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    enforcement: "active",
    id: 1,
    name: "voice-agent-production-branch",
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request" },
    ],
    target: "branch",
  });

  await expect(
    broker.administer(request("protect-production-branch")),
  ).rejects.toThrow();
});

test("the broker observes the Administrative Publisher App installation", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));
  await broker.administer(request("create-private-repository"));

  const uninstalled = await broker.administer(
    request("observe-administrative-publisher-app"),
  );
  github.installations.push({
    app_id: publisherApp.appId,
    app_slug: publisherApp.appSlug,
    id: 4242,
    repositories: [{ full_name: fullName }],
    repository_selection: "selected",
  });
  const installed = await broker.administer(
    request("observe-administrative-publisher-app"),
  );

  expect(uninstalled).toMatchObject({ installation: { installed: false } });
  expect(installed).toMatchObject({
    installation: {
      appSlug: publisherApp.appSlug,
      installationId: 4242,
      installed: true,
      repositorySelection: "selected",
    },
  });
});

test("an installation that does not reach this repository is observed as absent", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));
  github.installations.push({
    app_id: publisherApp.appId,
    app_slug: publisherApp.appSlug,
    id: 4242,
    repositories: [{ full_name: "JacobStephens2/keeplore" }],
    repository_selection: "selected",
  });

  const observed = await broker.administer(
    request("observe-administrative-publisher-app"),
  );

  expect(observed).toMatchObject({ installation: { installed: false } });
});

test("only the three registered operations exist", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));

  for (const operation of [
    "read-repository-contents",
    "write-repository-contents",
    "relax-production-branch-rules",
    "approve-pull-request",
    "merge-pull-request",
    "close-pull-request",
    "delete-repository",
    "bypass-required-checks",
    "deploy-release",
    "return-owner-credential",
  ]) {
    await expect(
      broker.administer({ operation, operationId, taskId }),
    ).rejects.toThrow(/not registered/u);
  }
  expect(github.invocations).toEqual([]);
});

test("a request cannot name its own owner, repository, visibility, or rule target", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));

  await expect(
    broker.administer({
      branch: "release",
      operation: "create-private-repository",
      operationId,
      owner: "someone-else",
      repository: "someone-else/private-notes",
      taskId,
      visibility: "public",
    }),
  ).rejects.toThrow(/unregistered fields/u);
  expect(github.invocations).toEqual([]);
});

test("the target comes from the durable Task, not from a model-selected endpoint", async () => {
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(
    dependencies({
      github,
      task: {
        ...runningTask(),
        target: {
          environment: "production",
          registeredCodebase: {
            ...registeredCodebase(),
            repository: "someone-else/private-notes",
          },
          registeredCodebaseId,
        },
      },
    }),
  );

  await expect(
    broker.administer(request("create-private-repository")),
  ).rejects.toThrow(/owner repository/u);
  expect(github.invocations).toEqual([]);
});

test("an unconfirmed, paused, or exhausted Task administers nothing", async () => {
  const github = fakeGitHub();
  for (const task of [
    { ...runningTask(), status: "awaiting-confirmation" },
    { ...runningTask(), status: "planning" },
    { ...runningTask(), status: "paused" },
    { ...runningTask(), activeExecutionDeadline: "2026-09-02T09:00:00.000Z" },
    { ...runningTask(), activeExecutionDeadline: null },
  ]) {
    const broker = createRepositoryAdministrationBroker(
      dependencies({ github, task }),
    );
    await expect(
      broker.administer(request("create-private-repository")),
    ).rejects.toThrow();
  }
  expect(github.invocations).toEqual([]);
});

test("a suspended or superseded policy administers nothing", async () => {
  const github = fakeGitHub();
  for (const policy of [
    { activeRevision: 4, stateVersion: 9, status: "suspended" },
    { activeRevision: null, stateVersion: 9, status: "inactive" },
    { activeRevision: 5, stateVersion: 9, status: "active" },
    { activeRevision: 4, stateVersion: 10, status: "active" },
  ]) {
    const broker = createRepositoryAdministrationBroker(
      dependencies({ github, policy }),
    );
    await expect(
      broker.administer(request("create-private-repository")),
    ).rejects.toThrow();
  }
  expect(github.invocations).toEqual([]);
});

test("the owner credential never leaves the broker", async () => {
  const github = fakeGitHub();
  const journal: RepositoryAdministrationJournalEntry[] = [];
  const broker = createRepositoryAdministrationBroker(dependencies({ github }));
  const socketPath = await socket("repository-administration-ok-");
  const server = createServer((request, response) => {
    void handleRepositoryAdministrationRequest({
      broker,
      journal: (entry) => journal.push(entry),
      request,
      response,
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const created = await post(socketPath, request("create-private-repository"));
  const refused = await post(socketPath, {
    operation: "delete-repository",
    operationId,
    taskId,
  });

  expect(created.status).toBe(200);
  expect(JSON.stringify(created.body)).not.toContain(ownerCredential);
  expect(refused).toEqual({
    body: { error: "administration-refused", refusal: "request" },
    status: 422,
  });
  expect(JSON.stringify(journal)).not.toContain(ownerCredential);
  expect(journal).toEqual([
    {
      level: 30,
      msg: "repository administration completed",
      operation: "create-private-repository",
      operationId,
      repository: fullName,
      taskId,
    },
    {
      level: 50,
      msg: "repository administration refused",
      operationId,
      reason: "Repository administration operation is not registered",
      refusal: "request",
      taskId,
    },
  ]);
});

test("the installed reader reads the confirmed Task and policy from the durable store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repository-administration-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE administrative_policy_state (
      singleton INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      active_revision INTEGER,
      state_version INTEGER NOT NULL
    );
    CREATE TABLE administrative_tasks (
      id TEXT PRIMARY KEY,
      active_execution_deadline TEXT,
      execution_pause_json TEXT,
      policy_revision INTEGER NOT NULL,
      state_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      target_json TEXT NOT NULL
    );
    INSERT INTO administrative_policy_state VALUES (1, 'active', 4, 9);
  `);
  database
    .prepare(`
      INSERT INTO administrative_tasks (
        id, active_execution_deadline, execution_pause_json,
        policy_revision, state_version, status, target_json
      ) VALUES (?, ?, NULL, 4, 9, 'running', ?)
    `)
    .run(taskId, activeExecutionDeadline, JSON.stringify(target()));
  database.close();
  const state = createRepositoryAdministrationStateReader(databasePath);
  const github = fakeGitHub();
  const broker = createRepositoryAdministrationBroker(
    dependencies({
      github,
      policyReader: state.readAdministrativePolicyState,
      taskReader: state.readAdministrativeTask,
    }),
  );

  const created = await broker.administer(request("create-private-repository"));

  expect(created).toMatchObject({ outcome: "created" });
  await expect(
    broker.administer({
      operation: "create-private-repository",
      operationId,
      taskId: "administrative-task-never-accepted",
    }),
  ).rejects.toThrow();
});

function request(operation: string): unknown {
  return { operation, operationId, taskId };
}

function registeredCodebase(): Record<string, unknown> {
  return {
    initialProductionCommit: "1".repeat(40),
    liveCheckoutPath: "/srv/voice-agent-host-config",
    productionBranch,
    registeredAt: "2026-09-01T09:00:00.000Z",
    registeredCodebaseId,
    repository: fullName,
    sourceCheckoutRoot: "/srv/voice-agent-host-config",
  };
}

function target(): Record<string, unknown> {
  return {
    environment: "production",
    registeredCodebase: registeredCodebase(),
    registeredCodebaseId,
  };
}

function runningTask(): Record<string, unknown> {
  return {
    activeExecutionDeadline,
    policyRevision: 4,
    stateVersion: 9,
    status: "running",
    target: target(),
  };
}

function dependencies(options: {
  readonly github: FakeGitHub;
  readonly policy?: unknown;
  readonly policyReader?: () => Promise<unknown>;
  readonly task?: unknown;
  readonly taskReader?: (taskId: string) => Promise<unknown>;
}): RepositoryAdministrationBrokerDependencies {
  return {
    github: options.github.request,
    now: () => new Date(now),
    readAdministrativePolicyState:
      options.policyReader ??
      (async () =>
        options.policy ?? {
          activeRevision: 4,
          stateVersion: 9,
          status: "active",
        }),
    async readAdministrativePublisherApp() {
      return publisherApp;
    },
    readAdministrativeTask:
      options.taskReader ??
      (async (requestedTaskId) =>
        requestedTaskId === taskId ? (options.task ?? runningTask()) : undefined),
    async readOwnerCredential() {
      return ownerCredential;
    },
  };
}

interface FakeGitHub {
  created?: unknown;
  readonly installations: Array<Record<string, unknown>>;
  readonly invocations: Array<{
    readonly method: string;
    readonly path: string;
  }>;
  request: RepositoryAdministrationBrokerDependencies["github"];
  readonly rulesets: Array<Record<string, unknown>>;
}

/** The owner's account as GitHub would report it, and only through the token. */
function fakeGitHub(): FakeGitHub {
  const state: FakeGitHub = {
    installations: [],
    invocations: [],
    request: async () => ({ body: undefined, status: 500 }),
    rulesets: [],
  };
  let repositoryPresent = false;
  state.request = async (githubRequest) => {
    if (githubRequest.auth !== ownerCredential) {
      return { body: undefined, status: 401 };
    }
    state.invocations.push({
      method: githubRequest.method,
      path: githubRequest.path,
    });
    if (
      githubRequest.method === "GET" &&
      githubRequest.path === `/repos/${fullName}`
    ) {
      return repositoryPresent
        ? {
            body: {
              full_name: fullName,
              name: repositoryName,
              owner: { login: "JacobStephens2" },
              private: true,
            },
            status: 200,
          }
        : { body: { message: "Not Found" }, status: 404 };
    }
    if (
      githubRequest.method === "POST" &&
      githubRequest.path === "/user/repos"
    ) {
      state.created = githubRequest.body;
      repositoryPresent = true;
      return { body: { full_name: fullName }, status: 201 };
    }
    if (
      githubRequest.method === "GET" &&
      githubRequest.path === `/repos/${fullName}/rulesets`
    ) {
      return { body: state.rulesets, status: 200 };
    }
    if (
      githubRequest.method === "POST" &&
      githubRequest.path === `/repos/${fullName}/rulesets`
    ) {
      const ruleset = {
        ...(githubRequest.body as Record<string, unknown>),
        id: state.rulesets.length + 1,
      };
      state.rulesets.push(ruleset);
      return { body: ruleset, status: 201 };
    }
    const rulesetMatch = /^\/repos\/(?<name>.+)\/rulesets\/(?<id>[0-9]+)$/u.exec(
      githubRequest.path,
    );
    if (githubRequest.method === "GET" && rulesetMatch !== null) {
      const ruleset = state.rulesets.find(
        (candidate) => candidate.id === Number(rulesetMatch.groups?.id),
      );
      return ruleset === undefined
        ? { body: { message: "Not Found" }, status: 404 }
        : { body: ruleset, status: 200 };
    }
    if (
      githubRequest.method === "GET" &&
      githubRequest.path === "/user/installations"
    ) {
      return {
        body: { installations: state.installations },
        status: 200,
      };
    }
    const installationMatch =
      /^\/user\/installations\/(?<id>[0-9]+)\/repositories$/u.exec(
        githubRequest.path,
      );
    if (githubRequest.method === "GET" && installationMatch !== null) {
      const installation = state.installations.find(
        (candidate) => candidate.id === Number(installationMatch.groups?.id),
      );
      return {
        body: { repositories: installation?.repositories ?? [] },
        status: 200,
      };
    }
    return { body: { message: "Not Found" }, status: 404 };
  };
  return state;
}

async function socket(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "broker.sock");
}

async function post(
  socketPath: string,
  body: unknown,
): Promise<{ readonly body: unknown; readonly status: number }> {
  const serialized = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const clientRequest = requestHttp(
      {
        headers: {
          "content-length": Buffer.byteLength(serialized),
          "content-type": "application/json",
        },
        method: "POST",
        path: "/administer",
        socketPath,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: text.length === 0 ? undefined : JSON.parse(text),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end(serialized);
  });
}
