import {
  credentialCustodyBoundaryPaths,
  grokSandboxProfile,
} from "@voice-agent/contracts";

export { credentialCustodyBoundaryPaths } from "@voice-agent/contracts";

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

/**
 * Say whether the auth crossing staged for this run is the reviewed one.
 *
 * The crossing is named in the run's own Grok home rather than in the host's
 * requirements layer, because a host-wide auth provider would also bind the
 * custody identity - and the runner prefers a provider command over renewing
 * an expired cached login, so the one identity that can renew the credential
 * would be sent to the broker that reads it instead. See ADR-0069.
 *
 * The layer this stages outranks a Delegation root's own `.grok/config.toml`,
 * which is why it must carry the crossing and nothing else: any other setting
 * here would be policy that reached the runner without being reviewed as
 * policy.
 */
export function describeAuthProviderDrift(input: {
  readonly brokerPath: string;
  readonly layerText: string;
}): string | null {
  const lines = input.layerText
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter((line) => line.length > 0);
  if (lines[0] !== "[auth]") {
    return "The staged auth layer does not open with the auth table";
  }
  if (lines[1] !== `auth_provider_command = "${input.brokerPath}"`) {
    return "The staged auth layer does not name the reviewed token broker";
  }
  if (lines.length !== 2) {
    return "The staged auth layer declares settings outside the token crossing";
  }
  return null;
}
