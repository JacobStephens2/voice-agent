import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createSqliteKeeploreOnboardingStore } from "@voice-agent/sqlite-store";
import {
  assessKeeploreRepositoryPolicy,
  createKeeploreOnboardingControls,
  keeploreObservationLifetimeMs,
  readKeeploreRepositoryPolicyObservations,
} from "@voice-agent/runtime";
import type { KeeploreLiveInspection } from "@voice-agent/contracts";

const temporaryDirectories: string[] = [];
const collectedAt = "2026-08-20T10:00:00Z";
const now = () => Date.parse("2026-08-20T12:00:00Z");

const branchRules = (activeRules: readonly string[], observedAt = collectedAt) =>
  JSON.stringify({
    activeRules,
    // Historical journal spelling remains readable at the persistence seam.
    application: "keeplore-production",
    branch: "main",
    kind: "branch-rules",
    observedAt,
    observedBy: "github-app-installation",
    repository: "JacobStephens2/keeplore",
    requiredChecks: ["keeplore-verification"],
  });

const bypassAttestation = (bypassActors: readonly string[]) =>
  JSON.stringify({
    registeredCodebaseId: "keeplore-production",
    attestedAt: collectedAt,
    attestedBy: "owner",
    branch: "main",
    bypassActors,
    kind: "branch-bypass",
    observedAt: collectedAt,
    repository: "JacobStephens2/keeplore",
    rulesetsRead: 1,
  });

const gitHubApp = (
  overrides: Record<string, unknown> = {},
) =>
  JSON.stringify({
    appId: 123,
    appSlug: "keeplore-publisher",
    registeredCodebaseId: "keeplore-production",
    installationId: 456,
    kind: "github-app",
    observedAt: collectedAt,
    observedBy: "github-app-credentials",
    // GitHub grants every App `metadata: read` and will not let it be dropped.
    permissions: {
      checks: "read",
      contents: "write",
      metadata: "read",
      pull_requests: "write",
    },
    repositories: ["JacobStephens2/keeplore"],
    repositorySelection: "selected",
    ...overrides,
  });

/** What the host appends, alongside lines a reader must discard. */
const collectedJournal = [
  branchRules(["pull_request", "required_status_checks", "non_fast_forward", "deletion"]),
  bypassAttestation([]),
  gitHubApp(),
  "{ truncated line the collector is still appending",
  JSON.stringify({
    kind: "github-app",
    registeredCodebaseId: "other-application",
  }),
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a truncated or foreign observation never becomes an assessment", () => {
  expect(
    readKeeploreRepositoryPolicyObservations(collectedJournal).map(
      (observation) => observation.kind,
    ),
  ).toEqual(["branch-rules", "branch-bypass", "github-app"]);
});

test("the host's observations become both policy assessments", async () => {
  const { controls, store } = await enrolled();

  const assessed = await assess(controls, collectedJournal);

  expect(assessed).toEqual({
    branchProtection: { satisfied: true, violations: [] },
    githubApp: { satisfied: true, violations: [] },
  });
  expect(await store.findAssessment("branch-protection")).toEqual({
    satisfied: true,
    violations: [],
  });
  expect(await store.findAssessment("github-app")).toEqual({
    satisfied: true,
    violations: [],
  });
});

/**
 * The Voice Agent's GitHub App cannot read a ruleset's bypass actors — GitHub
 * discloses them only to an actor that may write the ruleset, which the App
 * must never be. An unattested branch must not pass as a clean one.
 */
test("branch rules alone cannot clear the bypass actors nobody read", async () => {
  const { controls } = await enrolled();

  const assessed = await assess(
    controls,
    [
      branchRules([
        "pull_request",
        "required_status_checks",
        "non_fast_forward",
        "deletion",
      ]),
      gitHubApp(),
    ].join("\n"),
  );

  expect(assessed.branchProtection).toEqual({
    satisfied: false,
    violations: [
      "Production-branch bypass actors are beyond the Voice Agent's authority and unattested",
    ],
  });
});

test("the owner's attestation names each bypass actor as a violation", async () => {
  const { controls } = await enrolled();

  const assessed = await assess(
    controls,
    [
      branchRules([
        "pull_request",
        "required_status_checks",
        "non_fast_forward",
        "deletion",
      ]),
      bypassAttestation(["Integration:voice-agent-app"]),
    ].join("\n"),
  );

  expect(assessed.branchProtection.violations).toEqual([
    "Production branch rules grant Integration:voice-agent-app bypass authority",
  ]);
});

