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
 * Say whether the reviewed sandbox profile is the one that will be in force.
 *
 * This deliberately does not require the profile to deny the boundary stores
 * above. Denying them was tried on the Agent Host and makes the runner refuse
 * to start: after entering Bubblewrap it re-opens every read-deny path to
 * confirm the mask took effect, and a path the executor identity cannot open
 * at all answers `Permission denied`, which it reads as an unenforced deny
 * list. Every store in the boundary is root-owned or 0700 for exactly the
 * reason it is in the boundary, so listing them turns a defence-in-depth layer
 * into a runner that never runs.
 *
 * Custody is therefore held where it is enforceable - the executor identity's
 * own permissions, and the systemd unit's InaccessiblePaths - and this profile
 * holds workspace confinement. `restrict_network` is unavailable on this host
 * for the same reason; see issue #161.
 */
export function describeSandboxProfileDrift(
  profileText: string,
): string | null {
  if (!profileText.includes(`[profiles.${grokSandboxProfile}]`)) {
    return `The reviewed sandbox profile ${grokSandboxProfile} is not defined`;
  }
  if (!/extends\s*=\s*"workspace"/u.test(profileText)) {
    return "The reviewed sandbox profile does not extend the workspace base";
  }
  if (
    /^\s*deny\s*=/mu.test(profileText) ||
    /^\s*restrict_network\s*=/mu.test(profileText)
  ) {
    // A future edit that adds either would be discovered as every Delegation
    // failing to start, which is a worse way to learn it than this sentence.
    return "The reviewed sandbox profile declares deny rules the runner cannot enforce on this host";
  }
  return null;
}
