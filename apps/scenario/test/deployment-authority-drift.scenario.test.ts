import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

import {
  createHumanMergePromotionScenario,
  readDeploymentAuthorityDrift,
  readPinnedAuthorityPaths,
  signHumanMergeWebhook,
  type FixtureGitHubEvent,
} from "@voice-agent/scenario";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const driftHelper = join(
  repositoryRoot,
  "ops/release/deployment-authority-drift.sh",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * Build a Release tree and the pinned deployment authority it is compared
 * against. Both are ordinary directories owned by the test user, which is the
 * point: the comparison that decides what a Promotion reports must be
 * exercisable without root and without `/usr/local/libexec/voice-agent`.
 *
 * The pinned layout comes from `voice_agent_authority_pinned_paths`, the same
 * expansion the comparison and the attended upgrade read, so this fixture
 * cannot quietly agree with a reader that looks at the wrong path.
 */
async function buildAuthorityPair(): Promise<{
  readonly pinnedRoot: string;
  readonly releaseRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "voice-agent-authority-drift-"));
  temporaryDirectories.push(root);
  const releaseRoot = join(root, "release");
  const pinnedRoot = join(root, "pinned");
  // Content is keyed by the Release path, not the pinned path: the Human Merge
  // verifier is one reviewed file pinned in two places, and both pinned copies
  // carry the bytes of that single source.
  for (const { mode, pinnedPath, sourcePath } of await readPinnedAuthorityPaths()) {
    await writeFileAt(join(releaseRoot, sourcePath), `${sourcePath} reviewed\n`);
    await writeFileAt(join(pinnedRoot, pinnedPath), `${sourcePath} reviewed\n`);
    await chmod(join(pinnedRoot, pinnedPath), mode);
  }
  return { pinnedRoot, releaseRoot };
}

async function driftPaths(
  releaseRoot: string,
  pinnedRoot: string,
): Promise<readonly string[]> {
  return readDeploymentAuthorityDrift({ pinnedRoot, releaseRoot });
}

test("a Release matching the pinned deployment authority reports no drift", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([]);
});

test("changed content diverges, not only a missing pinned file", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();
  await writeFile(
    join(releaseRoot, "ops/release/promote-release.sh"),
    "promote-release.sh reviewed\n# a reviewed change nobody pinned\n",
  );
  await writeFile(
    join(pinnedRoot, "systemd/voice-agent-api.service"),
    "systemd/voice-agent-api.service reviewed\nStartLimitIntervalUSec=10s\n",
  );

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([
    "promote-release.sh",
    "systemd/voice-agent-api.service",
  ]);
});

test("a pinned program with the wrong publication mode diverges", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();
  await chmod(join(pinnedRoot, "grok-token-broker"), 0o644);
  await chmod(
    join(pinnedRoot, "deployment-authority-authorization-verifier.mjs"),
    0o755,
  );

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([
    "deployment-authority-authorization-verifier.mjs",
    "grok-token-broker",
  ]);
});

test("a pinned file the Release does not carry, and the reverse, both diverge", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();
  await rm(join(pinnedRoot, "resume-promotion.sh"));
  await rm(join(releaseRoot, "ops/systemd/voice-agent-broker.service"));

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([
    "resume-promotion.sh",
    "systemd/voice-agent-broker.service",
  ]);
});

test("the comparison covers the pinned verifier and the Keeplore tools that travel with it", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();
  await writeFile(
    join(pinnedRoot, "deployment-authority-authorization-verifier.mjs"),
    "deployment-authority-authorization-verifier.mjs stale\n",
  );
  await writeFile(
    join(pinnedRoot, "keeplore/promote-keeplore-release.sh"),
    "promote-keeplore-release.sh stale\n",
  );

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([
    "deployment-authority-authorization-verifier.mjs",
    "keeplore/promote-keeplore-release.sh",
  ]);
});

test("a Keeplore tool is compared where the upgrade installs it, not at the authority root", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();
  // The bare name at the authority root is a path the upgrade has never
  // written. Reading it there reported every Keeplore tool as diverged on a
  // host that was already carrying the reviewed bytes.
  await writeFile(
    join(pinnedRoot, "keeplore-config.sh"),
    "keeplore-config.sh at a path no upgrade writes\n",
  );

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([]);
});

