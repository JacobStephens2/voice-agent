import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const cli = await readFile(
  fileURLToPath(
    new URL(
      "../src/administrative-autonomy-restart-cli.ts",
      import.meta.url,
    ),
  ),
  "utf8",
);

test("the attended CLI reads only the fixed composition-owned witness store", () => {
  expect(cli).toContain('const productionDatabasePath = "/var/lib/voice-agent/voice-agent.sqlite"');
  expect(cli).toContain("createSqliteAdministrativeRestartWitnessStore");
  expect(cli).toContain("administrativeRestartWitnessRecord");
  expect(cli).not.toContain("status-file");
  expect(cli).not.toContain("readPolicyStatus");
  expect(cli).not.toContain("apiAuthentication");
  expect(cli).not.toContain('requiredOption(options, "database")');
  expect(cli).not.toContain('requiredOption(options, "record")');
  expect(cli).toContain("fileURLToPath(import.meta.url)");
  expect(cli).toContain("expectedCliPath");
  expect(cli).toContain("administrativeRestartWitnessReleaseCommitSchema");
  expect(cli).toContain(
    "administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable",
  );
});
