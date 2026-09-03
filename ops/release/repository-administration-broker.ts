import { lstat, readFile, unlink } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * The Repository Administration Broker.
 *
 * This file is installed as a standalone pinned authority beside the
 * Administrative Publisher App's publication service. It holds the owner
 * credential that may create a repository and write its rules — authority the
 * Administrative Publisher App deliberately does not have — and it exposes
 * exactly three registered operations over that credential. Everything else a caller might ask for,
 * including reading or writing repository contents, weakening a rule,
 * approving, merging, closing, or deleting anything, bypassing a check,
 * deploying, or reading the credential itself, has no endpoint here at all.
 *
 * Nothing about *which* repository is administered comes from the caller. The
 * owner, repository name, visibility, and rule target are re-derived from the
 * confirmed Durable Task's own registration snapshot in the authoritative
 * store, so a model that can reach this socket still cannot choose a target.
 */

const administrativeOwner = "JacobStephens2" as const;
const repositoryVisibility = "private" as const;
const productionRulesetName = "voice-agent-production-branch" as const;
const productionRulesetTarget = "branch" as const;
/**
 * The standard production-branch rules. Every path that could move production
 * without a reviewed pull request is closed: `pull_request` requires one,
 * `non_fast_forward` rejects force-push, and `deletion` rejects removing the
 * branch. The set is written here rather than accepted from a request, so the
 * broker has no way to install a weaker rule than the one it can observe.
 */
const requiredProductionRuleTypes = [
  "deletion",
  "non_fast_forward",
  "pull_request",
] as const;
const maximumResponseBytes = 1_000_000;
const maximumRefusalReasonLength = 300;
const maximumRequestBytes = 64 * 1_024;
const apiVersion = "2026-03-10";
const brokerRuntimeDirectory = "/run/voice-agent-repository-administration";
const administrativeIdentityPatterns = {
  operation: /^(?:[A-Za-z0-9._:-]+-)?administrative-operation-[A-Za-z0-9._:-]+$/u,
  task: /^(?:[A-Za-z0-9._:-]+-)?administrative-task-[A-Za-z0-9._:-]+$/u,
} as const;
const ownerRepositoryPattern = new RegExp(
  `^${administrativeOwner}/[A-Za-z0-9_.-]{1,100}$`,
  "u",
);

/**
 * The operations this broker has. A request naming anything else is refused
 * before any credential is read.
 */
export const repositoryAdministrationOperations = [
  "create-private-repository",
  "protect-production-branch",
  "observe-administrative-publisher-app",
] as const;
export type RepositoryAdministrationOperation =
  (typeof repositoryAdministrationOperations)[number];

export interface RepositoryAdministrationRequest {
  readonly operation: RepositoryAdministrationOperation;
  readonly operationId: string;
  readonly taskId: string;
}

export interface RepositoryAdministrationDiscoveryEligibility {
  /**
   * The repository this broker just created is eligible for policy-authorized
   * discovery under the revision that was already active. Creating it spends
   * no authority the owner has not already activated, so it demands no further
   * Fresh Passkey Action.
   */
  readonly eligibility: "policy-authorized";
  readonly freshPasskeyActionRequired: false;
  readonly policyRevision: number;
  readonly registeredCodebaseId: string;
}

export interface RepositoryAdministrationRepository {
  readonly fullName: string;
  readonly name: string;
  readonly owner: typeof administrativeOwner;
  readonly visibility: typeof repositoryVisibility;
}

/**
 * What the broker itself read back after writing, never what it asked for.
 * An establishment that cannot be independently observed is a refusal.
 */
export interface ProductionBranchRulesObservation {
  readonly branch: string;
  readonly bypassActors: 0;
  readonly observedBy: "repository-administration-broker";
  readonly rejectsBranchDeletion: true;
  readonly rejectsForcePush: true;
  readonly requiresPullRequest: true;
}

export type AdministrativePublisherAppObservation =
  | {
      readonly appSlug: string;
      readonly installationId: number;
      readonly installed: true;
      readonly repositorySelection: "all" | "selected";
    }
  | { readonly installed: false };

