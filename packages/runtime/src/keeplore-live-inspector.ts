import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  keeploreLiveInspectionSchema,
  type KeeploreLiveInspection,
} from "@voice-agent/contracts";

import type { KeeploreLiveInspector } from "./keeplore-onboarding.ts";

const run = promisify(execFile);

/**
 * Revalidates the live Keeplore checkout with read-only Git plumbing. It never
 * fetches, checks out, stashes, or writes, so the owner's uncommitted work is
 * observed rather than touched.
 */
export function createNodeKeeploreLiveInspector(options: {
  readonly documentRoots: { readonly api: string; readonly ui: string };
  readonly liveCheckoutPath: string;
  readonly now: () => string;
  readonly sharedPaths: readonly string[];
  readonly verificationCommands: readonly string[];
}): KeeploreLiveInspector {
  async function git(...args: readonly string[]): Promise<string> {
    const { stdout } = await run(
      "git",
      ["--no-optional-locks", "-C", options.liveCheckoutPath, ...args],
      {
        encoding: "utf8",
        maxBuffer: 1_000_000,
      },
    );
    return stdout.trim();
  }

  return {
    async inspect(): Promise<KeeploreLiveInspection> {
      const [headCommit, branch, status] = await Promise.all([
        git("rev-parse", "HEAD"),
        git("rev-parse", "--abbrev-ref", "HEAD"),
        git("status", "--porcelain"),
      ]);
      if (branch !== "main") {
        throw new Error(
          `The live Keeplore checkout is on ${branch}, not the registered production branch`,
        );
      }
      const uncommittedPaths = status
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter((path) => path.length > 0)
        .slice(0, 200);
      return keeploreLiveInspectionSchema.parse({
        accessMode: "read-only",
        documentRoots: options.documentRoots,
        headCommit,
        inspectedAt: options.now(),
        liveCheckoutPath: options.liveCheckoutPath,
        productionBranch: "main",
        repository: "JacobStephens2/artifact-manager",
        servingEdge: "apache",
        sharedPaths: [...options.sharedPaths],
        uncommittedPaths,
        verificationCommands: [...options.verificationCommands],
      });
    },
  };
}
