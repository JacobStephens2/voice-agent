import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  keeploreLiveInspectionSchema,
  type KeeploreLiveInspection,
} from "@voice-agent/contracts";

import type { KeeploreLiveInspector } from "./keeplore-onboarding.ts";

const run = promisify(execFile);

/** `https://github.com/owner/name.git` and `git@github.com:owner/name.git` alike. */
function readRepositoryFromRemote(remoteUrl: string): string {
  const match = /(?:[/:])([^/:]+\/[^/]+?)(?:\.git)?$/u.exec(remoteUrl.trim());
  return match?.[1] ?? remoteUrl.trim();
}

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
      [
        "--no-optional-locks",
        // The live checkout belongs to the account that serves it, not to the
        // Voice Agent, so Git calls it dubiously owned and refuses to read it.
        // The path comes from the root-owned registration this process cannot
        // write, so trusting exactly it widens nothing.
        "-c",
        `safe.directory=${options.liveCheckoutPath}`,
        "-c",
        "protocol.allow=never",
        "-C",
        options.liveCheckoutPath,
        ...args,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1_000_000,
      },
    );
    return stdout;
  }

  /** For the single-value reads; porcelain output must keep its own layout. */
  async function gitValue(...args: readonly string[]): Promise<string> {
    return (await git(...args)).trim();
  }

  return {
    async inspect(): Promise<KeeploreLiveInspection> {
      const [headCommit, branch, remoteUrl, status] = await Promise.all([
        gitValue("rev-parse", "HEAD"),
        gitValue("rev-parse", "--abbrev-ref", "HEAD"),
        gitValue("remote", "get-url", "origin"),
        // Not trimmed: porcelain encodes the index and worktree states in the
        // first two columns, and an unstaged change leads with a space that
        // trimming would eat -- taking the first character of the path with it.
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
        remoteRepository: readRepositoryFromRemote(remoteUrl),
        repository: "JacobStephens2/keeplore",
        servingEdge: "apache",
        sharedPaths: [...options.sharedPaths],
        uncommittedPaths,
        verificationCommands: [...options.verificationCommands],
      });
    },
  };
}