export type RepositoryAdministrationResult =
  | {
      readonly discovery: RepositoryAdministrationDiscoveryEligibility;
      readonly operation: "create-private-repository";
      readonly outcome: "already-present" | "created";
      readonly repository: RepositoryAdministrationRepository;
    }
  | {
      readonly observed: ProductionBranchRulesObservation;
      readonly operation: "protect-production-branch";
      readonly outcome: "already-installed" | "installed";
      readonly repository: RepositoryAdministrationRepository;
    }
  | {
      readonly installation: AdministrativePublisherAppObservation;
      readonly operation: "observe-administrative-publisher-app";
      readonly repository: RepositoryAdministrationRepository;
    };

interface GitHubRequest {
  readonly auth: string;
  readonly body?: unknown;
  readonly method: "GET" | "POST";
  readonly path: string;
}

interface GitHubResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface AdministrativePublisherAppIdentity {
  readonly appId: number;
  readonly appSlug: string;
}

export interface RepositoryAdministrationBrokerDependencies {
  github(request: GitHubRequest): Promise<GitHubResponse>;
  readonly now: () => Date;
  readAdministrativePolicyState(): Promise<unknown>;
  readAdministrativePublisherApp(): Promise<AdministrativePublisherAppIdentity>;
  readAdministrativeTask(taskId: string): Promise<unknown>;
  /**
   * The owner credential, resolved from the Credential Custody Boundary for
   * one administration and never placed in a result, a journal line, or a
   * response. No registered operation returns it.
   */
  readOwnerCredential(): Promise<string>;
}

/**
 * The one word about a refusal the caller may know.
 *
 * The reasons this broker derives describe the owner's account, the durable
 * Task's registration, and the repository's rules — none of which the caller
 * that asked to administer is entitled to learn. The phase that refused says
 * whether the request, the Task behind it, the policy around it, or the
 * administration itself was at fault, and nothing more.
 *
 * - `request` — the request was not one of the registered operations.
 * - `task` — the named Durable Task was not a confirmed, running task whose
 *   registration names an administrable repository.
 * - `policy` — Administrative Autonomy did not authorize this Task's work.
 * - `administration` — a check on creation, the rules, or the observation
 *   refused.
 * - `unattributed` — the broker failed without reaching a check, so a fault
 *   here is a defect in this service rather than a refusal.
 */
export type RepositoryAdministrationRefusalCode =
  | "administration"
  | "policy"
  | "request"
  | "task"
  | "unattributed";

class AdministrationRefusal extends Error {
  readonly code: RepositoryAdministrationRefusalCode;

  constructor(code: RepositoryAdministrationRefusalCode, reason: string) {
    super(reason);
    this.code = code;
  }
}

