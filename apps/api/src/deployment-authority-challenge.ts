import { open, readFile, stat } from "node:fs/promises";

/**
 * Why a deployment-authority challenge was refused.
 *
 * The routine reasons are ordinary states of an attended ceremony: the owner
 * took longer than the five-minute window, started before the challenge was
 * prepared, or is upgrading while no promoted Release is active. They are the
 * owner's to act on, so each one carries its own message. The remaining
 * reasons describe a challenge file that root should never have left behind,
 * so they stay server faults and disclose nothing to the browser.
 */
export type DeploymentAuthorityChallengeRejection =
  | "challenge-changed"
  | "expired"
  | "malformed"
  | "no-active-release"
  | "not-root-owned"
  | "not-yet-valid"
  | "release-mismatch";

const routineRejections = new Set<DeploymentAuthorityChallengeRejection>([
  "challenge-changed",
  "expired",
  "no-active-release",
  "not-yet-valid",
  "release-mismatch",
]);

export class DeploymentAuthorityChallengeError extends Error {
  readonly reason: DeploymentAuthorityChallengeRejection;

  /** Whether the owner, rather than the operator, can act on this rejection. */
  readonly routine: boolean;

  constructor(reason: DeploymentAuthorityChallengeRejection, message: string) {
    super(message);
    this.name = "DeploymentAuthorityChallengeError";
    this.reason = reason;
    this.routine = routineRejections.has(reason);
  }
}

export interface DeploymentAuthorityChallengePaths {
  readonly activeReleaseMarkerPath: string;
  readonly challengePath: string;
  readonly ownerUid?: number;
  readonly statePath: string;
}

export async function requestDeploymentAuthorityUpgrade(
  paths: DeploymentAuthorityChallengePaths & { readonly requestPath: string },
  authorization: {
    readonly challenge: string;
    readonly commit: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly kind: "authentication" | "enrollment";
    readonly options: unknown;
    readonly response: unknown;
  },
): Promise<string> {
  const challenge = await readDeploymentAuthorityUpgradeChallenge(paths);
  if (
    authorization.commit !== challenge.commit ||
    authorization.challenge !== challenge.challenge ||
    authorization.createdAt !== challenge.createdAt ||
    authorization.expiresAt !== challenge.expiresAt ||
    authorization.kind !== challenge.kind
  ) {
    throw new DeploymentAuthorityChallengeError(
      "challenge-changed",
      "The deployment-authority challenge changed while you authenticated; prepare a new challenge and retry.",
    );
  }
  const contents = `${JSON.stringify({ ...authorization, version: 1 })}\n`;
  await writeNarrowRequest(
    paths.requestPath,
    contents,
    (existing) => existing === contents,
  );
  return challenge.commit;
}

export async function readDeploymentAuthorityUpgradeChallenge(
  paths: DeploymentAuthorityChallengePaths,
): Promise<{
  readonly challenge: string;
  readonly commit: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly kind: "authentication" | "enrollment";
  readonly options: unknown;
}> {
  const state = (await readFile(paths.statePath, "utf8")).trim().split("\t");
  const commit = state[3];
  if (
    state[1] !== "closed" ||
    state[2] !== "-" ||
    commit === undefined ||
    !/^[0-9a-f]{40}$/u.test(commit)
  ) {
    throw new DeploymentAuthorityChallengeError(
      "no-active-release",
      "No successfully promoted Release is active, so there is no deployment authority to upgrade.",
    );
  }
  if (
    (await readFile(paths.activeReleaseMarkerPath, "utf8")).trim() !== commit
  ) {
    throw new DeploymentAuthorityChallengeError(
      "release-mismatch",
      "The active Release does not match Promotion state; complete the Promotion before upgrading deployment authority.",
    );
  }
  const metadata = await stat(paths.challengePath);
  if (
    !metadata.isFile() ||
    metadata.uid !== (paths.ownerUid ?? 0) ||
    (metadata.mode & 0o777) !== 0o640
  ) {
    throw new DeploymentAuthorityChallengeError(
      "not-root-owned",
      "The deployment-authority challenge is not a root-owned 0640 file.",
    );
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(await readFile(paths.challengePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new DeploymentAuthorityChallengeError(
      "malformed",
      "The deployment-authority challenge is not readable JSON.",
    );
  }
  if (
    value.version !== 1 ||
    value.commit !== commit ||
    typeof value.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.challenge) ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    (value.kind !== "authentication" && value.kind !== "enrollment") ||
    value.options === null ||
    typeof value.options !== "object" ||
    !("challenge" in value.options) ||
    value.options.challenge !== value.challenge ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    Number.isNaN(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== 5 * 60 * 1_000
  ) {
    throw new DeploymentAuthorityChallengeError(
      "malformed",
      "The deployment-authority challenge does not describe this Release.",
    );
  }
  // Lifetime is checked after structure so a lapsed window is never reported
  // as a malformed file, and never the other way round.
  if (Date.now() < Date.parse(value.createdAt)) {
    throw new DeploymentAuthorityChallengeError(
      "not-yet-valid",
      "The deployment-authority challenge is not valid yet; wait for the attended terminal to finish preparing it.",
    );
  }
  if (Date.now() >= Date.parse(value.expiresAt)) {
    throw new DeploymentAuthorityChallengeError(
      "expired",
      "The deployment-authority challenge expired; re-run the prepare stage in the attended terminal and authenticate within five minutes.",
    );
  }
  return {
    challenge: value.challenge,
    commit,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    kind: value.kind,
    options: value.options,
  };
}

export async function writeNarrowRequest(
  path: string,
  contents: string,
  acceptsExisting: (contents: string) => boolean,
): Promise<void> {
  try {
    const request = await open(path, "wx", 0o640);
    try {
      await request.writeFile(contents, "utf8");
    } finally {
      await request.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      if (acceptsExisting(await readFile(path, "utf8"))) return;
    } else {
      throw error;
    }
    throw new Error("Narrow request is invalid");
  }
}
