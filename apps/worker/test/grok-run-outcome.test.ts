import { expect, test } from "vitest";

import { describeGrokRunOutcome } from "../src/grok-run-outcome.ts";

const pin = {
  configurationPath: "/etc/voice-agent/grok/config.toml",
  digest: "a".repeat(64),
  version: "0.2.111",
} as const;
const report = {
  risks: ["The registered verification command was not run by the model."],
  status: "completed",
  summary: "Appended the requested rule and left every other file untouched.",
} as const;
/**
 * The shape grok 1.0.13 returned for a real headless run on the Agent Host,
 * with the reasoning text it also carries. `thought` must never reach evidence.
 */
const envelope = {
  modelUsage: {
    "grok-4.6-build": { inputTokens: 1_200, modelCalls: 1, outputTokens: 340 },
  },
  num_turns: 1,
  requestId: "b8574042-7e9e-4bde-b987-9a01d9d791ea",
  sessionId: "01a054be-9e24-7a72-ab32-df482c72b2b5",
  stopReason: "end_turn",
  structuredOutput: report,
  text: JSON.stringify(report),
  thought: "The user wants me to return only a structured JSON result",
  total_cost_usd: 0.005_030_64,
  usage: {
    cache_read_input_tokens: 0,
    input_tokens: 1_200,
    output_tokens: 340,
    reasoning_tokens: 251,
    total_tokens: 14_244,
  },
};

function outcomeOf(overrides: Partial<Parameters<typeof describeGrokRunOutcome>[0]>) {
  return describeGrokRunOutcome({
    exceededOutputBound: false,
    exitCode: 0,
    pin,
    signalled: false,
    stderr: "",
    stdout: JSON.stringify(envelope),
    timedOut: false,
    ...overrides,
  });
}

test("a completed run records the provider's own account of itself", () => {
  expect(outcomeOf({})).toEqual({
    evidence: {
      authenticationRoute: "subscription-oauth",
      model: { providerReported: "grok-4.6-build", selector: "grok-4.6" },
      provider: "grok",
      requestId: "b8574042-7e9e-4bde-b987-9a01d9d791ea",
      runner: pin,
      sessionId: "01a054be-9e24-7a72-ab32-df482c72b2b5",
      stopReason: "end_turn",
      usage: {
        cost: { amount: 0.005_030_64, currency: "USD" },
        incomplete: false,
        inputTokens: 1_200,
        outputTokens: 340,
      },
    },
    report,
    state: "completed",
  });
});

test("the model's reasoning never reaches the recorded outcome", () => {
  const outcome = outcomeOf({});

  expect(JSON.stringify(outcome)).not.toContain("The user wants me to");
});

test("a runner that refused outright is failed, not read as a result", () => {
  expect(
    outcomeOf({
      exitCode: 1,
      stdout: JSON.stringify({
        message: "Couldn't set model 'grok-build': unknown model id",
        type: "error",
      }),
    }),
  ).toMatchObject({
    detail: "The provider refused the request without returning a result.",
    reason: "runner-execution",
    state: "failed",
  });
});

test("a run whose usage the provider could not complete says so", () => {
  expect(
    outcomeOf({
      stdout: JSON.stringify({
        ...envelope,
        total_cost_usd: null,
        usage: { input_tokens: null, output_tokens: null },
      }),
    }),
  ).toMatchObject({
    evidence: {
      usage: {
        cost: "unknown",
        incomplete: true,
        inputTokens: null,
        outputTokens: null,
      },
    },
    state: "completed",
  });
});

test("a subscription run that reported no cost records unknown, never zero", () => {
  const outcome = outcomeOf({
    stdout: JSON.stringify({ ...envelope, total_cost_usd: null }),
  });

  expect(outcome).toMatchObject({ evidence: { usage: { cost: "unknown" } } });
});

test("a model report that does not match the reviewed schema fails the run", () => {
  expect(
    outcomeOf({
      stdout: JSON.stringify({ ...envelope, structuredOutput: { status: "done" } }),
    }),
  ).toEqual({
    detail:
      "The provider returned a final result that does not match the reviewed structured schema.",
    evidence: expect.objectContaining({ provider: "grok" }),
    reason: "malformed-output",
    state: "failed",
  });
});

