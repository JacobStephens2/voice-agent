import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import { grokContractFailureConditions, grokFailureDrillOutcomes } from "@voice-agent/contracts";

const wizard = await readFile(
  fileURLToPath(new URL("../../../ops/acceptance/run-grok-enrollment.sh", import.meta.url)),
  "utf8",
);
const prerequisitesPath = fileURLToPath(
  new URL("../../../ops/acceptance/grok-enrollment-prerequisites.sh", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

/**
 * The wizard is the only thing an operator reads at the host, so a condition
 * this contract requires but the wizard never mentions would be a drill nobody
 * runs - discovered at the final `status`, after the eight stages are done.
 */
test("the wizard drills every condition the enrollment record requires", () => {
  for (const condition of grokContractFailureConditions) {
    expect(wizard).toContain(`[${condition}]=${grokFailureDrillOutcomes[condition]}`);
    // Every condition also carries the method that induces it: a drill an
    // operator cannot perform is a stage they will guess at.
    expect(wizard).toContain(`[${condition}]="`);
  }
});

test("the wizard files each Enrollment Event through the reviewed CLI", () => {
  for (const command of [
    "record-runner-pin",
    "record-enrollment",
    "record-contract-run",
    "record-custody-probe",
    "record-failure-drill",
    "record-stop-drill",
    "accept",
  ]) {
    expect(wizard).toContain(`enrollment ${command}`);
  }
  expect(wizard).toContain("grok-enrollment-cli.ts");
});

test("the wizard runs the contract test under the purpose that does not need a proof", () => {
  expect(wizard).toContain('"purpose": "contract-test"');
});

test("a non-traversable broker directory ends enrollment at the prerequisite stage", async () => {
  const blockedDirectory = await mkdtemp(join(tmpdir(), "grok-broker-blocked-"));
  temporaryDirectories.push(blockedDirectory);
  const brokerPath = join(blockedDirectory, "grok-token-broker");
  await writeFile(brokerPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(blockedDirectory, 0o600);
  // CI normally runs unprivileged. If it runs as root, drop the harness to a
  // numeric unprivileged identity so root's DAC override cannot hide the
  // missing directory execute bit this test exists to exercise.
  const unprivilegedIdentity =
    process.getuid?.() === 0 ? { gid: 65_534, uid: 65_534 } : {};

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
RED= RESET=
GROK=/fixture/grok
GROK_REQUIREMENTS=/fixture/requirements.toml
TOKEN_BROKER_DIRECTORY=/usr/local/libexec/voice-agent
TOKEN_BROKER="$2/grok-token-broker"
TOKEN_HELPER=/fixture/grok-token-helper
stage() { printf 'STAGE: %s\\n' "$1"; }
say() { printf 'SAY: %s\\n' "$1"; }
note() { printf 'NOTE: %s\\n' "$1"; }
warn() { printf 'WARN: %s\\n' "$1"; }
step() { :; }
pause() { :; }
id() { return 0; }
sudo() {
  if [[ "$1" == -u ]]; then
    shift 2
    if [[ "$1" == "$TOKEN_BROKER" ]]; then command "$@"; else return 0; fi
  elif [[ "$1" == stat ]]; then
    printf 'root\\n'
  else
    return 0
  fi
}
if ! verify_grok_enrollment_boundary; then exit 1; fi
stage "Pin the runner"
stage "Run the contract Delegation"`,
        "grok-enrollment-prerequisite-harness",
        prerequisitesPath,
        blockedDirectory,
      ],
      { encoding: "utf8", ...unprivilegedIdentity },
    );
  } finally {
    await chmod(blockedDirectory, 0o700);
  }

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("STAGE: Verify the enrollment boundary");
  expect(result.stdout).toContain("/usr/local/libexec/voice-agent");
  expect(result.stdout).toContain(
    "sudo chmod 0755 /usr/local/libexec/voice-agent",
  );
  expect(result.stdout).not.toContain("STAGE: Pin the runner");
  expect(result.stdout).not.toContain("STAGE: Run the contract Delegation");
});