/** One line of the broker's own account of itself. */
export interface RepositoryAdministrationJournalEntry {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

async function refusing<Result>(
  code: RepositoryAdministrationRefusalCode,
  phase: () => Promise<Result>,
): Promise<Result> {
  try {
    return await phase();
  } catch (error) {
    if (error instanceof AdministrationRefusal) throw error;
    throw new AdministrationRefusal(code, describeRefusal(error));
  }
}

/**
 * One authorized administration: the credential it may use and the target the
 * durable Task fixed for it. Nothing here came from the request.
 */
interface AdministrationSession {
  readonly branch: string;
  readonly credential: string;
  readonly dependencies: RepositoryAdministrationBrokerDependencies;
  readonly policyRevision: number;
  readonly registeredCodebaseId: string;
  readonly repository: RepositoryAdministrationRepository;
}

interface AdministrableRepository {
  readonly branch: string;
  readonly policyRevision: number;
  readonly registeredCodebaseId: string;
  readonly repository: RepositoryAdministrationRepository;
}

export function createRepositoryAdministrationBroker(
  dependencies: RepositoryAdministrationBrokerDependencies,
): {
  administer(request: unknown): Promise<RepositoryAdministrationResult>;
} {
  return {
    async administer(untrustedRequest) {
      const request = await refusing("request", async () =>
        parseAdministrationRequest(untrustedRequest),
      );
      const task = await refusing("task", async () =>
        parseConfirmedTask(
          await dependencies.readAdministrativeTask(request.taskId),
          dependencies.now(),
        ),
      );
      const target = await refusing("policy", async () =>
        authorizeAdministration(
          task,
          await dependencies.readAdministrativePolicyState(),
        ),
      );
      const credential = await refusing("policy", async () =>
        dependencies.readOwnerCredential(),
      );
      const session: AdministrationSession = {
        ...target,
        credential,
        dependencies,
      };
      return refusing("administration", async () => {
        if (request.operation === "create-private-repository") {
          return createPrivateRepository(session);
        }
        if (request.operation === "protect-production-branch") {
          return protectProductionBranch(session);
        }
        return observeAdministrativePublisherApp(session);
      });
    },
  };
}

/**
 * Create the owner's private repository, or observe the one already there.
 *
 * The repository is observed before it is created and again after, so a replay
 * of the same Operation — or a resumption after the broker died between
 * GitHub's write and its own answer — converges on the same result without a
 * second creation. Idempotence lives in that observation rather than in a
 * broker-side ledger, which a crash before its own commit would lose.
 */
async function createPrivateRepository(
  session: AdministrationSession,
): Promise<RepositoryAdministrationResult> {
  const { credential, dependencies, repository } = session;
  const existing = await dependencies.github({
    auth: credential,
    method: "GET",
    path: `/repos/${repository.fullName}`,
  });
  let outcome: "already-present" | "created";
  if (existing.status === 200) {
    assertAdministrableRepository(existing.body, repository);
    outcome = "already-present";
  } else if (existing.status === 404) {
    const created = await dependencies.github({
      auth: credential,
      body: { auto_init: true, name: repository.name, private: true },
      method: "POST",
      path: "/user/repos",
    });
    if (created.status !== 201) {
      throw new Error("The private repository could not be created");
    }
    const observed = await dependencies.github({
      auth: credential,
      method: "GET",
      path: `/repos/${repository.fullName}`,
    });
    if (observed.status !== 200) {
      throw new Error("The created repository could not be observed");
    }
    assertAdministrableRepository(observed.body, repository);
    outcome = "created";
  } else {
    throw new Error("The owner's repository could not be observed");
  }
  return {
    discovery: {
      eligibility: "policy-authorized",
      freshPasskeyActionRequired: false,
      policyRevision: session.policyRevision,
      registeredCodebaseId: session.registeredCodebaseId,
    },
    operation: "create-private-repository",
    outcome,
    repository,
  };
}

/**
 * Establish the standard production-branch rules and read them back.
 *
 * A ruleset already carrying this broker's name is never rewritten. Replacing
 * one would be the single move that could turn establishing rules into
 * weakening them, and the owner may have made the existing rules stricter than
 * the standard. An existing ruleset that does not satisfy the standard is a
 * refusal for the owner to resolve, not something to overwrite.
 */
async function protectProductionBranch(
  session: AdministrationSession,
): Promise<RepositoryAdministrationResult> {
  const { branch, credential, dependencies, repository } = session;
  const listed = await dependencies.github({
    auth: credential,
    method: "GET",
    path: `/repos/${repository.fullName}/rulesets`,
  });
  if (listed.status !== 200 || !Array.isArray(listed.body)) {
    throw new Error("The repository's rules could not be observed");
  }
  const present = listed.body
    .filter(isRecord)
    .find((ruleset) => ruleset.name === productionRulesetName);
  let rulesetId: number;
  let outcome: "already-installed" | "installed";
  if (present === undefined) {
    const created = await dependencies.github({
      auth: credential,
      body: standardProductionRuleset(branch),
      method: "POST",
      path: `/repos/${repository.fullName}/rulesets`,
    });
    if (created.status !== 201) {
      throw new Error("The standard production-branch rules could not be established");
    }
    rulesetId = requireRulesetId(created.body);
    outcome = "installed";
  } else {
    rulesetId = requireRulesetId(present);
    outcome = "already-installed";
  }
  // Independent of the write above: what the repository reports now, read
  // through its own identity rather than the response to the request.
  const observed = await dependencies.github({
    auth: credential,
    method: "GET",
    path: `/repos/${repository.fullName}/rulesets/${rulesetId}`,
  });
  if (observed.status !== 200) {
    throw new Error("The established production-branch rules could not be observed");
  }
  assertStandardProductionRuleset(observed.body, branch);
  return {
    observed: {
      branch,
      bypassActors: 0,
      observedBy: "repository-administration-broker",
      rejectsBranchDeletion: true,
      rejectsForcePush: true,
      requiresPullRequest: true,
    },
    operation: "protect-production-branch",
    outcome,
    repository,
  };
}

/**
 * Observe whether the Administrative Publisher App reaches this repository.
 *
 * The broker only looks. It cannot install the App, and it reports the App's
 * reach rather than granting it, so a repository the App has not been given
 * is an observation the caller must act on rather than a gap this credential
 * quietly closes.
 */
async function observeAdministrativePublisherApp(
  session: AdministrationSession,
): Promise<RepositoryAdministrationResult> {
  const { credential, dependencies, repository } = session;
  const publisherApp = await dependencies.readAdministrativePublisherApp();
  const listed = await dependencies.github({
    auth: credential,
    method: "GET",
    path: "/user/installations",
  });
  const installations =
    listed.status === 200 && isRecord(listed.body)
      ? listed.body.installations
      : undefined;
  if (!Array.isArray(installations)) {
    throw new Error("The owner's App installations could not be observed");
  }
  const installation = installations
    .filter(isRecord)
    .find((candidate) => candidate.app_id === publisherApp.appId);
  if (installation === undefined) {
    return {
      installation: { installed: false },
      operation: "observe-administrative-publisher-app",
      repository,
    };
  }
  if (installation.app_slug !== publisherApp.appSlug) {
    throw new Error("The installed App is not the Administrative Publisher App");
  }
  const installationId = installation.id;
  if (
    typeof installationId !== "number" ||
    !Number.isInteger(installationId) ||
    installationId < 1
  ) {
    throw new Error("The Administrative Publisher App installation has no identity");
  }
  if (installation.repository_selection === "all") {
    return {
      installation: {
        appSlug: publisherApp.appSlug,
        installationId,
        installed: true,
        repositorySelection: "all",
      },
      operation: "observe-administrative-publisher-app",
      repository,
    };
  }
  if (installation.repository_selection !== "selected") {
    throw new Error("The Administrative Publisher App installation is not registered");
  }
  const covered = await dependencies.github({
    auth: credential,
    method: "GET",
    path: `/user/installations/${installationId}/repositories`,
  });
  const repositories =
    covered.status === 200 && isRecord(covered.body)
      ? covered.body.repositories
      : undefined;
  if (!Array.isArray(repositories)) {
    throw new Error("The App installation's repositories could not be observed");
  }
  const reaches = repositories
    .filter(isRecord)
    .some((entry) => entry.full_name === repository.fullName);
  return {
    installation: reaches
      ? {
          appSlug: publisherApp.appSlug,
          installationId,
          installed: true,
          repositorySelection: "selected",
        }
      : { installed: false },
    operation: "observe-administrative-publisher-app",
    repository,
  };
}

function standardProductionRuleset(branch: string): unknown {
  return {
    bypass_actors: [],
    conditions: {
      ref_name: { exclude: [], include: [`refs/heads/${branch}`] },
    },
    enforcement: "active",
    name: productionRulesetName,
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        // A Human Merge on a single-owner repository is the owner merging their
        // own pull request, and GitHub will not let an author approve their own.
        // Requiring an approval here would therefore forbid the one merge this
        // ruleset exists to preserve, so the rule requires the pull request and
        // leaves the review count to the owner.
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
        type: "pull_request",
      },
    ],
    target: productionRulesetTarget,
  };
}

