import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const manifestScript = join(
  repositoryRoot,
  "ops/release/deployment-authority-manifest.sh",
);
const driftScript = join(
  repositoryRoot,
  "ops/release/deployment-authority-drift.sh",
);

/** One reviewed file: where the Release carries it, where a host pins it. */
export interface PinnedAuthorityPath {
  readonly pinnedPath: string;
  readonly sourcePath: string;
}

/**
 * The pinned layout of the reviewed manifest, read from the manifest itself.
 * A fixture standing in for an Agent Host derives its directories from here
 * rather than restating them, because a fixture that restates the layout
 * agrees with a comparison that reads the wrong path.
 */
export async function readPinnedAuthorityPaths(): Promise<
  readonly PinnedAuthorityPath[]
> {
  const { stdout } = await execFileAsync("bash", [
    "-c",
    'set -euo pipefail\nsource "$1"\nvoice_agent_authority_pinned_paths',
    "authority-pinned-paths",
    manifestScript,
  ]);
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [sourcePath = "", pinnedPath = ""] = line.split("\t");
      return { pinnedPath, sourcePath };
    });
}

/**
 * The pinned-relative paths at which one Release tree differs from one pinned
 * authority tree, through the same bash function a Promotion Attempt records
 * from. Both arguments are ordinary directories, so what an owner is told is
 * exercised without root and without `/usr/local/libexec/voice-agent`.
 */
export async function readDeploymentAuthorityDrift(input: {
  readonly pinnedRoot: string;
  readonly releaseRoot: string;
}): Promise<readonly string[]> {
  const { stdout } = await execFileAsync("bash", [
    "-c",
    'set -euo pipefail\nsource "$1"\nvoice_agent_authority_drift_paths "$2" "$3"',
    "authority-drift",
    driftScript,
    input.releaseRoot,
    input.pinnedRoot,
  ]);
  return stdout.length === 0 ? [] : stdout.trimEnd().split("\n");
}
