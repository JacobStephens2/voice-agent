import { expect, test } from "vitest";

import {
  describeGrokConfigurationDrift,
  describeGrokRunnerDrift,
  reviewedGrokInspection,
} from "../src/grok-runner-pin.ts";

const pin = {
  configurationPath: "/etc/voice-agent/grok/config.toml",
  digest: "a".repeat(64),
  version: "0.2.111",
} as const;

test("a runner reporting the reviewed version and digest is not drift", () => {
  expect(
    describeGrokRunnerDrift({
      observedDigest: pin.digest,
      observedVersionOutput: "grok 0.2.111\n",
      pin,
    }),
  ).toBeNull();
});

test("a runner that upgraded itself is named as drift", () => {
  expect(
    describeGrokRunnerDrift({
      observedDigest: pin.digest,
      observedVersionOutput: "grok 0.2.112\n",
      pin,
    }),
  ).toBe("The runner reports version 0.2.112 rather than the reviewed 0.2.111");
});

test("a rebuilt binary at the reviewed version is still drift", () => {
  expect(
    describeGrokRunnerDrift({
      observedDigest: "b".repeat(64),
      observedVersionOutput: "grok 0.2.111",
      pin,
    }),
  ).toBe("The runner binary does not match the reviewed digest");
});

test("a runner that will not say what it is fails closed", () => {
  expect(
    describeGrokRunnerDrift({
      observedDigest: pin.digest,
      observedVersionOutput: "unknown build",
      pin,
    }),
  ).toBe("The runner did not report a version");
});

test("the reviewed effective configuration is not drift", () => {
  expect(
    describeGrokConfigurationDrift({ inspection: reviewedGrokInspection(pin), pin }),
  ).toBeNull();
});

test("an effective configuration that re-enabled self-update is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewedGrokInspection(pin),
        auto_update: { enabled: true },
      },
      pin,
    }),
  ).toBe("Runner self-update is enabled");
});

test("an effective configuration sourced from a project file is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewedGrokInspection(pin),
        config_sources: [
          "/etc/voice-agent/grok/config.toml",
          "/var/lib/voice-grok/run/task/.grok/config.toml",
        ],
      },
      pin,
    }),
  ).toBe(
    "Effective configuration is read from a source outside /etc/voice-agent/grok/config.toml",
  );
});

test("a project MCP server, plugin, or skill in the effective configuration is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewedGrokInspection(pin),
        mcp_servers: ["operations-broker"],
      },
      pin,
    }),
  ).toBe("Effective configuration declares MCP servers, plugins, or skills");
});

test("an effective configuration offering an API key is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewedGrokInspection(pin),
        authentication: { api_key_present: true, source: "oauth" },
      },
      pin,
    }),
  ).toBe("An xAI API key is available to the runner");
});

test("an effective configuration authenticating through the API is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewedGrokInspection(pin),
        authentication: { api_key_present: false, source: "api-key" },
      },
      pin,
    }),
  ).toBe("The runner authenticates through api-key rather than the subscription");
});

test("an effective configuration selecting another model is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { ...reviewedGrokInspection(pin), model: { default: "grok-4.6" } },
      pin,
    }),
  ).toBe("The default model selector is grok-4.6 rather than grok-build");
});

test("an effective configuration naming another sandbox profile is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { ...reviewedGrokInspection(pin), sandbox: { profile: "none" } },
      pin,
    }),
  ).toBe("The sandbox profile is none rather than voice-agent-task");
});

test("an inspection this contract does not recognize fails closed", () => {
  expect(
    describeGrokConfigurationDrift({ inspection: { version: "0.2.111" }, pin }),
  ).toBe("The runner's effective configuration does not have the reviewed shape");
});

test("an inspection reporting a version other than the pin is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { ...reviewedGrokInspection(pin), version: "0.2.112" },
      pin,
    }),
  ).toBe("The runner reports version 0.2.112 rather than the reviewed 0.2.111");
});
