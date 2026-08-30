import { expect, test } from "vitest";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertOutsideCredentialCustody,
  credentialCustodyBoundaryPaths,
  describeSandboxProfileDrift,
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

test("the sandbox profile shipped with this repository is the reviewed one", async () => {
  const profile = await readFile(
    fileURLToPath(new URL("../../../ops/grok/sandbox.toml", import.meta.url)),
    "utf8",
  );

  expect(describeSandboxProfileDrift(profile)).toBeNull();
});

test("a profile naming another base is refused", () => {
  expect(
    describeSandboxProfileDrift('[profiles.voice-agent-task]\nextends = "read-only"'),
  ).toBe("The reviewed sandbox profile does not extend the workspace base");
});

/**
 * Denying these paths makes the runner refuse to start on the Agent Host: it
 * re-opens each read-deny path after entering Bubblewrap, and a path the
 * executor identity cannot open reports Permission denied, which it reads as
 * an unenforced deny list. Catching that here beats catching it as every
 * Delegation failing to start.
 */
test("a profile declaring deny rules the runner cannot enforce is refused", () => {
  expect(
    describeSandboxProfileDrift(
      '[profiles.voice-agent-task]\nextends = "workspace"\ndeny = ["/root"]',
    ),
  ).toBe(
    "The reviewed sandbox profile declares deny rules the runner cannot enforce on this host",
  );
  expect(
    describeSandboxProfileDrift(
      '[profiles.voice-agent-task]\nextends = "workspace"\nrestrict_network = true',
    ),
  ).toBe(
    "The reviewed sandbox profile declares deny rules the runner cannot enforce on this host",
  );
});
