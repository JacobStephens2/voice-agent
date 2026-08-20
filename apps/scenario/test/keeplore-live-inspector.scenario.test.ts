import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { createNodeKeeploreLiveInspector } from "@voice-agent/runtime";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

/**
 * The live checkout belongs to the account that serves Keeplore, not to the
 * Voice Agent, so Git refuses to read it as "dubious ownership" unless the
 * inspecting account trusts the path. Trusting it per-invocation keeps every
 * account — root, voice-agent, the owner's shell — from needing its own global
 * safe.directory, and `git status` inside a repository Git distrusts fails
 * outright rather than reporting a misleadingly clean tree.
 */
test("the inspector trusts exactly the registered checkout and nothing else", async () => {
  const checkout = await createCheckout();

  // A configuration Git would reject the checkout under, were the path untrusted.
  const inspection = await createNodeKeeploreLiveInspector({
    documentRoots: { api: `${checkout}/api`, ui: `${checkout}/ui` },
    liveCheckoutPath: checkout,
    now: () => "2026-08-20T09:00:00.000Z",
    sharedPaths: ["logs"],
    verificationCommands: ["vendor/bin/phpunit"],
  }).inspect();

  expect(inspection.accessMode).toBe("read-only");
  expect(inspection.repository).toBe("JacobStephens2/keeplore");
  expect(inspection.headCommit).toMatch(/^[0-9a-f]{40}$/u);
  expect(inspection.uncommittedPaths).toEqual([]);
});

test("uncommitted live work is reported rather than resolved", async () => {
  const checkout = await createCheckout();
  await writeFile(join(checkout, "ui", "index.php"), "<?php // edited\n");

  const inspection = await createNodeKeeploreLiveInspector({
    documentRoots: { api: `${checkout}/api`, ui: `${checkout}/ui` },
    liveCheckoutPath: checkout,
    now: () => "2026-08-20T09:00:00.000Z",
    sharedPaths: ["logs"],
    verificationCommands: ["vendor/bin/phpunit"],
  }).inspect();

  expect(inspection.uncommittedPaths).toContain("ui/index.php");
});

async function createCheckout() {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-checkout-"));
  temporaryDirectories.push(directory);
  const git = (...args: readonly string[]) =>
    run("git", ["-C", directory, ...args]);
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "owner@example.invalid");
  await git("config", "user.name", "Owner");
  await git(
    "remote",
    "add",
    "origin",
    "https://github.com/JacobStephens2/keeplore.git",
  );
  await run("mkdir", ["-p", join(directory, "ui"), join(directory, "api")]);
  await writeFile(join(directory, "ui", "index.php"), "<?php\n");
  await git("add", "-A");
  await git("commit", "-m", "Initial Keeplore checkout");
  return directory;
}
