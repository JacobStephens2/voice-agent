import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { credentialCustodyBoundaryPaths } from "../src/grok-credential-custody.ts";
import { probeCredentialCustodyBoundary } from "../src/grok-custody-probe.ts";

test("the probe reports only stores it could actually reach", async () => {
  const probe = await probeCredentialCustodyBoundary();

  expect(probe.readableBoundaryPaths).toBe(probe.readable.length);
  for (const path of probe.readable) {
    expect(credentialCustodyBoundaryPaths).toContain(path);
  }
});

test("the probe prints a count the enrollment record can be filed from", () => {
  const spawned = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/grok-custody-probe.ts", import.meta.url)),
    ],
    { encoding: "utf8" },
  );

  expect(spawned.status).toBe(0);
  expect(JSON.parse(spawned.stdout)).toMatchObject({
    readable: expect.any(Array),
    readableBoundaryPaths: expect.any(Number),
  });
});
