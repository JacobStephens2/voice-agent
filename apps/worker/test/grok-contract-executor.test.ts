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

/**
 * The pinned layer is read back rather than inferred from the inspection. A
 * host-wide `auth_provider_command` would bind the custody identity too and
 * preempt the one renewal the six-hour login has, and `inspect` reports the
 * policy the layer produced, not the keys it used to produce it.
 */
test("a host-wide layer carrying an auth provider command pauses", async () => {
  const host = await stageHost({
    inspection: "reviewed",
    systemLayer: "provider-command",
  });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("names an auth provider command"),
    reason: "provider-contract-drift",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("every run asks the custody identity for a credential before it spawns a model", async () => {
  const host = await stageHost({ credential: "renewed", inspection: "reviewed" });

  expect(runExecutor(host).outcome).toMatchObject({ state: "completed" });
  // Only the crossing is exercised here: the renewal behind it belongs to the
  // helper on the far side, which reaches the pinned runner, not this process.
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

/**
 * Headless mode never reaches an `auth_provider_command`: a run whose home
 * holds nothing fails in a fifth of a second with "Not signed in", and one
 * whose credential expires part way through returns a 401 after spending
 * model tokens. So the crossing is made once, by a login into the run's own
 * home, before the model is spawned. Observed on grok 1.0.13; ADR-0069.
 */
test("every run signs its own Grok home in through the broker before the model", async () => {
  const host = await stageHost({ inspection: "reviewed" });

  expect(runExecutor(host).outcome).toMatchObject({ state: "completed" });
  await expect(readFile(`${host.root}/login`, "utf8")).resolves.toContain("login");
});

/**
 * The login removes `$GROK_HOME/requirements.toml` on its way out. A home left
 * without it would run the model under no layer this contract has reviewed, so
 * the crossing is staged again and read back a second time.
 */
test("the auth crossing the login removed is staged again before the model runs", async () => {
  const host = await stageHost({ inspection: "reviewed" });

  expect(runExecutor(host).outcome).toMatchObject({ state: "completed" });
  await expect(readFile(`${host.root}/run-layer`, "utf8")).resolves.toContain(
    host.tokenBrokerPath,
  );
});

test("a run home the crossing did not sign in pauses before the model is spawned", async () => {
  const host = await stageHost({ inspection: "reviewed", seeding: "no-credential" });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("not signed in through the Auth Crossing"),
    reason: "provider-authentication",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("a credential the broker did not mint pauses as drift", async () => {
  const host = await stageHost({
    inspection: "reviewed",
    seeding: "foreign-credential",
  });

  expect(runExecutor(host).outcome).toMatchObject({
    reason: "provider-contract-drift",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("a credential the run would outlast pauses before a request is spent", async () => {
  const host = await stageHost({ inspection: "reviewed", seeding: "short-lived" });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("expires before this run's time bound"),
    reason: "provider-authentication",
    state: "paused",
  });
  await expect(readFile(`${host.root}/invocation`, "utf8")).rejects.toThrow();
});

test("a probed lifetime shorter than the run's bound pauses before the login", async () => {
  const host = await stageHost({ credential: "too-short", inspection: "reviewed" });

  expect(runExecutor(host).outcome).toMatchObject({
    detail: expect.stringContaining("expires before this run's time bound"),
    reason: "provider-authentication",
    state: "paused",
  });
  await expect(readFile(`${host.root}/login`, "utf8")).rejects.toThrow();
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
  readonly credential?: "expired" | "renewed" | "too-short";
  readonly enrollment?: "accepted" | "for-another-build";
  readonly inspection: "reviewed" | "api-key-permitted";
  readonly systemLayer?: "provider-command";
  readonly unenforceableProfile?: boolean;
  readonly pinnedDigest?: string;
  readonly runFailure?: "quota";
  readonly seeding?: "foreign-credential" | "no-credential" | "short-lived";
}): Promise<StagedHost> {
  const root = await mkdtemp(join(tmpdir(), "grok-contract-"));
  temporaryDirectories.push(root);
  const configurationPath = `${root}/requirements.toml`;
  await writeFile(
    configurationPath,
    options.systemLayer === "provider-command"
      ? '[grok_com_config]\ndisable_api_key_auth = true\nauth_provider_command = "/tmp/mint"\n'
      : await readFile(
          fileURLToPath(new URL("../../../ops/grok/requirements.toml", import.meta.url)),
          "utf8",
        ),
  );
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
  const runRoot = `${root}/run`;
  const pin = { configurationPath, digest: "0".repeat(64), version: "1.0.13" };
  // The layer path the runner reports is resolved from `$GROK_HOME`, so the
  // stub reports one too. A preflight that forgot to set it would describe a
  // home the model will not run in, and the drift check would not notice.
  const inspection = reviewedGrokInspection({
    pin,
    runRequirementsPath: "$GROK_HOME/requirements.toml",
  });
  // `grok login` is the only thing that reaches the auth provider, it writes
  // the minted credential into the run's own home, and it removes the
  // requirements layer on its way out. All three observed on grok 1.0.13, and
  // all three are what the executor is written against.
  const seededExpiry =
    options.seeding === "short-lived"
      ? "Date.now() + 60_000"
      : "Date.now() + 6 * 3_600_000";
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "grok 1.0.13"; exit 0; fi',
    'if [ "$1" = "inspect" ]; then',
    // Unquoted heredoc: `$GROK_HOME` expands to whatever the caller set, or to
    // nothing at all when the caller forgot.
    "  cat <<JSON",
    JSON.stringify(
      options.inspection === "reviewed"
        ? inspection
        : { ...inspection, loginPolicy: { apiKeyAuthDisabled: false } },
    ),
    "JSON",
    "  exit 0",
    "fi",
    'if [ "$2" = "login" ]; then',
    `  printf '%s\\n' "$*" > ${root}/login`,
    options.seeding === "no-credential"
      ? '  echo "Signing in with browser instead..." >&2; exit 0'
      : [
          `  "${process.execPath}" -e 'const {writeFileSync}=require("node:fs");`,
          `writeFileSync(process.env.GROK_HOME+"/auth.json",JSON.stringify(`,
          `{"https://auth.x.ai::scope":{auth_mode:"${
            options.seeding === "foreign-credential" ? "oidc" : "external"
          }",`,
          `expires_at:new Date(${seededExpiry}).toISOString(),key:"t"}}))'`,
        ].join(""),
    `  rm -f "$GROK_HOME/requirements.toml"`,
    "  exit 0",
    "fi",
    `printf '%s\\n' "$*" > ${root}/invocation`,
    `env >> ${root}/invocation`,
    // The ephemeral home is removed after the run, so what the layer said at
    // the moment the model ran is recorded here rather than read afterwards.
    `cat "$GROK_HOME/requirements.toml" > ${root}/run-layer 2>/dev/null || true`,
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
      options.credential === "expired" ? "exit 12" : "",
      // A lifetime, never a credential. The run's own time bound has to fit
      // inside it: the runner does not renew one part way through.
      `printf '{"expires_in":${options.credential === "too-short" ? 900 : 21_600}}'`,
      "exit 0",
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
