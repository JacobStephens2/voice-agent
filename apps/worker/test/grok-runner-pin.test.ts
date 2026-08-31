import { expect, test } from "vitest";

import {
  describeGrokConfigurationDrift,
  describeGrokRunnerDrift,
  reviewedGrokInspection,
} from "../src/grok-runner-pin.ts";

const pin = {
  configurationPath: "/etc/grok/requirements.toml",
  digest: "a".repeat(64),
  version: "1.0.13",
} as const;

const runRequirementsPath = "/var/lib/voice-grok/run/task/home/requirements.toml";
const reviewed = reviewedGrokInspection({ pin, runRequirementsPath });

test("a runner reporting the reviewed version and digest is not drift", () => {
  expect(
    describeGrokRunnerDrift({
      observedDigest: pin.digest,
      observedVersionOutput: "grok 1.0.13 (5e9a58528b76) [alpha]\n",
      pin,
    }),
  ).toBeNull();
});

test("a runner that upgraded itself is named as drift", () => {
  expect(
    describeGrokRunnerDrift({
      observedDigest: pin.digest,
      observedVersionOutput: "grok 1.0.14 (abc) [stable]",
      pin,
    }),
  ).toBe("The runner reports version 1.0.14 rather than the reviewed 1.0.13");
});

test("a rebuilt binary at the reviewed version is still drift", () => {
  expect(
    describeGrokRunnerDrift({
      observedDigest: "b".repeat(64),
      observedVersionOutput: "grok 1.0.13",
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
  expect(describeGrokConfigurationDrift({ inspection: reviewed, pin, runRequirementsPath })).toBeNull();
});

/**
 * The shape a bare 1.0.13 actually emits, recorded from the installed binary.
 * It must be refused: nothing has configured the boundary yet.
 */
test("a bare runner with no reviewed requirements layer is drift", () => {
  const bare = {
    agents: [
      { description: "d", name: "general-purpose", source: { type: "builtin" } },
      { description: "d", name: "explore", source: { type: "builtin" } },
    ],
    channel: "unknown",
    configSources: { layers: [] },
    cwd: "/x",
    externalCompat: {
      cells: [{ enabled: true, source: "default", surface: "skills", vendor: "claude" }],
      remoteSettingsLoaded: false,
    },
    grokVersion: "1.0.13",
    hooks: [],
    loginPolicy: {
      apiKeyAuthDisabled: false,
      disableApiKeyAuth: null,
      forceLoginTeamUuid: null,
    },
    lspServers: [],
    marketplaces: [],
    mcpServers: [],
    permissions: {
      loaded: 0,
      managedSettingsActive: false,
      managedSettingsExists: false,
      managedSettingsPath: "/etc/claude-code/managed-settings.json",
      marketplaceAllowlist: [],
      mcpServerAllowlist: [],
      skipped: [],
      sources: [],
    },
    plugins: [],
    projectInstructions: [],
    projectRoot: null,
    projectTrusted: true,
    skills: [],
  };

  expect(describeGrokConfigurationDrift({ inspection: bare, pin, runRequirementsPath })).toBe(
    "No reviewed system requirements layer is in effect at /etc/grok/requirements.toml",
  );
});

test("a user configuration layer in effect beside the requirements is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewed,
        configSources: {
          layers: [
            { path: runRequirementsPath, role: "requirements" },
            { path: pin.configurationPath, role: "system-requirements" },
            { path: "/var/lib/voice-grok/run/task/.grok/config.toml", role: "user" },
          ],
        },
      },
      pin,
      runRequirementsPath,
    }),
  ).toBe("Effective configuration includes a layer outside the reviewed requirements");
});

/**
 * The system layer binds every identity on the host and the home-local one
 * carries this run's auth crossing. Both are in force at once on the Agent
 * Host, so an inspection reporting only the system layer is a run whose
 * crossing did not survive - which is what `grok login` does to it.
 */
test("a run whose own auth crossing is not in effect is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewed,
        configSources: {
          layers: [{ path: pin.configurationPath, role: "system-requirements" }],
        },
      },
      pin,
      runRequirementsPath,
    }),
  ).toBe(
    "No reviewed auth crossing is in effect at /var/lib/voice-grok/run/task/home/requirements.toml",
  );
});

test("a requirements layer belonging to another run is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewed,
        configSources: {
          layers: [
            { path: "/var/lib/voice-grok/run/other/home/requirements.toml", role: "requirements" },
            { path: pin.configurationPath, role: "system-requirements" },
          ],
        },
      },
      pin,
      runRequirementsPath,
    }),
  ).toBe(
    "No reviewed auth crossing is in effect at /var/lib/voice-grok/run/task/home/requirements.toml",
  );
});

test("an empty layer is not a layer in effect", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewed,
        configSources: {
          layers: [
            { note: "empty", path: "/x/managed_config.toml", role: "managed" },
            { path: runRequirementsPath, role: "requirements" },
            { path: pin.configurationPath, role: "system-requirements" },
          ],
        },
      },
      pin,
      runRequirementsPath,
    }),
  ).toBeNull();
});

test("a runner whose policy still permits API key authentication is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { ...reviewed, loginPolicy: { apiKeyAuthDisabled: false } },
      pin,
      runRequirementsPath,
    }),
  ).toBe("API key authentication is not disabled by policy");
});

test("a runner reading third-party vendor surfaces is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewed,
        externalCompat: {
          cells: [{ enabled: true, source: "default", surface: "skills", vendor: "claude" }],
        },
      },
      pin,
      runRequirementsPath,
    }),
  ).toBe("Effective configuration reads third-party claude skills");
});

test("a project MCP server, plugin, or skill in the effective configuration is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { ...reviewed, mcpServers: [{ name: "operations-broker" }] },
      pin,
      runRequirementsPath,
    }),
  ).toBe("Effective configuration declares MCP servers");
});

test("an agent the runner did not define is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: {
        ...reviewed,
        agents: [{ name: "repo-agent", source: { type: "project" } }],
      },
      pin,
      runRequirementsPath,
    }),
  ).toBe("Effective configuration declares agents outside the runner's own");
});

test("configuration warnings the runner raised are drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { ...reviewed, configWarnings: ["unknown key [update]"] },
      pin,
      runRequirementsPath,
    }),
  ).toBe("The runner reported configuration warnings");
});

test("an inspection this contract does not recognize fails closed", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { grokVersion: "1.0.13" },
      pin,
      runRequirementsPath,
    }),
  ).toBe("The runner's effective configuration does not have the reviewed shape");
});

test("an inspection reporting a version other than the pin is drift", () => {
  expect(
    describeGrokConfigurationDrift({
      inspection: { ...reviewed, grokVersion: "1.0.14" },
      pin,
      runRequirementsPath,
    }),
  ).toBe("The runner reports version 1.0.14 rather than the reviewed 1.0.13");
});