test("a Keeplore tool that genuinely differs from the Release still diverges", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();
  await writeFile(
    join(pinnedRoot, "keeplore/keeplore-config.sh"),
    "keeplore-config.sh stale\n",
  );
  await rm(join(pinnedRoot, "keeplore/resolve-keeplore-worktree.sh"));

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([
    "keeplore/keeplore-config.sh",
    "keeplore/resolve-keeplore-worktree.sh",
  ]);
});

test("the Human Merge verifier diverges at whichever pinned copy is stale", async () => {
  const beside = await buildAuthorityPair();
  await writeFile(
    join(beside.pinnedRoot, "keeplore/verify-human-merge.sh"),
    "verify-human-merge.sh stale beside the Keeplore tools\n",
  );

  await expect(
    driftPaths(beside.releaseRoot, beside.pinnedRoot),
  ).resolves.toEqual(["keeplore/verify-human-merge.sh"]);

  const root = await buildAuthorityPair();
  await writeFile(
    join(root.pinnedRoot, "verify-human-merge.sh"),
    "verify-human-merge.sh stale at the authority root\n",
  );

  await expect(driftPaths(root.releaseRoot, root.pinnedRoot)).resolves.toEqual([
    "verify-human-merge.sh",
  ]);
});

test("a symbolic link standing in for pinned authority diverges from its reviewed file", async () => {
  const { pinnedRoot, releaseRoot } = await buildAuthorityPair();
  await rm(join(pinnedRoot, "deployment-health.sh"));
  await symlink("/dev/null", join(pinnedRoot, "deployment-health.sh"));

  await expect(driftPaths(releaseRoot, pinnedRoot)).resolves.toEqual([
    "deployment-health.sh",
  ]);
});

test("the drift record names the attended upgrade as the action that applies it", async () => {
  const { stdout: none } = await execFileAsync("bash", [
    "-c",
    'set -euo pipefail\nsource "$1"\nvoice_agent_authority_drift_json',
    "authority-drift-json-test",
    driftHelper,
  ]);
  expect(JSON.parse(none)).toEqual({ diverged: false, paths: [] });

  const { stdout: some } = await execFileAsync("bash", [
    "-c",
    'set -euo pipefail\nsource "$1"\nvoice_agent_authority_drift_json "$2" "$3"',
    "authority-drift-json-test",
    driftHelper,
    "promote-release.sh",
    'systemd/voice-agent-"api".service',
  ]);
  expect(JSON.parse(some)).toEqual({
    action: "./ops/upgrade-agent-host-deployment-authority.sh",
    diverged: true,
    paths: ["promote-release.sh", 'systemd/voice-agent-"api".service'],
  });
});

const promotionState = join(repositoryRoot, "ops/release/promotion-state.sh");
const succeededCommit = "4b9692d5c2f0a1e7d8b3c46f95a20e17c3d8b0aa";

/**
 * Render one Promotion Attempt's journal line and Prometheus projection through
 * the real recorder. `promotion_state_render_attempt` and
 * `promotion_state_render_metrics` write no files, so what an owner reads
 * without root is exercised here rather than described.
 */
async function renderAttempt(input: {
  readonly driftPaths: readonly string[];
  readonly result: "failed" | "succeeded";
}): Promise<{
  readonly attempt: Record<string, unknown>;
  readonly circuitState: string;
  readonly consecutiveFailures: number;
  readonly metrics: Record<string, number>;
}> {
  const { stdout } = await execFileAsync("bash", [
    "-c",
    `set -euo pipefail
source "$1"
source "$2"
consecutive_failures=0
circuit_state=closed
last_failed_commit=-
last_attempted_commit=-
result=$3
shift 3
drift_json=$(voice_agent_authority_drift_json "$@")
promotion_state_apply_result "${succeededCommit}" "$result" 0 1
promotion_state_render_attempt 2026-08-24T11:28:57Z "${succeededCommit}" - \\
  "$result" promotion "$drift_json"
promotion_state_render_metrics "$result" "$#"
printf '%s\\t%s\\n' "$consecutive_failures" "$circuit_state"`,
    "promotion-state-drift-test",
    driftHelper,
    promotionState,
    input.result,
    ...input.driftPaths,
  ]);
  const lines = stdout.trimEnd().split("\n");
  const attempt = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  const [failures, circuit] = (lines.at(-1) ?? "").split("\t");
  const metrics: Record<string, number> = {};
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("#")) continue;
    const [name, value] = line.split(" ");
    if (name !== undefined && value !== undefined) metrics[name] = Number(value);
  }
  return {
    attempt,
    circuitState: circuit ?? "",
    consecutiveFailures: Number(failures),
    metrics,
  };
}

