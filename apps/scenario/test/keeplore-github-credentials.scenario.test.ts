import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("Keeplore source access uses its own GitHub App credentials", async () => {
  const fixture = await githubAppFixture();

  const { stdout } = await execFileAsync(
    "bash",
    [
      "-c",
      'source "$1"\nkeeplore_load_configuration\nkeeplore_github_token',
      "keeplore-credential-test",
      join(repositoryRoot, "ops/keeplore/keeplore-config.sh"),
    ],
    {
      env: {
        KEEPLORE_CONFIGURATION: fixture.keeploreConfiguration,
        PATH: `${fixture.shimDirectory}:${process.env.PATH ?? ""}`,
      },
    },
  );

  expect(stdout.trim()).toBe("keeplore-installation-token");
});

test("a Keeplore Repository Policy Observation authenticates as its own GitHub App", async () => {
  const fixture = await githubAppFixture();

  const { stdout } = await execFileAsync(
    "bash",
    [
      "-c",
      'source "$1"\nkeeplore_load_configuration\nkeeplore_github_app_jwt',
      "keeplore-credential-test",
      join(repositoryRoot, "ops/keeplore/keeplore-config.sh"),
    ],
    {
      env: {
        KEEPLORE_CONFIGURATION: fixture.keeploreConfiguration,
        PATH: `${fixture.shimDirectory}:${process.env.PATH ?? ""}`,
      },
    },
  );

  expect(stdout.trim().split(".")).toHaveLength(3);
});

async function githubAppFixture(): Promise<{
  readonly keeploreConfiguration: string;
  readonly shimDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-github-app-"));
  temporaryDirectories.push(directory);
  const shimDirectory = join(directory, "bin");
  await mkdir(shimDirectory, { recursive: true });

  const appConfiguration = join(directory, "keeplore-github-app.conf");
  const privateKey = join(directory, "keeplore-github-app-private-key.pem");
  const keeploreConfiguration = join(directory, "keeplore.conf");
  await writeFile(appConfiguration, "123\t456\n");
  await writeFile(privateKey, "fixture-private-key\n");
  await writeFile(
    keeploreConfiguration,
    [
      "KEEPLORE_REPOSITORY=JacobStephens2/keeplore",
      "KEEPLORE_LIVE_CHECKOUT=/var/www/keeplore.app",
      "KEEPLORE_RELEASE_ROOT=/opt/keeplore/releases",
      "KEEPLORE_HEALTH_URL=https://api.keeplore.app/api/health",
      `KEEPLORE_GITHUB_APP_CONFIGURATION=${appConfiguration}`,
      `KEEPLORE_GITHUB_APP_KEY_PATH=${privateKey}`,
      "",
    ].join("\n"),
  );

  await writeExecutable(
    join(shimDirectory, "stat"),
    `#!/usr/bin/env bash
if [[ $2 == %U ]]; then printf root; else printf 600; fi
`,
  );
  await writeExecutable(
    join(shimDirectory, "openssl"),
    `#!/usr/bin/env bash
if [[ $1 == base64 ]]; then
  /usr/bin/base64 | tr -d '\\n'
else
  cat >/dev/null
  printf signature
fi
`,
  );
  await writeExecutable(
    join(shimDirectory, "curl"),
    `#!/usr/bin/env bash
cat >/dev/null
printf '{"token":"keeplore-installation-token"}'
`,
  );

  return { keeploreConfiguration, shimDirectory };
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
