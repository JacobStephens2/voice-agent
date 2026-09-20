import {
  credentialCustodyBoundaryPaths,
  grokSandboxProfile,
} from "@voice-agent/contracts";

export { credentialCustodyBoundaryPaths } from "@voice-agent/contracts";

/**
 * Refuse to place a run's own files inside a store the model may not read.
 *
 * A prompt file, ephemeral home, or Delegation root staged inside the boundary
 * would either be unreadable to the model or would drag the boundary open to
 * reach it. Both are defects in the executor, so this throws before a process
 * is spawned rather than relying on the sandbox to catch it. The Auth Crossing
 * directory is not in this list: it is crossing code, not a store.
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
 * This deliberately does not require the profile to deny credential stores or
 * the Auth Crossing. Denying paths was tried on the Agent Host and makes the
 * runner refuse to start: after entering Bubblewrap it re-opens every
 * read-deny path to confirm the mask took effect, and a path the executor
 * identity cannot open at all answers `Permission denied`, which it reads as
 * an unenforced deny list. A Grok `deny` list is therefore not the
 * parent/child split: Bubblewrap children are denied the crossing by the
 * unpriv_bwrap AppArmor overlay instead.
 *
 * This profile holds workspace confinement. Child-process network restriction
 * remains tracked by issue #161.
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
  const lines = significantLines(input.layerText);
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

/**
 * Say whether the host-wide requirements layer still holds the API-key refusal.
 *
 * `loginPolicy.apiKeyAuthDisabled` is the one boundary in this contract the
 * runner itself reports rather than one this repository asserts about its own
 * process, and it is resolved from this file: `disable_api_key_auth` is a
 * `pin`-scoped key, so no user layer, environment variable, or Delegation root
 * can turn it back off. Issue #167 established that it is host-configurable
 * and not an account setting; `docs/research/grok-login-policy-api-key-auth.md`
 * records how.
 *
 * The second claim is the one that was previously held by the absence of the
 * whole `[auth]` table. That table is an alias of `[grok_com_config]`, which
 * this layer now carries for the refusal above, so a host-wide
 * `auth_provider_command` would reach the runner under a heading the old check
 * read as safe - and it would bind the custody identity too, sending the one
 * identity that can renew the six-hour login to the broker that reads it.
 * ADR-0069 stages that crossing into each run's own home instead, and this
 * refuses it here by name rather than by table.
 */
export function describeSystemRequirementsDrift(
  layerText: string,
): string | null {
  const lines = significantLines(layerText);
  // Refused by name anywhere in the file rather than by where the key sits,
  // because TOML has more spellings for a key than a line-oriented reader has:
  // an inline table, a quoted key, a sub-table. The word has no legitimate use
  // in this layer at all, so its presence is the whole test.
  if (lines.join("\n").includes("auth_provider_command")) {
    return "The pinned requirements layer names an auth provider command";
  }
  let table = "";
  let refusalPinned = false;
  for (const line of lines) {
    const heading = /^\[([^\]]+)\]$/u.exec(line);
    if (heading !== null) {
      table = heading[1]?.trim() ?? "";
      continue;
    }
    const [key = "", ...rest] = line.split("=");
    // Qualified so a dotted key written at the top level reads the same as one
    // written under its table heading; both reach the runner.
    const name = [table, key.trim()].filter((part) => part.length > 0).join(".");
    if (/^(?:auth|grok_com_config)\.disable_api_key_auth$/u.test(name)) {
      // Last write wins, as the runner resolves it. A file that turns the
      // refusal on and then off again has not pinned it.
      refusalPinned = rest.join("=").trim() === "true";
    }
  }
  if (!refusalPinned) {
    return "The pinned requirements layer does not pin disable_api_key_auth";
  }
  return null;
}

/** A configuration layer's lines, without comments, blanks, or indentation. */
function significantLines(layerText: string): readonly string[] {
  return layerText
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter((line) => line.length > 0);
}