test("a diverging Release records its paths and the attended action without failing the attempt", async () => {
  const rendered = await renderAttempt({
    driftPaths: [
      "promote-release.sh",
      "record-promotion-failure.sh",
      "systemd/voice-agent-api.service",
    ],
    result: "succeeded",
  });

  expect(rendered.attempt).toMatchObject({
    authorityDrift: {
      action: "./ops/upgrade-agent-host-deployment-authority.sh",
      diverged: true,
      paths: [
        "promote-release.sh",
        "record-promotion-failure.sh",
        "systemd/voice-agent-api.service",
      ],
    },
    commit: succeededCommit,
    result: "succeeded",
  });
  expect(rendered.consecutiveFailures).toBe(0);
  expect(rendered.circuitState).toBe("closed");
  expect(rendered.metrics).toMatchObject({
    voice_agent_promotion_authority_drift: 1,
    voice_agent_promotion_authority_drift_paths: 3,
    voice_agent_promotion_circuit_open: 0,
    voice_agent_promotion_consecutive_failures: 0,
    voice_agent_promotion_last_attempt_success: 1,
  });
});

test("a Release matching the pinned authority records drift as observed and absent", async () => {
  const rendered = await renderAttempt({ driftPaths: [], result: "succeeded" });

  expect(rendered.attempt).toMatchObject({
    authorityDrift: { diverged: false, paths: [] },
    result: "succeeded",
  });
  expect(rendered.metrics).toMatchObject({
    voice_agent_promotion_authority_drift: 0,
    voice_agent_promotion_authority_drift_paths: 0,
  });
});

test("drift alongside a genuine failure still counts only the failure", async () => {
  const rendered = await renderAttempt({
    driftPaths: ["systemd/voice-agent-worker.service"],
    result: "failed",
  });

  expect(rendered.consecutiveFailures).toBe(1);
  expect(rendered.circuitState).toBe("closed");
  expect(rendered.metrics).toMatchObject({
    voice_agent_promotion_authority_drift: 1,
    voice_agent_promotion_consecutive_failures: 1,
    voice_agent_promotion_last_attempt_success: 0,
  });
});

const webhookSecret = "fixture-webhook-secret";
const trustedSession = "scenario-trusted-session";
const previousCommit = "1111111111111111111111111111111111111111";
const divergingCommit = "2222222222222222222222222222222222222222";
const matchingCommit = "3333333333333333333333333333333333333333";
const unhealthyCommit = "4444444444444444444444444444444444444444";

