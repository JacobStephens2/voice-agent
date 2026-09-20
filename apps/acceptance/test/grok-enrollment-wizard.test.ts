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
const operations = await readFile(
  fileURLToPath(new URL("../../../docs/operations/grok-enrollment.md", import.meta.url)),
  "utf8",
);
const prerequisitesPath = fileURLToPath(
  new URL("../../../ops/acceptance/grok-enrollment-prerequisites.sh", import.meta.url),
);
const prerequisites = await readFile(prerequisitesPath, "utf8");
const contractUnit = await readFile(
  fileURLToPath(
    new URL("../../../ops/systemd/voice-agent-grok-contract@.service", import.meta.url),
  ),
  "utf8",
);
const childCanary = await readFile(
  fileURLToPath(
    new URL("../../../ops/grok/auth-crossing-child-canary.sh", import.meta.url),
  ),
  "utf8",
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

/**
 * describeSystemRequirementsDrift refuses the key by name anywhere after
 * comments are stripped, including `grok_com_config = { auth_provider_command
 * = "…" }`. Enrollment is the other place that must assert the same thing; a
 * start-of-line `key =` grep misses that spelling, and the reviewed layer
 * names the key in comments, so the search has to follow a comment strip.
 */
test("enrollment refuses an auth provider command anywhere in the comment-stripped requirements layer", () => {
  const startOfLineKey =
    "^[[:space:]]*(auth\\.|grok_com_config\\.)?auth_provider_command[[:space:]]*=";
  for (const copy of [wizard, operations]) {
    expect(copy).not.toContain(startOfLineKey);
    expect(copy).toContain("sed 's/#.*$//'");
    expect(copy).toContain("auth_provider_command");
  }
  expect(wizard).toContain("grep -Fq 'auth_provider_command'");
  expect(operations).toContain("grep -cF 'auth_provider_command'");
});

/**
 * grok login still runs only when auth.json is absent. Claiming the authorize
 * stage re-authorizes if the pin cleared the session treats an untested
 * clearing as fact and skips a leftover file; that leftover is a failure the
 * broker probe surfaces.
 */
test("the wizard does not claim the authorize stage re-authorizes a leftover session", () => {
  expect(wizard).not.toMatch(/re-authoriz/u);
  expect(wizard).toContain("auth.json is absent");
  expect(wizard).toContain("leftover file after a cleared session");
  expect(wizard).toContain("broker probe");
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

/**
 * The sudoers crossing needs CAP_SETUID/CAP_SETGID and must be able to gain
 * euid 0 through setuid sudo. Telling the operator the unit has "no sudo
 * capabilities" would certify the configuration that cannot cross.
 */
test("enrollment does not tell the operator the contract unit has no sudo capabilities", () => {
  expect(prerequisites).not.toContain("no sudo capabilities");
  expect(wizard).not.toContain("no sudo capabilities");
  expect(operations).not.toContain("no sudo capabilities");
  expect(prerequisites).toContain("CAP_SETUID");
  expect(prerequisites).toContain("CAP_SETGID");
});

test("the contract unit grants only the sudoers crossing capabilities", () => {
  expect(contractUnit).toMatch(/^User=voice-grok$/mu);
  expect(contractUnit).not.toMatch(/^User=root$/mu);
  expect(contractUnit).toMatch(/^NoNewPrivileges=false$/mu);
  expect(contractUnit).toMatch(/^CapabilityBoundingSet=CAP_SETUID CAP_SETGID$/mu);
  expect(contractUnit).toMatch(/^AmbientCapabilities=$/mu);
  expect(contractUnit).toMatch(/^ReadWritePaths=.*\/var\/lib\/voice-grok-auth/mu);
  const inaccessible =
    contractUnit.match(/^InaccessiblePaths=(.*)$/mu)?.[1]?.split(" ") ?? [];
  expect(inaccessible).not.toContain("/var/lib/voice-grok-auth");
  expect(inaccessible).not.toContain("/usr/local/libexec/voice-agent");
});

/**
 * Child AppArmor, not the Grok sandbox deny list, holds the parent/child
 * split. Nested bwrap can fail on audit deny capability before the file deny
 * is tested, so the canary is this process's own ls and exec. The live unit
 * is an attended trap; the record holds the operator's confirmation, not a
 * second store count.
 */
test("enrollment canaries a Bubblewrap child that cannot list or execute the Auth Crossing", () => {
  expect(childCanary).not.toMatch(/\bbwrap\s+--/u);
  expect(childCanary).not.toContain("command -v bwrap");
  expect(childCanary).toContain('ls "$CROSSING"');
  expect(childCanary).toContain('"$BROKER"');
  expect(childCanary).toContain("/usr/local/libexec/voice-agent");
  expect(childCanary).toContain("grok-token-broker");
  expect(childCanary).toContain("unpriv_bwrap");
  for (const copy of [prerequisites, wizard, operations]) {
    expect(copy).toContain("auth-crossing-child-canary.sh");
    expect(copy).toContain("/etc/apparmor.d/local/unpriv_bwrap");
  }
  expect(wizard).toContain("--child-could-not-list-or-execute");
  expect(wizard).toContain("--parent-unit-probe-answered");
  expect(operations).toContain("--child-could-not-list-or-execute");
  expect(operations).toContain("--parent-unit-probe-answered");
});

test("an unconfined process that can list a 0755 Auth Crossing fails the child canary closed", async () => {
  const crossing = await mkdtemp(join(tmpdir(), "auth-crossing-open-"));
  temporaryDirectories.push(crossing);
  await chmod(crossing, 0o755);
  await writeFile(join(crossing, "grok-token-broker"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });

  const result = runChildCanaryAgainstCrossing(crossing);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("listed the Auth Crossing");
});

test("a process that cannot list or execute the Auth Crossing passes the child canary", async () => {
  const crossing = await mkdtemp(join(tmpdir(), "auth-crossing-denied-"));
  temporaryDirectories.push(crossing);
  await writeFile(join(crossing, "grok-token-broker"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await chmod(crossing, 0o000);
  try {
    const result = runChildCanaryAgainstCrossing(crossing);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "could not list or execute the Auth Crossing",
    );
  } finally {
    await chmod(crossing, 0o700);
  }
});

function runChildCanaryAgainstCrossing(crossing: string) {
  expect(childCanary).toContain(
    "readonly CROSSING=/usr/local/libexec/voice-agent",
  );
  const script = childCanary.replace(
    "readonly CROSSING=/usr/local/libexec/voice-agent",
    `readonly CROSSING='${crossing.replaceAll("'", "'\\''")}'`,
  );
  const unprivilegedIdentity =
    process.getuid?.() === 0 ? { gid: 65_534, uid: 65_534 } : {};
  return spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    ...unprivilegedIdentity,
  });
}