function assertStandardProductionRuleset(
  input: unknown,
  branch: string,
): void {
  const ruleset = requireRecord(input, "Observed production ruleset");
  const conditions = requireRecord(ruleset.conditions, "Ruleset conditions");
  const refName = requireRecord(conditions.ref_name, "Ruleset ref condition");
  if (
    ruleset.name !== productionRulesetName ||
    ruleset.target !== productionRulesetTarget ||
    ruleset.enforcement !== "active" ||
    !hasExactStringMembers(refName.include, [`refs/heads/${branch}`]) ||
    !hasExactStringMembers(refName.exclude, [])
  ) {
    throw new Error("The observed rules do not target the production branch");
  }
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0) {
    throw new Error("The observed production rules can be bypassed");
  }
  const observedTypes = Array.isArray(ruleset.rules)
    ? ruleset.rules
        .filter(isRecord)
        .map((rule) => rule.type)
        .filter((type): type is string => typeof type === "string")
    : [];
  for (const required of requiredProductionRuleTypes) {
    if (!observedTypes.includes(required)) {
      throw new Error("The observed production rules are not the standard rules");
    }
  }
}

function requireRulesetId(input: unknown): number {
  const ruleset = requireRecord(input, "Production ruleset");
  const id = ruleset.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("The production ruleset has no identity");
  }
  return id;
}