async function createScenario(input: {
  readonly authorityDriftByCommit?: Readonly<
    Record<string, readonly string[]>
  >;
  readonly healthStatusByCommit?: Readonly<Record<string, number>>;
  readonly ids: readonly string[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-drift-promotion-"));
  temporaryDirectories.push(directory);
  return createHumanMergePromotionScenario({
    authorityDriftByCommit: input.authorityDriftByCommit,
    databasePath: join(directory, "scenario.sqlite"),
    healthStatusByCommit: input.healthStatusByCommit,
    ids: input.ids,
    now: "2026-08-24T11:28:57.000Z",
    webhookSecret,
  });
}

function humanMerge(commit: string, beforeCommit: string): FixtureGitHubEvent {
  return {
    action: "closed",
    beforeCommit,
    branch: "main",
    commit,
    event: "pull_request",
    merged: true,
    mergedAt: "2026-08-24T11:00:00.000Z",
    mergedBy: { login: "fixture-owner", type: "User" },
    repository: "JacobStephens2/fixture-application",
  };
}

async function promote(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  commit: string,
  beforeCommit: string,
) {
  const event = humanMerge(commit, beforeCommit);
  await scenario.deliver({
    deliveryId: `delivery-${commit}`,
    event,
    signature: signHumanMergeWebhook(webhookSecret, event),
  });
  return scenario.processNext();
}

test("a Promotion whose Release diverges names the paths and the attended action without failing", async () => {
  const scenario = await createScenario({
    authorityDriftByCommit: {
      [divergingCommit]: [
        "promote-release.sh",
        "record-promotion-failure.sh",
        "systemd/voice-agent-api.service",
      ],
    },
    ids: ["task-diverging", "attempt-diverging"],
  });

  const completed = await promote(scenario, divergingCommit, previousCommit);

  expect(completed?.promotion).toMatchObject({
    attempt: { mergeCommit: divergingCommit, status: "succeeded" },
    authorityDrift: {
      action: "./ops/upgrade-agent-host-deployment-authority.sh",
      diverged: true,
      paths: [
        "promote-release.sh",
        "record-promotion-failure.sh",
        "systemd/voice-agent-api.service",
      ],
    },
    circuit: { consecutiveFailures: 0, state: "closed" },
  });
  expect(completed?.task.status).toBe("completed");
  const observed = completed?.evidence.find(
    (event) => event.kind === "authority.drift-observed",
  );
  expect(observed?.summary).toContain(
    "./ops/upgrade-agent-host-deployment-authority.sh",
  );
  expect(observed?.details).toMatchObject({
    action: "./ops/upgrade-agent-host-deployment-authority.sh",
    paths: "promote-release.sh record-promotion-failure.sh systemd/voice-agent-api.service",
  });

  // The owner reads this in the PWA, not in a root terminal.
  const page = await scenario.readTaskPage("task-diverging", trustedSession);
  expect(page.statusCode).toBe(200);
  expect(page.html).toContain("Pinned Deployment Authority");
  expect(page.html).toContain("systemd/voice-agent-api.service");
  expect(page.html).toContain("./ops/upgrade-agent-host-deployment-authority.sh");
  await scenario.close();
});

test("a Release matching the pinned deployment authority records no drift", async () => {
  const scenario = await createScenario({ ids: ["task-match", "attempt-match"] });

  const completed = await promote(scenario, matchingCommit, previousCommit);

  expect(completed?.promotion.authorityDrift).toEqual({
    diverged: false,
    paths: [],
  });
  expect(
    completed?.evidence.some(
      (event) => event.kind === "authority.drift-observed",
    ),
  ).toBe(false);
  await scenario.close();
});

test("drift on a rolled-back attempt describes the Release left serving", async () => {
  const scenario = await createScenario({
    authorityDriftByCommit: {
      [matchingCommit]: ["systemd/voice-agent-worker.service"],
      [unhealthyCommit]: ["promote-main.sh"],
    },
    healthStatusByCommit: { [unhealthyCommit]: 503 },
    ids: [
      "task-restored",
      "attempt-restored",
      "task-unhealthy",
      "attempt-unhealthy",
    ],
  });
  await promote(scenario, matchingCommit, previousCommit);

  const completed = await promote(scenario, unhealthyCommit, matchingCommit);

  // The rolled-back Release is gone; what an owner needs named is the drift of
  // the Release that is serving now, which is the restored one.
  expect(completed?.promotion).toMatchObject({
    attempt: { status: "rolled-back" },
    authorityDrift: {
      diverged: true,
      paths: ["systemd/voice-agent-worker.service"],
    },
    circuit: { consecutiveFailures: 1, state: "closed" },
  });
  await scenario.close();
});

test("the Promotion hands drift to the record and never to the Deployment Circuit Breaker", async () => {
  const [promotion, state] = await Promise.all([
    readFile(join(repositoryRoot, "ops/release/promote-release.sh"), "utf8"),
    readFile(promotionState, "utf8"),
  ]);

  expect(promotion).toContain(
    'source "$script_directory/deployment-authority-drift.sh"',
  );
  // The breaker's decision is one function, and drift is not among the things
  // it reads. Nothing about a dormant reviewed change can open it.
  const decision = state.slice(
    state.indexOf("promotion_state_apply_result() {"),
    state.indexOf("# promotion_state_render_attempt"),
  );
  expect(decision).not.toContain("drift");
});
