import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import {
  appendGrokEnrollmentEvent,
  createGrokEnrollmentRecord,
  grokContractRunRecordSchema,
  grokFailureDrillOutcomes,
  markGrokEnrollmentAccepted,
  type GrokContractDelegationBrief,
  type GrokRunnerPin,
} from "@voice-agent/contracts";

import { reviewedGrokInspection } from "../src/grok-runner-pin.ts";

const executorPath = fileURLToPath(
  new URL("../src/grok-contract-executor.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

const brief: GrokContractDelegationBrief = {
  acceptanceCriteria: ["The named file contains the requested line."],
  boundedContext: {
    editablePaths: ["notes.md"],
    repositoryContentTrust: "untrusted-data-only",
  },
  capabilities: ["delegated-worktree.read", "delegated-worktree.write"],
  delegationId: "grok-contract-1",
  goal: "Write one line into notes.md.",
  maxTurns: 4,
  provider: "grok",
  purpose: "contract-test",
};

const envelope = {
  modelUsage: { "grok-4.6-build": { modelCalls: 1 } },
  requestId: "req-1",
  sessionId: "ses-1",
  stopReason: "end_turn",
  structuredOutput: {
    risks: [],
    status: "completed",
    summary: "Wrote the requested line.",
  },
  total_cost_usd: 0.004,
  usage: { input_tokens: 10, output_tokens: 4 },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("an accepted run records the provider's evidence and removes its Grok home", async () => {
  const host = await stageHost({ inspection: "reviewed" });

  const record = runExecutor(host);

  expect(record.outcome).toMatchObject({
    evidence: {
      authenticationRoute: "subscription-oauth",
      model: { providerReported: "grok-4.6-build", selector: "grok-4.6" },
      runner: { version: "1.0.13" },
      usage: { cost: { amount: 0.004, currency: "USD" }, incomplete: false },
    },
    report: { status: "completed" },
    state: "completed",
  });
  expect(record.workspace.git).toBe("not-a-repository");
  await expect(
    readFile(`${host.runRoot}/${brief.delegationId}/home/tmp`, "utf8"),
  ).rejects.toThrow();
  const durable = JSON.parse(
    await readFile(
      `${host.evidenceRoot}/${brief.delegationId}/grok-contract-run.json`,
      "utf8",
    ),
  );
  expect(grokContractRunRecordSchema.parse(durable)).toEqual(record);
  // The model's own arguments are what the contract fixes, not what it asks for.
  const invocation = await readFile(`${host.root}/invocation`, "utf8");
  expect(invocation).toContain("--no-auto-update");
  expect(invocation).toContain("--always-approve");
  expect(invocation).toContain("--max-turns 4");
  expect(invocation).not.toContain("XAI_API_KEY");
});

test("a runner that is not the reviewed binary pauses before any request", async () => {
  const host = await stageHost({ inspection: "reviewed", pinnedDigest: "0".repeat(64) });

  const record = runExecutor(host);

  expect(record.outcome).toMatchObject({
    reason: "runner-pin-drift",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("an effective configuration that changed under the pinned runner pauses", async () => {
  const host = await stageHost({ inspection: "api-key-permitted" });

  const record = runExecutor(host);

  expect(record.outcome).toMatchObject({
    detail: expect.stringContaining("API key authentication is not disabled"),
    reason: "provider-contract-drift",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("work refuses to run until this runner build has passed the contract test", async () => {
  const host = await stageHost({ inspection: "reviewed" });

  expect(runExecutor(host, { purpose: "work" }).outcome).toMatchObject({
    detail: expect.stringContaining("no accepted enrollment proof"),
    reason: "runner-pin-drift",
    state: "paused",
  });
});

test("work refuses a proof that belongs to another runner build", async () => {
  const host = await stageHost({
    enrollment: "for-another-build",
    inspection: "reviewed",
  });

  expect(runExecutor(host, { purpose: "work" }).outcome).toMatchObject({
    detail: expect.stringContaining("another runner build"),
    reason: "runner-pin-drift",
    state: "paused",
  });
});

test("work runs once the pinned runner's enrollment is accepted", async () => {
  const host = await stageHost({ enrollment: "accepted", inspection: "reviewed" });

  expect(runExecutor(host, { purpose: "work" }).outcome).toMatchObject({
    state: "completed",
  });
});

test("a sandbox profile the runner could not enforce pauses", async () => {
  const host = await stageHost({
    inspection: "reviewed",
    unenforceableProfile: true,
  });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("cannot enforce on this host"),
    reason: "provider-contract-drift",
    state: "paused",
  });
});

test("a login expiring before the run is renewed by the probe that checks it", async () => {
  const host = await stageHost({ credential: "renewed", inspection: "reviewed" });

  expect(runExecutor(host).outcome).toMatchObject({ state: "completed" });
  await expect(readFile(`${host.root}/probe`, "utf8")).resolves.toContain("--probe");
});

test("a login the runner could not renew pauses before the model is spawned", async () => {
  const host = await stageHost({ credential: "expired", inspection: "reviewed" });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("expired"),
    reason: "provider-authentication",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("an auth crossing that is not the reviewed one pauses before any request", async () => {
  const host = await stageHost({ authLayer: "another-broker", inspection: "reviewed" });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("does not name the reviewed token broker"),
    reason: "provider-contract-drift",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("a provider that refused the subscription's usage pauses the task", async () => {
  const host = await stageHost({ inspection: "reviewed", runFailure: "quota" });

  expect(runExecutor(host).outcome).toMatchObject({
    reason: "provider-quota",
    state: "paused",
  });
});

interface StagedHost {
  readonly authLayerPath: string;
  readonly enrollmentPath: string;
  readonly tokenBrokerPath: string;
  readonly evidenceRoot: string;
  readonly grokExecutable: string;
  readonly pin: GrokRunnerPin;
  readonly pinPath: string;
  readonly sandboxProfilePath: string;
  readonly root: string;
  readonly runRoot: string;
}

async function stageHost(options: {
  readonly authLayer?: "another-broker";
  readonly credential?: "expired" | "renewed";
  readonly enrollment?: "accepted" | "for-another-build";
  readonly inspection: "reviewed" | "api-key-permitted";
  readonly unenforceableProfile?: boolean;
  readonly pinnedDigest?: string;
  readonly runFailure?: "quota";
}): Promise<StagedHost> {
  const root = await mkdtemp(join(tmpdir(), "grok-contract-"));
  temporaryDirectories.push(root);
  const configurationPath = `${root}/requirements.toml`;
  await writeFile(configurationPath, "[cli]\nauto_update = false\n");
  const sandboxProfilePath = `${root}/sandbox.toml`;
  await writeFile(
    sandboxProfilePath,
    options.unenforceableProfile === true
      ? '[profiles.voice-agent-task]\nextends = "workspace"\nrestrict_network = true\n'
      : await readFile(
          fileURLToPath(new URL("../../../ops/grok/sandbox.toml", import.meta.url)),
          "utf8",
        ),
  );
  const pin = { configurationPath, digest: "0".repeat(64), version: "1.0.13" };
  const inspection = reviewedGrokInspection(pin);
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "grok 1.0.13"; exit 0; fi',
    'if [ "$1" = "inspect" ]; then',
    `  cat <<'JSON'`,
    JSON.stringify(
      options.inspection === "reviewed"
        ? inspection
        : { ...inspection, loginPolicy: { apiKeyAuthDisabled: false } },
    ),
    "JSON",
    "  exit 0",
    "fi",
    `printf '%s\\n' "$*" > ${root}/invocation`,
    `env >> ${root}/invocation`,
    options.runFailure === "quota"
      ? 'echo "error: 429 Too Many Requests: usage limit reached" >&2; exit 1'
      : `cat <<'JSON'\n${JSON.stringify(envelope)}\nJSON`,
    "",
  ].join("\n");
  const grokExecutable = `${root}/grok`;
  await writeFile(grokExecutable, script);
  await chmod(grokExecutable, 0o755);
  const pinPath = `${root}/runner-pin.json`;
  const installedPin = {
    configurationPath,
    digest: options.pinnedDigest ?? (await digestOf(grokExecutable)),
    version: pin.version,
  };
  await writeFile(pinPath, JSON.stringify(installedPin));
  const enrollmentPath = `${root}/grok-enrollment.json`;
  if (options.enrollment !== undefined) {
    await writeFile(
      enrollmentPath,
      JSON.stringify(
        provedEnrollment(
          options.enrollment === "accepted"
            ? installedPin
            : { ...installedPin, digest: "f".repeat(64) },
        ),
      ),
    );
  }
  // The broker answers with a status, never a token: this stands in for the
  // crossing to the custody identity, which the executor cannot make in a test.
  const tokenBrokerPath = `${root}/grok-token-broker`;
  await writeFile(
    tokenBrokerPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > ${root}/probe`,
      options.credential === "expired" ? "exit 12" : "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(tokenBrokerPath, 0o755);
  const authLayerPath = `${root}/run-requirements.toml`;
  await writeFile(
    authLayerPath,
    `[auth]\nauth_provider_command = "${
      options.authLayer === "another-broker" ? `${root}/elsewhere` : tokenBrokerPath
    }"\n`,
  );
  const runRoot = `${root}/run`;
  const evidenceRoot = `${root}/evidence`;
  await mkdir(runRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  return {
    authLayerPath,
    enrollmentPath,
    evidenceRoot,
    grokExecutable,
    pin: installedPin,
    pinPath,
    root,
    runRoot,
    sandboxProfilePath,
    tokenBrokerPath,
  };
}

function runExecutor(host: StagedHost, override: Partial<GrokContractDelegationBrief> = {}) {
  const spawned = spawnSync(
    process.execPath,
    ["--experimental-strip-types", executorPath],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        VOICE_AGENT_GROK_ENROLLMENT_PATH: host.enrollmentPath,
        VOICE_AGENT_GROK_EVIDENCE_ROOT: host.evidenceRoot,
        VOICE_AGENT_GROK_EXECUTABLE: host.grokExecutable,
        VOICE_AGENT_GROK_PIN_PATH: host.pinPath,
        VOICE_AGENT_GROK_RUN_ROOT: host.runRoot,
        VOICE_AGENT_GROK_AUTH_LAYER_PATH: host.authLayerPath,
        VOICE_AGENT_GROK_SANDBOX_PROFILE_PATH: host.sandboxProfilePath,
        VOICE_AGENT_GROK_TOKEN_BROKER: host.tokenBrokerPath,
      },
      input: JSON.stringify({ ...brief, ...override }),
    },
  );
  expect(spawned.stderr).toBe("");
  expect(spawned.status).toBe(0);
  return grokContractRunRecordSchema.parse(JSON.parse(spawned.stdout));
}

/** An enrollment record that has passed and been accepted for one runner. */
function provedEnrollment(runner: GrokRunnerPin) {
  let clock = 0;
  const at = () => new Date(Date.UTC(2026, 7, 29, 10, clock++)).toISOString();
  let record = createGrokEnrollmentRecord({ campaignId: "grok-enrollment" });
  const append = (event: Record<string, unknown>) => {
    record = appendGrokEnrollmentEvent(record, { ...event, recordedAt: at() });
  };
  append({ ...runner, kind: "runner-pinned", selfUpdateDisabled: true });
  append({
    apiKeyAbsent: true,
    authenticationRoute: "subscription-oauth",
    codeRetentionDisabled: true,
    kind: "subscription-enrolled",
  });
  append({
    authenticationRoute: "subscription-oauth",
    kind: "contract-run",
    model: "grok-4.6",
    runner,
    sessionId: "ses-1",
    stopReason: "end_turn",
    usageIncomplete: false,
  });
  append({ canarySecretsFound: 0, kind: "custody-probe", readableBoundaryPaths: 0 });
  for (const [condition, outcome] of Object.entries(grokFailureDrillOutcomes)) {
    append({ condition, fellBackToAnotherProvider: false, kind: "failure-drill", outcome });
  }
  append({
    commitsPreserved: true,
    destructiveGitCommands: 0,
    kind: "stop-drill",
    unfinishedWorkPreserved: true,
  });
  return markGrokEnrollmentAccepted(record, { recordedAt: at() });
}

async function digestOf(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