function assertAdministrableRepository(
  input: unknown,
  repository: RepositoryAdministrationRepository,
): void {
  const observed = requireRecord(input, "Observed repository");
  const owner = requireRecord(observed.owner, "Observed repository owner");
  if (
    observed.name !== repository.name ||
    observed.full_name !== repository.fullName ||
    owner.login !== repository.owner ||
    observed.private !== true
  ) {
    throw new Error("The observed repository is not the owner's private repository");
  }
}

function parseAdministrationRequest(
  input: unknown,
): RepositoryAdministrationRequest {
  const request = requireRecord(input, "Repository administration request");
  requireExactKeys(request, ["operation", "operationId", "taskId"]);
  const operation = request.operation;
  if (
    typeof operation !== "string" ||
    !(repositoryAdministrationOperations as readonly string[]).includes(
      operation,
    )
  ) {
    throw new Error("Repository administration operation is not registered");
  }
  const taskId = request.taskId;
  const operationId = request.operationId;
  if (typeof taskId !== "string" || !isAdministrativeIdentity(taskId, "task")) {
    throw new Error("Repository administration names an invalid Durable Task");
  }
  if (
    typeof operationId !== "string" ||
    !isAdministrativeIdentity(operationId, "operation")
  ) {
    throw new Error("Repository administration names an invalid Operation");
  }
  return {
    operation: operation as RepositoryAdministrationOperation,
    operationId,
    taskId,
  };
}

function isAdministrativeIdentity(
  candidate: string,
  kind: "operation" | "task",
): boolean {
  return (
    candidate.length <= 120 && administrativeIdentityPatterns[kind].test(candidate)
  );
}

interface ConfirmedAdministrativeTask {
  readonly branch: string;
  readonly policyRevision: number;
  readonly registeredCodebaseId: string;
  readonly repository: RepositoryAdministrationRepository;
  readonly stateVersion: number;
}

/**
 * Re-derive the administration target from the durable Task rather than the
 * request. A Task that is not confirmed and running, or whose Active Execution
 * Budget has elapsed, authorizes nothing.
 */
function parseConfirmedTask(
  input: unknown,
  now: Date,
): ConfirmedAdministrativeTask {
  const task = requireRecord(input, "Administrative Task");
  if (task.status !== "running") {
    throw new Error("The named Durable Task is not confirmed and running");
  }
  const deadline = task.activeExecutionDeadline;
  if (
    typeof deadline !== "string" ||
    Number.isNaN(Date.parse(deadline)) ||
    Date.parse(deadline) <= now.getTime()
  ) {
    throw new Error("The named Durable Task has no remaining active execution");
  }
  const policyRevision = requirePositiveInteger(
    task.policyRevision,
    "Durable Task policy revision",
  );
  const stateVersion = requirePositiveInteger(
    task.stateVersion,
    "Durable Task policy state version",
  );
  const target = requireRecord(task.target, "Durable Task target");
  if (target.environment !== "production") {
    throw new Error("The Durable Task target is not the production environment");
  }
  const codebase = requireRecord(
    target.registeredCodebase,
    "Registered Codebase",
  );
  const registeredCodebaseId = codebase.registeredCodebaseId;
  if (
    typeof registeredCodebaseId !== "string" ||
    !/^[a-z][a-z0-9-]{2,60}$/u.test(registeredCodebaseId) ||
    registeredCodebaseId !== target.registeredCodebaseId
  ) {
    throw new Error("The Registered Codebase snapshot does not match its identity");
  }
  const fullName = codebase.repository;
  const branch = codebase.productionBranch;
  if (typeof fullName !== "string" || !ownerRepositoryPattern.test(fullName)) {
    throw new Error("The Registered Codebase is not an owner repository");
  }
  if (
    typeof branch !== "string" ||
    !/^[A-Za-z0-9._/-]{1,120}$/u.test(branch) ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..")
  ) {
    throw new Error("The Registered Codebase has no production branch");
  }
  const name = fullName.slice(administrativeOwner.length + 1);
  return {
    branch,
    policyRevision,
    registeredCodebaseId,
    repository: {
      fullName,
      name,
      owner: administrativeOwner,
      visibility: repositoryVisibility,
    },
    stateVersion,
  };
}

