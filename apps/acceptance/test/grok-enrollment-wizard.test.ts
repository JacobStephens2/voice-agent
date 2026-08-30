import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { grokContractFailureConditions, grokFailureDrillOutcomes } from "@voice-agent/contracts";

const wizard = await readFile(
  fileURLToPath(new URL("../../../ops/acceptance/run-grok-enrollment.sh", import.meta.url)),
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
