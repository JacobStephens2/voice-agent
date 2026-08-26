import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const mergeCommit = "3333333333333333333333333333333333333333";
const retainedCommit = "4444444444444444444444444444444444444444";
const olderCommit = "5555555555555555555555555555555555555555";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

/**
 * The step back has to land on the Release the merge actually replaced. The
 * newest other Release on disk is not that, so the answer comes from the
 * append-only journal — including when the journal holds a line the host was
 * still appending.
 */
test("the retained Release a merge replaced is read from the recorded Promotion", async () => {
  const journal = await journalFile([
    attempt({ commit: mergeCommit, previous: olderCommit }),
    "{ truncated line the host is still appending",
    attempt({ commit: olderCommit, previous: retainedCommit }),
    attempt({ commit: mergeCommit, previous: retainedCommit }),
  ]);

  expect(await retainedReleaseCommit(mergeCommit, journal)).toBe(retainedCommit);
});

test("a step back is never mistaken for the Promotion a merge replaced", async () => {
  // The step back's own `previous` is the merge commit itself. Reading it back
  // would step the next re-promotion back onto the Release it is verifying,
  // which is the comparison-against-itself this whole operation exists to
  // avoid.
  const journal = await journalFile([
    attempt({ commit: mergeCommit, previous: retainedCommit }),
    attempt({
      commit: retainedCommit,
      previous: mergeCommit,
      repromotion: { kind: "step-back", mergeCommit },
    }),
    attempt({
      commit: mergeCommit,
      previous: retainedCommit,
      repromotion: { kind: "restore", mergeCommit },
    }),
  ]);

  expect(await retainedReleaseCommit(mergeCommit, journal)).toBe(retainedCommit);
  expect(await retainedReleaseCommit(retainedCommit, journal)).toBe("");
});

test("a merge with no recorded Promotion has nothing to step back to", async () => {
  const journal = await journalFile([
    attempt({ commit: mergeCommit, previous: retainedCommit, result: "failed" }),
    attempt({ commit: mergeCommit, previous: "-" }),
  ]);

  expect(await retainedReleaseCommit(mergeCommit, journal)).toBe("");
});

test("a re-promotion is a separate operation that leaves ordinary Promotion idempotent", async () => {
  const [repromoter, promoter] = await Promise.all([
    readFile(join(repositoryRoot, "ops/keeplore/repromote-keeplore-merge.sh"), "utf8"),
    readFile(join(repositoryRoot, "ops/keeplore/promote-keeplore-main.sh"), "utf8"),
  ]);

  // Ordinary Promotion still returns the recorded result for a duplicate
  // webhook or a reconciliation pass instead of re-verifying anything.
  expect(promoter).toContain("Promotion is idempotent");
  expect(promoter).not.toContain("repromote");
  // The re-promotion refuses everything but a verified Human Merge that is
  // serving now, with a retained Release still on disk to step back to.
  expect(repromoter).toContain("keeplore_verify_human_merge");
  expect(repromoter).toContain("keeplore_retained_release_commit");
  expect(repromoter).toContain("only a merge already serving");
  expect(repromoter).toContain("is no longer on disk");
  // It never edits the serving symlink itself; both moves go through the
  // recorded promoter.
  expect(repromoter).not.toMatch(/\bln -s/u);
  expect(repromoter).toContain("promote-keeplore-release.sh");
  expect(repromoter).toContain("promote-keeplore-main.sh");
  // Every move it makes is labelled, so the journal distinguishes it from a
  // first Promotion of the same commit.
  expect(repromoter).toContain("KEEPLORE_REPROMOTION_KIND=step-back");
  expect(repromoter).toContain("KEEPLORE_REPROMOTION_KIND=candidate");
  expect(repromoter).toContain("KEEPLORE_REPROMOTION_KIND=restore");
  // The window is stated before the run, reserves what the restore that ends a
  // failed run will cost, and is enforced as a deadline the Promotion must
  // switch before — never as a signal that could kill a Promotion mid-switch.
  expect(repromoter).toContain("keeplore_repromotion_window_seconds");
  expect(repromoter).toContain("restore_reserve");
  expect(repromoter).toContain("KEEPLORE_SWITCH_DEADLINE");
  expect(repromoter).not.toContain("timeout --signal");
});

test("the promoter labels a re-promotion's attempts and health-verifies only its safe moves", async () => {
  const promoter = await readFile(
    join(repositoryRoot, "ops/keeplore/promote-keeplore-release.sh"),
    "utf8",
  );

  expect(promoter).toContain('"repromotion":{"kind":"%s","mergeCommit":"%s"}');
  // Stepping back to the retained Release, and restoring the merge commit
  // after a failed candidate, both move production onto a Release that was
  // already promoted; the merge's own acceptance bar would measure the wrong
  // Release and roll production somewhere nobody asked for.
  expect(promoter).toContain("verify_appearance=0");
  // A deadline reached before the switch is a recorded attempt that changed
  // nothing, rather than a Promotion killed somewhere the journal cannot see.
  expect(promoter).toContain("record_attempt failed switch-deadline");
  expect(promoter).toMatch(/KEEPLORE_SWITCH_DEADLINE[\s\S]{0,400}switch_to "\$release"/u);
  expect(promoter).not.toContain("$keeplore_appearance_verification == 1");
  expect(promoter).toContain("$verify_appearance == 1");
});

async function retainedReleaseCommit(
  commit: string,
  journal: string,
): Promise<string> {
  const { stdout } = await execFileAsync("bash", [
    "-c",
    `set -euo pipefail
source "$1"
keeplore_retained_release_commit "$2" "$3"`,
    "keeplore-retained-release",
    join(repositoryRoot, "ops/keeplore/keeplore-config.sh"),
    commit,
    journal,
  ]);
  return stdout.trim();
}

async function journalFile(lines: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-repromotion-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "attempts.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

function attempt(fields: {
  commit: string;
  previous: string;
  repromotion?: { kind: string; mergeCommit: string };
  result?: string;
}): string {
  return JSON.stringify({
    application: "keeplore-production",
    attemptedAt: "2026-08-25T15:05:00Z",
    commit: fields.commit,
    previous: fields.previous,
    ...(fields.repromotion === undefined ? {} : { repromotion: fields.repromotion }),
    result: fields.result ?? "succeeded",
    stage: "promotion",
  });
}