/**
 * The active Administrative Autonomy Policy is the whole authorization. After
 * credential enrollment there is no further review gate: an active revision
 * that matches the Task's own authority snapshot is what lets this run.
 */
function authorizeAdministration(
  task: ConfirmedAdministrativeTask,
  input: unknown,
): AdministrableRepository {
  const policy = requireRecord(input, "Administrative Autonomy policy state");
  if (policy.status !== "active") {
    throw new Error("Administrative Autonomy is not active");
  }
  if (
    policy.activeRevision !== task.policyRevision ||
    policy.stateVersion !== task.stateVersion
  ) {
    throw new Error("The Durable Task does not carry the active policy revision");
  }
  return {
    branch: task.branch,
    policyRevision: task.policyRevision,
    registeredCodebaseId: task.registeredCodebaseId,
    repository: task.repository,
  };
}

/** Read the confirmed Task and the policy state at the installed SQLite seam. */
export function createRepositoryAdministrationStateReader(
  databasePath: string,
): {
  readAdministrativePolicyState(): Promise<unknown>;
  readAdministrativeTask(taskId: string): Promise<unknown>;
} {
  const query = <Row>(read: (database: DatabaseSync) => Row): Row => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return read(database);
    } finally {
      database.close();
    }
  };
  return {
    async readAdministrativePolicyState() {
      const row = query(
        (database) =>
          database
            .prepare(`
              SELECT status, active_revision, state_version
              FROM administrative_policy_state WHERE singleton = 1
            `)
            .get() as
            | {
                readonly active_revision: number | null;
                readonly state_version: number;
                readonly status: string;
              }
            | undefined,
      );
      if (row === undefined) return undefined;
      return {
        activeRevision: row.active_revision,
        stateVersion: row.state_version,
        status: row.status,
      };
    },
    async readAdministrativeTask(taskId) {
      const row = query(
        (database) =>
          database
            .prepare(`
              SELECT active_execution_deadline, execution_pause_json,
                policy_revision, state_version, status, target_json
              FROM administrative_tasks WHERE id = ?
            `)
            .get(taskId) as
            | {
                readonly active_execution_deadline: string | null;
                readonly execution_pause_json: string | null;
                readonly policy_revision: number;
                readonly state_version: number;
                readonly status: string;
                readonly target_json: string;
              }
            | undefined,
      );
      if (row === undefined) return undefined;
      return {
        activeExecutionDeadline: row.active_execution_deadline,
        policyRevision: row.policy_revision,
        stateVersion: row.state_version,
        status: row.execution_pause_json === null ? row.status : "paused",
        target: JSON.parse(row.target_json) as unknown,
      };
    },
  };
}

/**
 * Answer one request, keeping every refusal reason on this host.
 *
 * The reasons describe the owner's account and the durable Task behind the
 * request; the response carries the refusal code alone.
 */
export async function handleRepositoryAdministrationRequest(input: {
  readonly broker: {
    administer(request: unknown): Promise<RepositoryAdministrationResult>;
  };
  readonly journal?: (entry: RepositoryAdministrationJournalEntry) => void;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}): Promise<void> {
  const { broker, request, response } = input;
  const journal = input.journal ?? writeJournalLine;
  if (request.method === "GET" && request.url === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/administer") {
    sendJson(response, 404, { error: "not-found" });
    return;
  }
  let named: { readonly operationId?: string; readonly taskId?: string } = {};
  let administered: RepositoryAdministrationResult | undefined;
  try {
    const untrustedRequest = await refusing("request", () => readJson(request));
    named = safelyNamedOperation(untrustedRequest);
    // Sent outside the catch: a fault while answering is not a refusal, and
    // its 422 would be written to a response already sent.
    administered = await broker.administer(untrustedRequest);
  } catch (error) {
    const code =
      error instanceof AdministrationRefusal ? error.code : "unattributed";
    journal({
      level: 50,
      msg: "repository administration refused",
      ...named,
      reason: describeRefusal(error),
      refusal: code,
    });
    sendJson(response, 422, { error: "administration-refused", refusal: code });
    return;
  }
  journal({
    level: 30,
    msg: "repository administration completed",
    ...named,
    operation: administered.operation,
    ...("outcome" in administered ? { outcome: administered.outcome } : {}),
    repository: administered.repository.fullName,
  });
  sendJson(response, 200, administered);
}

