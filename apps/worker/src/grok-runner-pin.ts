import {
  grokModelSelector,
  grokSandboxProfile,
  type GrokRunnerPin,
} from "@voice-agent/contracts";
import { z } from "zod";

/**
 * The effective configuration a run is accepted against.
 *
 * These field names, and the configuration path the runner reads, are the ones
 * the enrollment ceremony confirmed against the pinned runner's own `inspect`
 * output; both are recorded in the Runner Pin the proof belongs to. The
 * schema is strict about presence rather than tolerant: a runner whose
 * inspection this contract cannot read is a runner whose boundaries it cannot
 * check, which is a pause, not a run.
 */
const inspectionSchema = z
  .object({
    approval: z.object({ always_approve: z.boolean() }),
    authentication: z.object({
      api_key_present: z.boolean(),
      source: z.string().min(1).max(60),
    }),
    auto_update: z.object({ enabled: z.boolean() }),
    config_sources: z.array(z.string().min(1).max(500)),
    mcp_servers: z.array(z.string().min(1).max(200)),
    model: z.object({ default: z.string().min(1).max(120) }),
    plugins: z.array(z.string().min(1).max(200)),
    sandbox: z.object({ profile: z.string().min(1).max(120) }),
    skills: z.array(z.string().min(1).max(500)),
    version: z.string().min(1).max(60),
  })
  .loose();

/** The inspection a runner pinned to `pin` must report to be accepted. */
export function reviewedGrokInspection(pin: GrokRunnerPin): Record<string, unknown> {
  return {
    approval: { always_approve: true },
    authentication: { api_key_present: false, source: "oauth" },
    auto_update: { enabled: false },
    config_sources: [pin.configurationPath],
    mcp_servers: [],
    model: { default: grokModelSelector },
    plugins: [],
    sandbox: { profile: grokSandboxProfile },
    skills: [],
    version: pin.version,
  };
}

/**
 * Say how the binary about to run differs from the reviewed one, if it does.
 *
 * The version is the runner's claim about itself and the digest is the only
 * statement about the bytes, so both are checked. A runner that reports no
 * version at all is drift rather than a pass: this check exists precisely for
 * the case where the runner is not what the contract was proved against.
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
 * Self-update, the authentication route, the model selector, the sandbox
 * profile, and the set of configuration sources are all things a project
 * directory or a provider release could change under an unchanged binary, so
 * they are re-read before every accepted run rather than trusted from
 * enrollment.
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
  if (inspection.version !== input.pin.version) {
    return `The runner reports version ${inspection.version} rather than the reviewed ${input.pin.version}`;
  }
  if (inspection.auto_update.enabled) return "Runner self-update is enabled";
  if (inspection.authentication.api_key_present) {
    return "An xAI API key is available to the runner";
  }
  if (inspection.authentication.source !== "oauth") {
    return `The runner authenticates through ${inspection.authentication.source} rather than the subscription`;
  }
  if (inspection.model.default !== grokModelSelector) {
    return `The default model selector is ${inspection.model.default} rather than ${grokModelSelector}`;
  }
  if (!inspection.approval.always_approve) {
    return "Always-approve mode is not in effect";
  }
  if (inspection.sandbox.profile !== grokSandboxProfile) {
    return `The sandbox profile is ${inspection.sandbox.profile} rather than ${grokSandboxProfile}`;
  }
  if (
    inspection.config_sources.length !== 1 ||
    inspection.config_sources[0] !== input.pin.configurationPath
  ) {
    return `Effective configuration is read from a source outside ${input.pin.configurationPath}`;
  }
  if (
    inspection.mcp_servers.length > 0 ||
    inspection.plugins.length > 0 ||
    inspection.skills.length > 0
  ) {
    return "Effective configuration declares MCP servers, plugins, or skills";
  }
  return null;
}
