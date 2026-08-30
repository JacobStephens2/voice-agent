import { grokSandboxProfile } from "@voice-agent/contracts";

/**
 * The host stores a model process may never read.
 *
 * ADR-0048 broadened what a Code Subagent may see - every repository on the
 * Agent Host, including repository-contained secrets - without broadening
 * this. These are the stores whose contents are reusable host authority
 * rather than source: the provider's own OAuth refresh credential, the token
 * helper's socket, the brokers, the publisher, the evidence store, and root's
 * and the Voice Agent's own state. Everything here is reachable only through
 * a typed broker.
 *
 * The list is used twice: the fixed executor refuses to stage a run inside any
 * of these, and the reviewed sandbox profile denies them to model-selected
 * tools. The parent runner still reads its own root-managed configuration
 * before the sandbox exists; the deny rules apply to what the model runs.
 */
export const credentialCustodyBoundaryPaths = [
  "/etc/ssh",
  "/etc/voice-agent",
  "/home",
  "/root",
  "/run/voice-agent-broker",
  "/run/voice-agent-grok-auth",
  "/run/voice-agent-keeplore-publisher",
  "/run/voice-agent-subagent",
  "/usr/local/libexec/voice-agent",
  "/var/lib/voice-agent",
  "/var/lib/voice-agent-broker",
  "/var/lib/voice-agent-evidence",
  "/var/lib/voice-codex",
  "/var/lib/voice-grok-auth",
] as const;

/**
 * Refuse to place a run's own files inside a store the model may not read.
 *
 * A prompt file, ephemeral home, or Delegation root staged inside the boundary
 * would either be unreadable to the model or would drag the boundary open to
 * reach it. Both are defects in the executor, so this throws before a process
 * is spawned rather than relying on the sandbox to catch it.
 */
export function assertOutsideCredentialCustody(
  path: string,
  subject: string,
): void {
  for (const boundary of credentialCustodyBoundaryPaths) {
    if (path === boundary || path.startsWith(`${boundary}/`)) {
      throw new Error(`${subject} is inside the Credential Custody Boundary`);
    }
  }
}

/**
 * Say which boundary stores the reviewed sandbox profile stopped denying.
 *
 * The profile lives in root-managed configuration, which `grok inspect` names
 * but does not quote back: a profile that silently lost a deny rule would
 * still pass every other drift check. So the executor reads the configuration
 * it just proved the runner is using and re-derives this list from the
 * boundary itself. A store added here without being added there fails closed
 * on the next run rather than at the next review.
 */
export function describeMissingCustodyDenyRules(
  configurationText: string,
): string | null {
  const missing = credentialCustodyBoundaryPaths.filter(
    (path) => !configurationText.includes(`"${path}/**"`),
  );
  if (missing.length > 0) {
    return `The reviewed sandbox profile does not deny ${missing.join(", ")}`;
  }
  if (!/restrict_network\s*=\s*true/u.test(configurationText)) {
    return "The reviewed sandbox profile does not restrict child-process network";
  }
  if (!configurationText.includes(`[sandbox.profiles.${grokSandboxProfile}]`)) {
    return `The reviewed sandbox profile ${grokSandboxProfile} is not defined`;
  }
  return null;
}