/**
 * The Task and Operation the request named, when it named ones this journal
 * may repeat. Anything else names nothing.
 */
function safelyNamedOperation(untrustedRequest: unknown): {
  readonly operationId?: string;
  readonly taskId?: string;
} {
  if (!isRecord(untrustedRequest)) return {};
  const { operationId, taskId } = untrustedRequest;
  return {
    ...(typeof operationId === "string" &&
    isAdministrativeIdentity(operationId, "operation")
      ? { operationId }
      : {}),
    ...(typeof taskId === "string" && isAdministrativeIdentity(taskId, "task")
      ? { taskId }
      : {}),
  };
}

function describeRefusal(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()
      : "";
  if (message === "") {
    return "Repository administration was refused without a reason";
  }
  return message.length > maximumRefusalReasonLength
    ? `${message.slice(0, maximumRefusalReasonLength - 1)}…`
    : message;
}

function writeJournalLine(entry: RepositoryAdministrationJournalEntry): void {
  process.stderr.write(`${JSON.stringify({ time: Date.now(), ...entry })}\n`);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value;
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
    throw new Error("Repository administration request contains unregistered fields");
  }
}

function hasExactStringMembers(
  value: unknown,
  expected: readonly string[],
): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const observed = [...value].sort();
  const sortedExpected = [...expected].sort();
  return observed.every((member, index) => member === sortedExpected[index]);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const untrustedChunk of request) {
    const chunk = Buffer.from(untrustedChunk as Buffer);
    bytes += chunk.length;
    if (bytes > maximumRequestBytes) {
      throw new Error("Repository administration request exceeded its bound");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Repository administration request is not JSON");
  }
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
        "user-agent": "voice-agent-repository-administration",
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
    throw new Error("Repository administration credential source is not root-owned");
  }
}

async function startProductionServer(): Promise<void> {
  if (process.geteuid?.() !== 0) {
    throw new Error("The Repository Administration Broker must run as root");
  }
  const socketPath =
    process.env.VOICE_AGENT_REPOSITORY_ADMINISTRATION_SOCKET_PATH ??
    `${brokerRuntimeDirectory}/broker.sock`;
  const databasePath =
    process.env.VOICE_AGENT_DATABASE_PATH ??
    "/var/lib/voice-agent/voice-agent.sqlite";
  const ownerCredentialPath =
    process.env.VOICE_AGENT_REPOSITORY_ADMINISTRATION_CREDENTIAL ??
    "/etc/voice-agent/repository-administration-token";
  const publisherAppPath =
    process.env.VOICE_AGENT_ADMINISTRATIVE_PUBLISHER_APP_CONFIGURATION ??
    "/etc/voice-agent/administrative-publisher-app.conf";
  const state = createRepositoryAdministrationStateReader(databasePath);
  const broker = createRepositoryAdministrationBroker({
    github: productionGitHubRequest,
    now: () => new Date(),
    readAdministrativePolicyState: state.readAdministrativePolicyState,
    async readAdministrativePublisherApp() {
      await assertRootOwnedCredential(publisherAppPath, false);
      const configuration = await readFile(publisherAppPath, "utf8");
      const [appId, appSlug, ...extra] = configuration.trim().split("\t");
      if (
        extra.length !== 0 ||
        !/^[0-9]+$/u.test(appId ?? "") ||
        !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(appSlug ?? "")
      ) {
        throw new Error("The Administrative Publisher App configuration is invalid");
      }
      return { appId: Number(appId), appSlug: appSlug as string };
    },
    readAdministrativeTask: state.readAdministrativeTask,
    async readOwnerCredential() {
      await assertRootOwnedCredential(ownerCredentialPath, true);
      const credential = (await readFile(ownerCredentialPath, "utf8")).trim();
      if (!/^[A-Za-z0-9_]{20,255}$/u.test(credential)) {
        throw new Error("The owner credential is not in its registered shape");
      }
      return credential;
    },
  });

  await unlink(socketPath).catch((error: unknown) => {
    if (!isMissingFile(error)) throw error;
  });
  const server = createServer((request, response) => {
    void handleRepositoryAdministrationRequest({ broker, request, response });
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startProductionServer();
}
