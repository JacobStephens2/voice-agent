import { expect, test } from "vitest";

import {
  describeSatisfiedKeeploreSourceCommit,
  findSatisfiedKeeploreSourceCommit,
  type KeeploreSourceCommitWalk,
} from "../src/keeplore-satisfied-source-commit.ts";
import { registeredTableOnlySelector } from "../src/keeplore-table-only-candidate.ts";

const withoutRule = "button.untrack-btn {\n  min-height: 2rem;\n}\n";
const registeredRule = `${registeredTableOnlySelector} {\n  min-height: 2rem;\n  white-space: nowrap;\n}`;
const withRule = `${withoutRule}${registeredRule}\n`;

const merged = "4cc29d1debf154fb5becf383e3130b1366e71a31";
const introduced = "4a08fe1000000000000000000000000000000000";
const beforeRule = "82fccd682db9f3ed40f91c56b7577bc6cbcff8ff";

const stylesheets = new Map([
  [merged, withRule],
  [introduced, withRule],
  [beforeRule, withoutRule],
]);

function readStylesheet(commit: string): Promise<string> {
  const stylesheet = stylesheets.get(commit);
  if (stylesheet === undefined) throw new Error(`no stylesheet for ${commit}`);
  return Promise.resolve(stylesheet);
}

function walk(
  overrides: Partial<KeeploreSourceCommitWalk> = {},
): KeeploreSourceCommitWalk {
  return { ancestors: [], readStylesheet, sourceCommit: merged, ...overrides };
}

test("a source commit that still lacks the rule runs the Delegation unchanged", async () => {
  await expect(
    findSatisfiedKeeploreSourceCommit(walk({ sourceCommit: beforeRule })),
  ).resolves.toBeNull();
});

test("a source commit that already carries the rule is refused before the call", async () => {
  await expect(
    findSatisfiedKeeploreSourceCommit(
      walk({ ancestors: [introduced, beforeRule] }),
    ),
  ).resolves.toEqual({
    rule: registeredRule,
    runnableAncestor: beforeRule,
    sourceCommit: merged,
  });
});

test("no walked ancestor lacking the rule leaves the refusal without a suggestion", async () => {
  await expect(
    findSatisfiedKeeploreSourceCommit(walk({ ancestors: [introduced] })),
  ).resolves.toMatchObject({ runnableAncestor: null });
});

test("a trailing rule outside the registered control does not satisfy the Brief", async () => {
  await expect(
    findSatisfiedKeeploreSourceCommit(
      walk({
        readStylesheet: () =>
          Promise.resolve(
            `${withoutRule}button.get-rid-of-btn { white-space: nowrap; }\n`,
          ),
      }),
    ),
  ).resolves.toBeNull();
});

test("an ancestor whose stylesheet cannot be read is passed over, not fatal", async () => {
  await expect(
    findSatisfiedKeeploreSourceCommit(
      walk({ ancestors: ["0".repeat(40), beforeRule] }),
    ),
  ).resolves.toMatchObject({ runnableAncestor: beforeRule });
});

test("the refusal names the commit, the rule it carries, and where to go instead", () => {
  const refusal = describeSatisfiedKeeploreSourceCommit({
    rule: registeredRule,
    runnableAncestor: beforeRule,
    sourceCommit: merged,
  });

  expect(refusal).toContain(merged);
  expect(refusal).toContain(registeredRule);
  expect(refusal).toContain(beforeRule);
});

test("a refusal with no runnable ancestor says so instead of naming one", () => {
  const refusal = describeSatisfiedKeeploreSourceCommit({
    rule: registeredRule,
    runnableAncestor: null,
    sourceCommit: merged,
  });

  expect(refusal).toContain("no walked ancestor");
  expect(refusal).toContain(merged);
});
