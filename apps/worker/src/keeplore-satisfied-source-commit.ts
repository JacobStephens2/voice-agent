/**
 * Find a registered Keeplore source commit that already satisfies the Brief.
 *
 * The Brief asks restricted Codex to append one scoped rule to `ui/style.css`,
 * and the trial accepts a candidate only as the registered stylesheet plus that
 * appended rule. A source commit whose stylesheet already ends with the rule
 * therefore leaves the model nothing to append and no candidate that can pass:
 * the run is lost by construction, after a telephone call, a Codex run, and an
 * operator's review. This settles that from the stylesheet alone, before the
 * call, and names an ancestor that would still exercise the change.
 */
import { readTrailingTableOnlyRule } from "./keeplore-table-only-candidate.ts";

export interface KeeploreSourceCommitWalk {
  /**
   * Commits that touched `ui/style.css`, newest first, walked to find the most
   * recent one whose stylesheet does not end with the registered rule. The
   * caller decides how far back and along which parent this reaches; the
   * verdict names only a commit this list actually offered.
   */
  readonly ancestors: readonly string[];
  readonly readStylesheet: (commit: string) => Promise<string>;
  readonly sourceCommit: string;
}

/** A source commit the trial cannot win, and the nearest one it could. */
export interface SatisfiedKeeploreSourceCommit {
  readonly rule: string;
  readonly runnableAncestor: string | null;
  readonly sourceCommit: string;
}

/** The verdict, or `null` when the trial should run against this commit unchanged. */
export async function findSatisfiedKeeploreSourceCommit(
  walk: KeeploreSourceCommitWalk,
): Promise<SatisfiedKeeploreSourceCommit | null> {
  const rule = readTrailingTableOnlyRule(
    await walk.readStylesheet(walk.sourceCommit),
  );
  if (rule === null) return null;
  return {
    rule,
    runnableAncestor: await findRunnableAncestor(walk),
    sourceCommit: walk.sourceCommit,
  };
}

/** The refusal an operator reads at the wizard, before it asks for the call. */
export function describeSatisfiedKeeploreSourceCommit(
  satisfied: SatisfiedKeeploreSourceCommit,
): string {
  return [
    `The registered Keeplore source commit ${satisfied.sourceCommit} already carries the rule the Brief asks restricted Codex to append, so no candidate it can produce would pass.`,
    "",
    satisfied.rule,
    "",
    satisfied.runnableAncestor === null
      ? `Refusing before the telephone call: no walked ancestor of ${satisfied.sourceCommit} that touched ui/style.css ends without that rule, so register a source commit from before it was merged.`
      : `Refusing before the telephone call. Register ${satisfied.runnableAncestor} instead - the newest walked ancestor whose ui/style.css does not end with that rule.`,
  ].join("\n");
}

/**
 * The newest walked ancestor whose stylesheet does not end with the rule. One
 * whose stylesheet cannot be read - the file did not exist yet, or the object
 * is absent from the mirror - is passed over rather than ending the walk, so a
 * single unreadable revision cannot cost the operator the suggestion.
 */
async function findRunnableAncestor(
  walk: KeeploreSourceCommitWalk,
): Promise<string | null> {
  for (const ancestor of walk.ancestors) {
    if (ancestor === walk.sourceCommit) continue;
    let stylesheet: string;
    try {
      stylesheet = await walk.readStylesheet(ancestor);
    } catch {
      continue;
    }
    if (readTrailingTableOnlyRule(stylesheet) === null) return ancestor;
  }
  return null;
}
