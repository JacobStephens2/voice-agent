import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { grokContractFailureConditions, grokFailureDrillOutcomes } from "@voice-agent/contracts";

const wizard = await readFile(
  fileURLToPath(new URL("../../../ops/acceptance/run-grok-enrollment.sh", import.meta.url)),
  "utf8",
);
const operations = await readFile(
  fileURLToPath(new URL("../../../docs/operations/grok-enrollment.md", import.meta.url)),
  "utf8",
);

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
