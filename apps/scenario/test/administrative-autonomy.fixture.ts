import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import { createAdministrativeAutonomyScenario } from "../src/administrative-autonomy.ts";

export async function createActivatedScenario(
  options: Omit<
    Parameters<typeof createAdministrativeAutonomyScenario>[0],
    "databasePath"
  >,
  temporaryDirectories: string[],
) {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-administrative-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const scenario = await createAdministrativeAutonomyScenario({
    ...options,
    databasePath,
  });
  const activation = await scenario.activatePolicy({
    expectedActiveRevision: null,
    expectedStateVersion: 0,
    freshPasskey: true,
  });
  expect(activation.statusCode).toBe(200);
  return { databasePath, scenario };
}
