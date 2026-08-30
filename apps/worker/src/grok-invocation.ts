import {
  grokModelSelector,
  grokSandboxProfile,
} from "@voice-agent/contracts";

import { assertOutsideCredentialCustody } from "./grok-credential-custody.ts";

export interface GrokInvocation {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface GrokInvocationInput {
  /** The Delegation Brief, written where the runner can read it as a file. */
  readonly briefFilePath: string;
  /** The staged root holding every worktree this run may reach. */
  readonly delegationRoot: string;
  /** A per-run Grok home, removed after evidence is extracted. */
  readonly ephemeralHome: string;
  readonly maxTurns: number;
  /** The reviewed result schema, as JSON. The runner takes it inline. */
  readonly resultSchema: string;
  readonly sourceEnvironment: Readonly<Record<string, string | undefined>>;
}

/**
 * Build the one command that runs a model, and the environment it sees.
 *
 * Every argument is fixed here rather than composed from a brief: the model
 * chooses what to do inside the Delegation root, never which model, which
 * schema, which approval mode, or how long it may run. The Delegation Brief
 * reaches it as a file because headless mode does not read a piped one, and
 * because a brief on a command line would be readable to every process on the
 * host.
 */
export function buildGrokInvocation(input: GrokInvocationInput): GrokInvocation {
  if (input.sourceEnvironment.XAI_API_KEY !== undefined) {
    // Stripping it would be enough for this run and wrong for the system: an
    // API key on this identity means the metered route was provisioned
    // somewhere, and the MVP's whole claim is that it cannot be reached.
    throw new Error(
      "An xAI API key is present; this provider runs on the subscription alone",
    );
  }
  if (input.sourceEnvironment.GROK_DEPLOYMENT_KEY !== undefined) {
    // xAI's own tooling prefers a deployment key over a cached login, so this
    // is a second route to a credential the owner's subscription did not
    // issue. It is refused for the same reason and not merely stripped.
    throw new Error(
      "A Grok deployment key is present; this provider runs on the subscription alone",
    );
  }
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 50) {
    throw new Error("A Grok run must be bounded by between 1 and 50 turns");
  }
  assertAbsolute(input.delegationRoot, "The Delegation root");
  assertAbsolute(input.ephemeralHome, "The ephemeral Grok home");
  assertAbsolute(input.briefFilePath, "The Delegation Brief");
  assertOutsideCredentialCustody(input.delegationRoot, "The Delegation root");
  assertOutsideCredentialCustody(input.ephemeralHome, "The ephemeral Grok home");
  assertOutsideCredentialCustody(input.briefFilePath, "The Delegation Brief");
  return {
    arguments: [
      "--no-auto-update",
      "--cwd",
      input.delegationRoot,
      "--model",
      grokModelSelector,
      "--prompt-file",
      input.briefFilePath,
      "--output-format",
      "json",
      "--json-schema",
      input.resultSchema,
      "--always-approve",
      "--max-turns",
      String(input.maxTurns),
      "--no-plan",
      "--no-memory",
      "--sandbox",
      grokSandboxProfile,
    ],
    // An allowlist, not a filtered copy. A stripped environment that starts
    // from the service's own keeps whatever the next unit file adds; this one
    // keeps only what a model process needs to run at all.
    environment: {
      GROK_HOME: input.ephemeralHome,
      HOME: input.ephemeralHome,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: `${input.ephemeralHome}/tmp`,
    },
  };
}

function assertAbsolute(path: string, subject: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`${subject} must be an absolute path`);
  }
}
