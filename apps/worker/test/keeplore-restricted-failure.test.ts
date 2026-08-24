import { expect, test } from "vitest";

import {
  buildRestrictedRunnerEvidence,
  describeDelegationFailure,
  RestrictedRunFailure,
  restrictedRunnerEvidenceFileName,
} from "../src/keeplore-restricted-failure.ts";

test("a caught execution error is described by its type and message", () => {
  class KeeploreWorktreeError extends Error {}

  expect(
    describeDelegationFailure(
      new KeeploreWorktreeError("Unable to perform a scoped Keeplore Git operation"),
      [],
    ),
  ).toEqual({
    evidencePaths: [],
    kind: "delegation-execution",
    message: "Unable to perform a scoped Keeplore Git operation",
    name: "KeeploreWorktreeError",
  });
});

test("a restricted run failure keeps its kind and the evidence it retained", () => {
  const evidencePath =
    "/var/lib/voice-agent-evidence/delegation-1/restricted-runner-failure.json";

  expect(
    describeDelegationFailure(
      new RestrictedRunFailure(
        "sandbox-initialization",
        "Restricted Codex sandbox did not start; the runner exited with code 1",
      ),
      [evidencePath],
    ),
  ).toEqual({
    evidencePaths: [evidencePath],
    kind: "sandbox-initialization",
    message:
      "Restricted Codex sandbox did not start; the runner exited with code 1",
    name: "RestrictedRunFailure",
  });
});

test("a model that ran and declined is a different failure from a sandbox that never started", () => {
  const declined = describeDelegationFailure(
    new RestrictedRunFailure(
      "model-declined",
      "Restricted Codex ran and reported no candidate change",
    ),
    [],
  );
  const sandbox = describeDelegationFailure(
    new RestrictedRunFailure("sandbox-initialization", "bwrap never started"),
    [],
  );

  expect(declined.kind).toBe("model-declined");
  expect(sandbox.kind).toBe("sandbox-initialization");
});

test("a thrown value that is not an error is still described", () => {
  expect(describeDelegationFailure("worktree vanished", [])).toEqual({
    evidencePaths: [],
    kind: "delegation-execution",
    message: "Restricted execution failed without a described error",
    name: "string",
  });
  expect(describeDelegationFailure(null, []).name).toBe("null");
});

test("a described message is collapsed onto one line and bounded", () => {
  const described = describeDelegationFailure(
    new Error(`first line\n\tsecond line ${"x".repeat(400)}`),
    [],
  );

  expect(described.message).not.toContain("\n");
  expect(described.message.startsWith("first line second line xxx")).toBe(true);
  expect(described.message.length).toBe(300);
  expect(described.message.endsWith("…")).toBe(true);
});

test("a sandbox that failed to start is classified from the runner's own output", () => {
  const evidence = buildRestrictedRunnerEvidence({
    exitCode: 1,
    stderr: "bwrap: Creating new namespace failed: Operation not permitted",
  });

  expect(evidence.kind).toBe("sandbox-initialization");
  expect(evidence.exitCode).toBe(1);
  expect(evidence.stderr).toContain("Creating new namespace failed");
  expect(evidence.stderrTruncated).toBe(false);
});

test("a runner that started and then failed is not reported as a sandbox fault", () => {
  expect(
    buildRestrictedRunnerEvidence({
      exitCode: 2,
      stderr: "stream error: exceeded retry limit",
    }).kind,
  ).toBe("restricted-runner");
});

test("a model that ran and declined keeps that kind in its retained evidence", () => {
  expect(
    buildRestrictedRunnerEvidence(
      { exitCode: 0, stderr: "" },
      "model-declined",
    ).kind,
  ).toBe("model-declined");
});

test("retained restricted runner evidence carries only the runner's own output", () => {
  const evidence = buildRestrictedRunnerEvidence({
    exitCode: null,
    stderr: "y".repeat(200_000),
  });

  expect(Object.keys(evidence).sort()).toEqual([
    "exitCode",
    "kind",
    "stderr",
    "stderrTruncated",
  ]);
  expect(evidence.stderrTruncated).toBe(true);
  expect(evidence.stderr.length).toBeLessThanOrEqual(64_000);
  expect(restrictedRunnerEvidenceFileName).toBe("restricted-runner-failure.json");
});