test("output that is not one JSON object fails the run without quoting it", () => {
  const outcome = outcomeOf({ stdout: "thinking...\n{" });
  expect(outcome).toMatchObject({ reason: "malformed-output", state: "failed" });
  expect(JSON.stringify(outcome)).not.toContain("thinking");
});

test("output larger than the reviewed result is not parsed at all", () => {
  expect(outcomeOf({ stdout: `${" ".repeat(1_000_000)}{}` })).toMatchObject({
    detail: "The provider returned more output than a structured result may contain.",
    reason: "malformed-output",
    state: "failed",
  });
});

test("a run stopped for flooding its output bound is named by the bound it hit", () => {
  expect(
    outcomeOf({ exceededOutputBound: true, exitCode: null, stdout: "{" }),
  ).toMatchObject({
    detail: "The provider returned more output than a structured result may contain.",
    reason: "malformed-output",
    state: "failed",
  });
});

test("a refusal reported alongside a well-formed envelope still pauses", () => {
  expect(
    outcomeOf({
      exitCode: 1,
      stderr: "error: 429 Too Many Requests: usage limit reached",
      stdout: JSON.stringify({ ...envelope, stop_reason: "error" }),
    }),
  ).toMatchObject({ reason: "provider-quota", state: "paused" });
});

test("an exhausted turn bound fails the run and keeps the run's evidence", () => {
  expect(
    outcomeOf({ stdout: JSON.stringify({ ...envelope, stopReason: "max_turns" }) }),
  ).toMatchObject({
    detail: "The provider stopped at the reviewed turn bound before returning a result.",
    evidence: expect.objectContaining({ stopReason: "max_turns" }),
    reason: "turn-limit",
    state: "failed",
  });
});

test("a run stopped by its time bound is a failure, not a silent empty result", () => {
  expect(outcomeOf({ exitCode: null, stdout: "", timedOut: true })).toEqual({
    detail: "The run passed its time bound and its process group was stopped.",
    evidence: null,
    reason: "timeout",
    state: "failed",
  });
});

test("a run interrupted by a signal is stopped rather than failed", () => {
  expect(outcomeOf({ exitCode: null, signalled: true, stdout: "" })).toEqual({
    detail:
      "Execution stopped at the owner's request; completed commits and unfinished work were left in place.",
    evidence: null,
    state: "stopped",
  });
});

test("an expired subscription login pauses the task for reauthorization", () => {
  expect(
    outcomeOf({
      exitCode: 1,
      stderr: "error: 401 Unauthorized: your login has expired, run grok login",
      stdout: "",
    }),
  ).toMatchObject({ reason: "provider-authentication", state: "paused" });
});

test("a subscription that does not include this model pauses the task", () => {
  expect(
    outcomeOf({
      exitCode: 1,
      stderr: "error: 403 Forbidden: your subscription is not entitled to grok-build",
      stdout: "",
    }),
  ).toMatchObject({ reason: "provider-entitlement", state: "paused" });
});

test("exhausted subscription usage pauses the task rather than buying capacity", () => {
  expect(
    outcomeOf({
      exitCode: 1,
      stderr: "error: 429 Too Many Requests: usage limit reached, try again later",
      stdout: "",
    }),
  ).toMatchObject({ reason: "provider-quota", state: "paused" });
});

test("no ending offers another provider or an API key", () => {
  const endings = [
    outcomeOf({ exitCode: 1, stderr: "429 quota exceeded", stdout: "" }),
    outcomeOf({ exitCode: 1, stderr: "401 unauthorized", stdout: "" }),
    outcomeOf({ exitCode: 2, stderr: "runner exploded", stdout: "" }),
  ];
  for (const ending of endings) {
    expect(JSON.stringify(ending)).not.toMatch(/api key|codex|claude|fallback/iu);
  }
});

test("an envelope missing the provider's own identity is contract drift", () => {
  expect(
    outcomeOf({ stdout: JSON.stringify({ ...envelope, stopReason: undefined }) }),
  ).toMatchObject({
    detail:
      "The provider's headless result does not have the shape this contract was accepted against.",
    reason: "provider-contract-drift",
    state: "paused",
  });
});

test("a runner that failed for its own reasons fails the run", () => {
  expect(outcomeOf({ exitCode: 2, stderr: "panic: sandbox missing", stdout: "" })).toEqual({
    detail: "The runner exited with code 2 without returning a structured result.",
    evidence: null,
    reason: "runner-execution",
    state: "failed",
  });
});
