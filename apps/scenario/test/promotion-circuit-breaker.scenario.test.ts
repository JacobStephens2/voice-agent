import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const promotionState = join(repositoryRoot, "ops/release/promotion-state.sh");
const execFileAsync = promisify(execFile);

const blockedCommit = "c81f4a1b59906b19cf0801ad765b2acc71ae35b7";
const nextCommit = "cd2a588dcbbdede59d17d4dafa6f31a7546d2a4f";

interface BreakerState {
  readonly circuitState: string;
  readonly consecutiveFailures: number;
  readonly lastAttemptedCommit: string;
  readonly lastFailedCommit: string;
}

/**
 * Apply a sequence of Promotion Attempts to the real circuit-breaker decision.
 * `promotion_state_apply_result` writes no files, so the rule that governs
 * production is exercised here rather than described.
 */
async function applyAttempts(
  attempts: readonly (readonly [
    commit: string,
    result: "failed" | "succeeded",
    manualRollback?: 0 | 1,
    counted?: 0 | 1,
  ])[],
): Promise<BreakerState> {
  const calls = attempts
    .map(([commit, result, manualRollback = 0, counted = 1]) =>
      `promotion_state_apply_result ${commit} ${result} ${manualRollback} ${counted}`,
    )
    .join("\n");
  const { stdout } = await execFileAsync("bash", [
    "-c",
    `set -euo pipefail
source "${promotionState}"
consecutive_failures=0
circuit_state=closed
last_failed_commit=-
last_attempted_commit=-
${calls}
printf '%s\\t%s\\t%s\\t%s\\n' "$consecutive_failures" "$circuit_state" \\
  "$last_failed_commit" "$last_attempted_commit"`,
  ]);
  const [failures, circuit, failed, attempted] = stdout.trim().split("\t");
  return {
    circuitState: circuit ?? "",
    consecutiveFailures: Number(failures),
    lastAttemptedCommit: attempted ?? "",
    lastFailedCommit: failed ?? "",
  };
}

test("three distinct failed Promotion Attempts open the Deployment Circuit Breaker", async () => {
  await expect(
    applyAttempts([
      [blockedCommit, "failed"],
      [blockedCommit, "failed"],
    ]),
  ).resolves.toMatchObject({
    circuitState: "closed",
    consecutiveFailures: 2,
  });
  await expect(
    applyAttempts([
      [blockedCommit, "failed"],
      [blockedCommit, "failed"],
      [blockedCommit, "failed"],
    ]),
  ).resolves.toMatchObject({
    circuitState: "open",
    consecutiveFailures: 3,
    lastFailedCommit: blockedCommit,
  });
});

test("a resumed failure of an already-counted commit does not inflate the breaker", async () => {
  const counted = await applyAttempts([
    [blockedCommit, "failed"],
    [blockedCommit, "failed"],
    [blockedCommit, "failed"],
  ]);
  const resumed = await applyAttempts([
    [blockedCommit, "failed"],
    [blockedCommit, "failed"],
    [blockedCommit, "failed"],
    // Four Fresh Passkey Actions retrying the same refused Human Merge.
    [blockedCommit, "failed", 0, 0],
    [blockedCommit, "failed", 0, 0],
    [blockedCommit, "failed", 0, 0],
    [blockedCommit, "failed", 0, 0],
  ]);

  expect(resumed).toEqual(counted);
  expect(resumed.consecutiveFailures).toBe(3);
});

test("an uncounted failure cannot open the breaker on its own", async () => {
  await expect(
    applyAttempts([
      [blockedCommit, "failed", 0, 0],
      [blockedCommit, "failed", 0, 0],
      [blockedCommit, "failed", 0, 0],
      [blockedCommit, "failed", 0, 0],
    ]),
  ).resolves.toMatchObject({
    circuitState: "closed",
    consecutiveFailures: 0,
    lastFailedCommit: "-",
  });
});

test("a successful Promotion Attempt closes the breaker and clears the count", async () => {
  await expect(
    applyAttempts([
      [blockedCommit, "failed"],
      [blockedCommit, "failed"],
      [blockedCommit, "failed"],
      [blockedCommit, "failed", 0, 0],
      [nextCommit, "succeeded"],
    ]),
  ).resolves.toEqual({
    circuitState: "closed",
    consecutiveFailures: 0,
    lastAttemptedCommit: nextCommit,
    lastFailedCommit: "-",
  });
});

test("a manual rollback does not become the last attempted commit", async () => {
  await expect(
    applyAttempts([
      [nextCommit, "succeeded"],
      [blockedCommit, "failed", 1],
    ]),
  ).resolves.toMatchObject({
    consecutiveFailures: 1,
    lastAttemptedCommit: nextCommit,
    lastFailedCommit: blockedCommit,
  });
});

test("the promotion-resume unit cannot be rate-limited out of recovering", async () => {
  const [unit, resume, recorder] = await Promise.all(
    [
      "ops/systemd/voice-agent-promotion-resume.service",
      "ops/release/resume-promotion.sh",
      "ops/release/record-promotion-failure.sh",
    ].map(async (path) => {
      const { stdout } = await execFileAsync("cat", [
        join(repositoryRoot, path),
      ]);
      return stdout;
    }),
  );

  expect(unit).toContain("StartLimitIntervalSec=0");
  expect(resume).toContain(
    '"$commit" fresh-passkey-resume-build --already-counted',
  );
  expect(recorder).toContain("--already-counted");
});
