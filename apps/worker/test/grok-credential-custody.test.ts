import { expect, test } from "vitest";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertOutsideCredentialCustody,
  credentialCustodyBoundaryPaths,
  describeMissingCustodyDenyRules,
} from "../src/grok-credential-custody.ts";

test("the boundary covers the provider auth store, the brokers, the evidence store, and host keys", () => {
  expect(credentialCustodyBoundaryPaths).toContain("/etc/ssh");
  expect(credentialCustodyBoundaryPaths).toContain("/home");
  expect(credentialCustodyBoundaryPaths).toContain("/var/lib/voice-grok-auth");
  expect(credentialCustodyBoundaryPaths).toContain("/run/voice-agent-grok-auth");
  expect(credentialCustodyBoundaryPaths).toContain("/var/lib/voice-agent-evidence");
  expect(credentialCustodyBoundaryPaths).toContain("/etc/voice-agent");
  expect(credentialCustodyBoundaryPaths).toContain("/root");
});

test("a path inside a boundary store is refused by the name of what it is", () => {
  expect(() =>
    assertOutsideCredentialCustody(
      "/var/lib/voice-grok-auth/.grok/auth.json",
      "The ephemeral Grok home",
    ),
  ).toThrow("The ephemeral Grok home is inside the Credential Custody Boundary");
});

test("a path that only shares a prefix with a boundary store is allowed", () => {
  expect(() =>
    assertOutsideCredentialCustody("/var/lib/voice-grok/run", "The run directory"),
  ).not.toThrow();
});

test("a boundary store itself is refused", () => {
  expect(() => assertOutsideCredentialCustody("/root", "The run directory")).toThrow(
    "The run directory is inside the Credential Custody Boundary",
  );
});

test("the root-managed profile shipped with this repository denies every boundary store", async () => {
  const configuration = await readFile(
    fileURLToPath(new URL("../../../ops/grok/config.toml", import.meta.url)),
    "utf8",
  );

  expect(describeMissingCustodyDenyRules(configuration)).toBeNull();
});

test("a profile that stopped denying a boundary store is named", () => {
  expect(
    describeMissingCustodyDenyRules(
      '[sandbox.profiles.voice-agent-task]\nrestrict_network = true\ndeny = ["/root/**"]',
    ),
  ).toContain("does not deny /etc/ssh");
});

test("a profile that let model-selected commands open the network is refused", () => {
  const denied = credentialCustodyBoundaryPaths
    .map((path) => `"${path}/**"`)
    .join(", ");

  expect(
    describeMissingCustodyDenyRules(
      `[sandbox.profiles.voice-agent-task]\nrestrict_network = false\ndeny = [${denied}]`,
    ),
  ).toBe("The reviewed sandbox profile does not restrict child-process network");
});
