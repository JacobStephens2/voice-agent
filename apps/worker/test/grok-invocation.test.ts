import { expect, test } from "vitest";

import { buildGrokInvocation } from "../src/grok-invocation.ts";

const input = {
  delegationRoot: "/var/lib/voice-grok/run/task-1/delegation",
  ephemeralHome: "/var/lib/voice-grok/run/task-1/home",
  maxTurns: 12,
  briefFilePath: "/var/lib/voice-grok/run/task-1/brief.md",
  resultSchemaPath: "/var/lib/voice-grok/run/task-1/result.schema.json",
  sourceEnvironment: {
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
    HOME: "/var/lib/voice-grok",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    SSH_AUTH_SOCK: "/run/user/1004/keyring/ssh",
  },
} as const;

test("the invocation pins the runner, the model, and the reviewed result schema", () => {
  expect(buildGrokInvocation(input).arguments).toEqual([
    "--no-auto-update",
    "--cwd",
    "/var/lib/voice-grok/run/task-1/delegation",
    "--model",
    "grok-build",
    "--prompt-file",
    "/var/lib/voice-grok/run/task-1/brief.md",
    "--output-format",
    "json",
    "--json-schema",
    "/var/lib/voice-grok/run/task-1/result.schema.json",
    "--always-approve",
    "--max-turns",
    "12",
    "--no-plan",
    "--no-memory",
    "--sandbox",
    "voice-agent-task",
  ]);
});

test("the model process receives an ephemeral home and nothing it inherited", () => {
  expect(buildGrokInvocation(input).environment).toEqual({
    GROK_HOME: "/var/lib/voice-grok/run/task-1/home",
    HOME: "/var/lib/voice-grok/run/task-1/home",
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/var/lib/voice-grok/run/task-1/home/tmp",
  });
});

test("an inherited xAI API key refuses the run rather than being stripped", () => {
  expect(() =>
    buildGrokInvocation({
      ...input,
      sourceEnvironment: { ...input.sourceEnvironment, XAI_API_KEY: "xai-key" },
    }),
  ).toThrow("An xAI API key is present; this provider runs on the subscription alone");
});

test("a run bounded by nothing is refused", () => {
  expect(() => buildGrokInvocation({ ...input, maxTurns: 0 })).toThrow(
    "A Grok run must be bounded by between 1 and 50 turns",
  );
});

test("a run staged inside the Credential Custody Boundary is refused", () => {
  expect(() =>
    buildGrokInvocation({ ...input, ephemeralHome: "/var/lib/voice-agent/grok-home" }),
  ).toThrow("The ephemeral Grok home is inside the Credential Custody Boundary");
});

test("a relative Delegation root is refused", () => {
  expect(() => buildGrokInvocation({ ...input, delegationRoot: "delegation" })).toThrow(
    "The Delegation root must be an absolute path",
  );
});