test("missing rules are reported as the operations they allow", async () => {
  const { controls } = await enrolled();

  const assessed = await assess(
    controls,
    [branchRules(["pull_request"]), bypassAttestation([])].join("\n"),
  );

  expect(assessed.branchProtection.violations).toEqual([
    "Production branch allows force pushes",
    "Production branch allows deletion",
    "Production branch does not require the keeplore-verification check",
  ]);
});

test("an over-permissioned App is assessed permission by permission", async () => {
  const { controls } = await enrolled();

  const assessed = await assess(
    controls,
    gitHubApp({
      permissions: {
        administration: "write",
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      repositories: ["JacobStephens2/keeplore", "JacobStephens2/chart35"],
      repositorySelection: "all",
    }),
  );

  expect(assessed.githubApp.violations).toEqual([
    "GitHub App holds the unrequired administration permission",
    "GitHub App is installed on every repository, not only JacobStephens2/keeplore",
  ]);
});

test("an installation reporting no repository is a finding, not a blank", async () => {
  const { controls } = await enrolled();

  const assessed = await assess(controls, gitHubApp({ repositories: [] }));

  expect(assessed.githubApp.violations).toEqual([
    "GitHub App reports no installed repository",
  ]);
});

test("an unobserved policy stays unassessed rather than assumed satisfied", async () => {
  const { controls, store } = await enrolled();

  const assessed = await assess(controls, "");

  expect(assessed.branchProtection.satisfied).toBe(false);
  expect(assessed.githubApp.satisfied).toBe(false);
  expect(await store.findAssessment("branch-protection")).toBeUndefined();
});

test("an observation older than its lifetime no longer describes the branch", async () => {
  const { controls } = await enrolled();
  const stale = new Date(
    now() - keeploreObservationLifetimeMs - 1000,
  ).toISOString();

  const assessed = await assess(
    controls,
    [
      branchRules(
        ["pull_request", "required_status_checks", "non_fast_forward", "deletion"],
        stale,
      ),
      gitHubApp({ observedAt: stale }),
    ].join("\n"),
  );

  expect(assessed.branchProtection.satisfied).toBe(false);
  expect(assessed.branchProtection.violations).toEqual([
    "Keeplore repository policy has not been observed recently",
  ]);
});

test("the newest observation of each kind is the one assessed", async () => {
  const { controls } = await enrolled();
  const earlier = branchRules([], "2026-08-20T09:00:00Z");

  const assessed = await assess(
    controls,
    `${earlier}\n${collectedJournal}`,
  );

  expect(assessed.branchProtection).toEqual({ satisfied: true, violations: [] });
});

async function assess(
  controls: Awaited<ReturnType<typeof enrolled>>["controls"],
  journal: string,
) {
  return assessKeeploreRepositoryPolicy({
    controls,
    journal: { async read() { return journal; } },
    now,
  });
}

async function enrolled() {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-policy-"));
  temporaryDirectories.push(directory);
  const store = createSqliteKeeploreOnboardingStore(
    join(directory, "voice-agent.sqlite"),
  );
  const controls = createKeeploreOnboardingControls({
    inspector: { async inspect() { return inspection(); } },
    now: () => "2026-08-20T09:30:00.000Z",
    store,
  });
  await controls.enrollKeeplore({
    reconciliation: {
      outcome: "already-clean",
      reconciledAt: "2026-08-20T09:00:00.000Z",
      reconciledBy: "owner",
      remainingUncommittedPaths: [],
    },
    source: "fresh-passkey-action",
  });
  return { controls, store };
}

function inspection(): KeeploreLiveInspection {
  return {
    accessMode: "read-only",
    documentRoots: {
      api: "/var/www/keeplore.app/api",
      ui: "/var/www/keeplore.app/ui",
    },
    headCommit: "2775a1d0000000000000000000000000000000ab",
    inspectedAt: "2026-08-20T09:29:00.000Z",
    liveCheckoutPath: "/var/www/keeplore.app",
    productionBranch: "main",
    remoteRepository: "JacobStephens2/keeplore",
    repository: "JacobStephens2/keeplore",
    servingEdge: "apache",
    sharedPaths: [
      "private/environment_variables.php",
      "private/vendor",
      "database/backups",
      "logs",
    ],
    uncommittedPaths: [],
    verificationCommands: ["vendor/bin/phpunit"],
  };
}
