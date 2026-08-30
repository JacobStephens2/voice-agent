import { expect, test } from "vitest";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertOutsideCredentialCustody,
  credentialCustodyBoundaryPaths,
  describeAuthProviderDrift,
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

const broker = "/usr/local/libexec/voice-agent/grok-token-broker";

test("the auth layer shipped with this repository names the reviewed broker", async () => {
  const layer = await readFile(
    fileURLToPath(new URL("../../../ops/grok/run-requirements.toml", import.meta.url)),
    "utf8",
  );

  expect(describeAuthProviderDrift({ brokerPath: broker, layerText: layer })).toBeNull();
});

test("an auth layer naming another provider command is refused", () => {
  expect(
    describeAuthProviderDrift({
      brokerPath: broker,
      layerText: '[auth]\nauth_provider_command = "/tmp/mint"\n',
    }),
  ).toBe("The staged auth layer does not name the reviewed token broker");
});

test("an auth layer that names no provider command at all is refused", () => {
  expect(
    describeAuthProviderDrift({ brokerPath: broker, layerText: "[cli]\nauto_update = false\n" }),
  ).toBe("The staged auth layer does not open with the auth table");
});

/**
 * A command outside the table it looks like it belongs to is read by the
 * runner as a top-level key it does not have, so the crossing would be absent
 * while appearing present.
 */
test("a provider command outside the auth table is refused as an absent table", () => {
  expect(
    describeAuthProviderDrift({
      brokerPath: broker,
      layerText: `auth_provider_command = "${broker}"\n`,
    }),
  ).toBe("The staged auth layer does not open with the auth table");
});

/**
 * This layer outranks a Delegation root's own `.grok/config.toml`, so anything
 * it carries beyond the crossing would be policy nothing else reviewed.
 */
test("an auth layer carrying anything beyond the crossing is refused", () => {
  expect(
    describeAuthProviderDrift({
      brokerPath: broker,
      layerText: `[auth]\nauth_provider_command = "${broker}"\n\n[cli]\nauto_update = true\n`,
    }),
  ).toBe("The staged auth layer declares settings outside the token crossing");
  expect(
    describeAuthProviderDrift({
      brokerPath: broker,
      layerText: `[auth]\nauth_provider_command = "${broker}"\nauth_token_ttl = 60\n`,
    }),
  ).toBe("The staged auth layer declares settings outside the token crossing");
});
