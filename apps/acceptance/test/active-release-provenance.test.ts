import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable } from "@voice-agent/runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await chmod(join(directory, "release"), 0o700).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

test("the CLI Release provenance rejects wrong ownership and mutable content", async () => {
  const parent = await mkdtemp(join(tmpdir(), "voice-agent-witness-release-"));
  temporaryDirectories.push(parent);
  await mkdir(join(parent, "release"));
  const release = await realpath(join(parent, "release"));
  const cli = join(release, "administrative-autonomy-restart-cli.ts");
  await writeFile(cli, "export {};\n");
  await symlink(
    "administrative-autonomy-restart-cli.ts",
    join(release, "internal-cli-link"),
  );
  await chmod(cli, 0o444);
  await chmod(release, 0o555);
  const ownerUid = (await lstat(release)).uid;

  await expect(
    administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
      release,
      ownerUid,
    ),
  ).resolves.toBe(true);
  await expect(
    administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
      release,
      ownerUid + 1,
    ),
  ).resolves.toBe(false);

  await chmod(cli, 0o644);
  await expect(
    administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
      release,
      ownerUid,
    ),
  ).resolves.toBe(false);
});

test("the CLI Release provenance rejects canonical symlink escape", async () => {
  const parent = await mkdtemp(join(tmpdir(), "voice-agent-witness-release-"));
  temporaryDirectories.push(parent);
  await mkdir(join(parent, "release"));
  const release = await realpath(join(parent, "release"));
  await symlink(parent, join(release, "escaping"));
  await chmod(release, 0o555);
  const ownerUid = (await lstat(release)).uid;

  await expect(
    administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
      release,
      ownerUid,
    ),
  ).resolves.toBe(false);
});
