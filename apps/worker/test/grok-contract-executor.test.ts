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
  auth_source: "oauth",
  model: "grok-4.6",
  request_id: "req-1",
  result: {
    risks: [],
    status: "completed",
    summary: "Wrote the requested line.",
  },
  session_id: "ses-1",
  stop_reason: "end_turn",
  usage: { incomplete: false, input_tokens: 10, output_tokens: 4 },
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
      model: { providerReported: "grok-4.6", selector: "grok-build" },
      runner: { version: "0.2.111" },
      usage: { cost: "unknown", incomplete: false },
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
  const host = await stageHost({ inspection: "self-updating" });

  const record = runExecutor(host);

  expect(record.outcome).toMatchObject({
    detail: expect.stringContaining("Runner self-update is enabled"),
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

test("a sandbox profile that stopped denying a boundary store pauses", async () => {
  const host = await stageHost({ inspection: "reviewed", permissiveProfile: true });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("does not deny /etc/ssh"),
    reason: "provider-contract-drift",
    state: "paused",
  });
});

test("a provider that refused the subscription's usage pauses the task", async () => {
  const host = await stageHost({ inspection: "reviewed", runFailure: "quota" });

  expect(runExecutor(host).outcome).toMatchObject({
    reason: "provider-quota",
    state: "paused",
  });
});

interface StagedHost {
  readonly enrollmentPath: string;
  readonly evidenceRoot: string;
  readonly grokExecutable: string;
  readonly pin: GrokRunnerPin;
  readonly pinPath: string;
  readonly root: string;
  readonly runRoot: string;
}

async function stageHost(options: {
  readonly enrollment?: "accepted" | "for-another-build";
  readonly inspection: "reviewed" | "self-updating";
  readonly permissiveProfile?: boolean;
  readonly pinnedDigest?: string;
  readonly runFailure?: "quota";
}): Promise<StagedHost> {
  const root = await mkdtemp(join(tmpdir(), "grok-contract-"));
  temporaryDirectories.push(root);
  const configurationPath = `${root}/config.toml`;
  const reviewedProfile = await readFile(
    fileURLToPath(new URL("../../../ops/grok/config.toml", import.meta.url)),
    "utf8",
  );
  await writeFile(
    configurationPath,
    options.permissiveProfile === true
      ? reviewedProfile.replace('"/etc/ssh/**",\n', "")
      : reviewedProfile,
  );
  const pin = { configurationPath, digest: "0".repeat(64), version: "0.2.111" };
  const inspection = reviewedGrokInspection(pin);
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "grok 0.2.111"; exit 0; fi',
    'if [ "$1" = "inspect" ]; then',
    `  cat <<'JSON'`,
    JSON.stringify(
      options.inspection === "reviewed"
        ? inspection
        : { ...inspection, auto_update: { enabled: true } },
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
  const runRoot = `${root}/run`;
  const evidenceRoot = `${root}/evidence`;
  await mkdir(runRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  return {
    enrollmentPath,
    evidenceRoot,
    grokExecutable,
    pin: installedPin,
    pinPath,
    root,
    runRoot,
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
