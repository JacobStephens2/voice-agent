import { expect, test } from "vitest";

import { keeploreModelSandboxConfigArguments } from "../src/keeplore-model-sandbox.ts";

test("the Keeplore model sandbox grants only its disposable directory and no network", () => {
  expect(keeploreModelSandboxConfigArguments("keeplore")).toEqual([
    "--config",
    'permissions.keeplore.filesystem={":minimal" = "read", ":workspace_roots" = {"." = "write"}}',
    "--config",
    "permissions.keeplore.network.enabled=false",
  ]);
});

test("the Keeplore model sandbox rejects an unsafe profile name", () => {
  expect(() =>
    keeploreModelSandboxConfigArguments("keeplore;network=true"),
  ).toThrow("Keeplore model permission profile name is invalid");
});
