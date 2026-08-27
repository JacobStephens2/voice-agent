import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);
const inspector = join(
  repositoryRoot,
  "apps/worker/src/keeplore-source-commit-inspect.ts",
);
const withoutRule = "button.untrack-btn {\n  min-height: 2rem;\n}\n";
const registeredRule =
  "table#useBy:not(.cards-view) td.get-rid-of button.get-rid-of-btn {\n  min-height: 2rem;\n  white-space: nowrap;\n}";

/**
 * A Keeplore source mirror whose newest commit appends the Brief's rule, the
 * shape `refs/remotes/origin/main` has carried since Keeplore PR #4 merged.
 */
async function mirrorCarryingTheRule(): Promise<{
  readonly directory: string;
  readonly mirror: string;
  readonly satisfied: string;
  readonly unsatisfied: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-source-"));
  const git = async (...args: readonly string[]): Promise<string> =>
    (await execFileAsync("git", ["-C", directory, ...args])).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "trial@localhost");
  await git("config", "user.name", "Keeplore Trial");
  await mkdir(join(directory, "ui"));
  await writeFile(join(directory, "ui/style.css"), withoutRule);
  await git("add", "--", "ui/style.css");
  await git("commit", "-m", "Add the Keeplore stylesheet");
  const unsatisfied = await git("rev-parse", "HEAD");
  await writeFile(
    join(directory, "ui/style.css"),
    `${withoutRule}${registeredRule}\n`,
  );
  await git(
    "commit",
    "-m",
    "Match Keeplore table action controls",
    "--",
    "ui/style.css",
  );
  return {
    directory,
    mirror: join(directory, ".git"),
    satisfied: await git("rev-parse", "HEAD"),
    unsatisfied,
  };
}

test("the trial refuses a source commit that already carries the Brief's rule", async () => {
  const source = await mirrorCarryingTheRule();
  try {
    const refusal = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", inspector],
      {
        env: {
          ...process.env,
          KEEPLORE_SOURCE_COMMIT: source.satisfied,
          KEEPLORE_SOURCE_MIRROR: source.mirror,
        },
      },
    ).then(
      () => null,
      (error: { readonly stderr: string }) => error.stderr,
    );

    expect(refusal).not.toBeNull();
    expect(refusal).toContain(source.satisfied);
    expect(refusal).toContain(registeredRule);
    expect(refusal).toContain(source.unsatisfied);
  } finally {
    await rm(source.directory, { force: true, recursive: true });
  }
});

test("a source commit that genuinely lacks the rule is left to run", async () => {
  const source = await mirrorCarryingTheRule();
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", inspector],
      {
        env: {
          ...process.env,
          KEEPLORE_SOURCE_COMMIT: source.unsatisfied,
          KEEPLORE_SOURCE_MIRROR: source.mirror,
        },
      },
    );

    expect(result.stdout).toBe("");
  } finally {
    await rm(source.directory, { force: true, recursive: true });
  }
});

test("a source commit whose stylesheet the mirror cannot produce is refused in a line", async () => {
  const source = await mirrorCarryingTheRule();
  try {
    const refusal = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", inspector],
      {
        env: {
          ...process.env,
          KEEPLORE_SOURCE_COMMIT: "0".repeat(40),
          KEEPLORE_SOURCE_MIRROR: source.mirror,
        },
      },
    ).then(
      () => null,
      (error: { readonly stderr: string }) => error.stderr,
    );

    expect(refusal).toContain("Unable to read ui/style.css");
    expect(refusal).not.toContain("at ChildProcess");
  } finally {
    await rm(source.directory, { force: true, recursive: true });
  }
});

test("the wizard reads the pinned stylesheet before it asks for the telephone call", async () => {
  const trial = await readFile(
    join(repositoryRoot, "ops/acceptance/run-keeplore-button-trial.sh"),
    "utf8",
  );

  expect(trial).toContain("keeplore-source-commit-inspect.ts");
  expect(trial.indexOf("keeplore-source-commit-inspect.ts")).toBeLessThan(
    trial.indexOf("Call the registered Voice Agent telephone"),
  );
  // The refusal must also precede the restart that hands the pinned commit to
  // the Subagent, so a refused trial changes no service state.
  expect(trial.indexOf("keeplore-source-commit-inspect.ts")).toBeLessThan(
    trial.indexOf("voice-agent-subagent.service voice-agent-worker.service"),
  );
});
