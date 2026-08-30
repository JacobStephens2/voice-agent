import {
  grokSandboxProfile,
  type GrokRunnerPin,
} from "@voice-agent/contracts";
import { z } from "zod";

/**
 * What `grok inspect --json` actually emits.
 *
 * Every field here was observed from the pinned binary rather than taken from
 * documentation. The report struct is camelCase, and the fields an earlier
 * version of this check read - `auto_update`, `authentication`, `model`,
 * `approval`, `sandbox` - have no counterpart at any spelling. Those
 * boundaries are held elsewhere and are named where they are held, rather than
 * being checked against keys that were never going to appear.
 *
 * `configWarnings` and `mcpConfigProblems` are serialized only when non-empty,
 * so their presence is itself the finding.
 */
const inspectionSchema = z
  .object({
    agents: z.array(
      z
        .object({
          name: z.string().min(1).max(200),
          source: z.object({ type: z.string().min(1).max(60) }).loose(),
        })
        .loose(),
    ),
    channel: z.string().min(1).max(60),
    configSources: z.object({
      layers: z.array(
        z
          .object({
            note: z.string().max(200).optional(),
            path: z.string().min(1).max(500),
            role: z.string().min(1).max(60),
          })
          .loose(),
      ),
    }),
    configWarnings: z.array(z.unknown()).optional(),
    externalCompat: z
      .object({
        cells: z.array(
          z
            .object({
              enabled: z.boolean(),
              surface: z.string().min(1).max(60),
              vendor: z.string().min(1).max(60),
            })
            .loose(),
        ),
      })
      .loose(),
    grokVersion: z.string().min(1).max(60),
    hooks: z.array(z.unknown()),
    loginPolicy: z
      .object({ apiKeyAuthDisabled: z.boolean() })
      .loose(),
    lspServers: z.array(z.unknown()),
    marketplaces: z.array(z.unknown()),
    mcpConfigProblems: z.array(z.unknown()).optional(),
    mcpServers: z.array(z.unknown()),
    permissions: z
      .object({
        managedSettingsActive: z.boolean(),
        managedSettingsPath: z.string().min(1).max(500),
      })
      .loose(),
    plugins: z.array(z.unknown()),
    skills: z.array(z.unknown()),
  })
  .loose();

/** The inspection a runner pinned to `pin` must report to be accepted. */
export function reviewedGrokInspection(pin: GrokRunnerPin): Record<string, unknown> {
  return {
    agents: [{ name: "general-purpose", source: { type: "builtin" } }],
    channel: "unknown",
    configSources: {
      layers: [{ path: pin.configurationPath, role: "requirements" }],
    },
    externalCompat: { cells: [] },
    grokVersion: pin.version,
    hooks: [],
    loginPolicy: { apiKeyAuthDisabled: true },
    lspServers: [],
    marketplaces: [],
    mcpServers: [],
    permissions: {
      managedSettingsActive: false,
      managedSettingsPath: "/etc/claude-code/managed-settings.json",
    },
    plugins: [],
    skills: [],
  };
}

/**
 * Say how the binary about to run differs from the reviewed one, if it does.
 *
 * The version is the runner's claim about itself and the digest is the only
 * statement about the bytes, so both are checked. xAI publishes no checksum
 * for its artifacts, so the digest attests only that the runner has not
 * changed since it was reviewed on this host - which is precisely the drift
 * self-update would otherwise introduce.
 */
export function describeGrokRunnerDrift(input: {
  readonly observedDigest: string;
  readonly observedVersionOutput: string;
  readonly pin: GrokRunnerPin;
}): string | null {
  const reported = /\b\d+\.\d+\.\d+\b/u.exec(input.observedVersionOutput)?.[0];
  if (reported === undefined) return "The runner did not report a version";
  if (reported !== input.pin.version) {
    return `The runner reports version ${reported} rather than the reviewed ${input.pin.version}`;
  }
  if (input.observedDigest !== input.pin.digest) {
    return "The runner binary does not match the reviewed digest";
  }
  return null;
}

/**
 * Say how the runner's effective configuration differs from the reviewed one.
 *
 * Only things this inspection actually reports are checked here. The model
 * selector, always-approve, the turn bound, and the sandbox profile are fixed
 * on the command line by `buildGrokInvocation`, where they cannot be edited by
 * a project directory; checking them against an inspection that never carried
 * them would have looked like enforcement while being none.
 */
export function describeGrokConfigurationDrift(input: {
  readonly inspection: unknown;
  readonly pin: GrokRunnerPin;
}): string | null {
  const parsed = inspectionSchema.safeParse(input.inspection);
  if (!parsed.success) {
    return "The runner's effective configuration does not have the reviewed shape";
  }
  const inspection = parsed.data;
  if (inspection.grokVersion !== input.pin.version) {
    return `The runner reports version ${inspection.grokVersion} rather than the reviewed ${input.pin.version}`;
  }
  // The requirements layer is the one a project directory cannot override, so
  // it is the only layer that can carry a boundary. A user or managed layer
  // that is actually in effect is configuration this contract never reviewed.
  const effective = inspection.configSources.layers.filter(
    (layer) => layer.note !== "empty",
  );
  const requirements = effective.filter((layer) => layer.role === "requirements");
  if (requirements.length !== 1 || requirements[0]?.path !== input.pin.configurationPath) {
    return `No reviewed requirements layer is in effect at ${input.pin.configurationPath}`;
  }
  if (effective.length !== requirements.length) {
    return "Effective configuration includes a layer outside the reviewed requirements";
  }
  // The subscription is the only route this MVP may use. This is the one place
  // the runner itself reports on that, and it reports policy rather than the
  // absence of a key in one process's environment.
  if (!inspection.loginPolicy.apiKeyAuthDisabled) {
    return "API key authentication is not disabled by policy";
  }
  if (inspection.permissions.managedSettingsActive) {
    return "Managed settings outside the reviewed requirements are active";
  }
  for (const [name, entries] of [
    ["MCP servers", inspection.mcpServers],
    ["plugins", inspection.plugins],
    ["skills", inspection.skills],
    ["hooks", inspection.hooks],
    ["marketplaces", inspection.marketplaces],
    ["LSP servers", inspection.lspServers],
  ] as const) {
    if (entries.length > 0) return `Effective configuration declares ${name}`;
  }
  const foreign = inspection.agents.filter(
    (agent) => agent.source.type !== "builtin",
  );
  if (foreign.length > 0) {
    return "Effective configuration declares agents outside the runner's own";
  }
  // A repository that ships `.claude/skills` or `.cursor/rules` would be read
  // as instruction by default. Repository content is data in this contract.
  const vendors = inspection.externalCompat.cells.filter((cell) => cell.enabled);
  if (vendors.length > 0) {
    return `Effective configuration reads third-party ${vendors[0]?.vendor} ${vendors[0]?.surface}`;
  }
  if (
    (inspection.configWarnings?.length ?? 0) > 0 ||
    (inspection.mcpConfigProblems?.length ?? 0) > 0
  ) {
    return "The runner reported configuration warnings";
  }
  return null;
}

/** The sandbox profile name the invocation names on the command line. */
export const reviewedSandboxProfile = grokSandboxProfile;
