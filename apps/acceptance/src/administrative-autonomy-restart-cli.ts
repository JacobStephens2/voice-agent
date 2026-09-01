import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  administrativeRestartWitnessCampaignIdSchema,
  administrativeRestartWitnessChallengeSchema,
  administrativeRestartWitnessRecord,
  administrativeRestartWitnessRecordSchema,
  administrativeRestartWitnessReleaseCommitSchema,
  administrativeTimestampSchema,
} from "@voice-agent/contracts";
import { createSqliteAdministrativeRestartWitnessStore } from "@voice-agent/sqlite-store";
import { administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable } from "@voice-agent/runtime";

import { evaluateAdministrativeAutonomyRestartWitness } from "./index.ts";
import { parseOptions, requireOnlyOptions } from "./cli-options.ts";
import { createRecordFile, readRecordFile } from "./record-file.ts";

const productionDatabasePath = "/var/lib/voice-agent/voice-agent.sqlite";
const activeReleaseMarkerPath =
  "/opt/voice-agent/current/.voice-agent-release";
const activeReleaseLinkPath = "/opt/voice-agent/current";

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));
requireOnlyOptions(options, []);

const releaseCommit = await readActiveReleaseCommit();
const recordPath =
  `/var/lib/voice-agent/acceptance/issue-83-administrative-autonomy-restart-${releaseCommit}.json`;
const store = createSqliteAdministrativeRestartWitnessStore(
  productionDatabasePath,
);

try {
  if (command === "create") {
    const campaign = await store.ensureCampaign({
      campaignId: administrativeRestartWitnessCampaignIdSchema.parse(
        `administrative-restart-campaign-${releaseCommit}`,
      ),
      createdAt: administrativeTimestampSchema.parse(new Date().toISOString()),
      initialChallenge: nextChallenge(),
      releaseCommit,
    });
    writeJson(campaign);
  } else if (command === "show") {
    writeJson(await requireCampaign());
  } else if (command === "export") {
    const campaign = await requireCampaign();
    if (campaign.status !== "completed") {
      throw new Error("The server-recorded Restart Witness is not complete");
    }
    const record = administrativeRestartWitnessRecord(campaign);
    try {
      const existing = await readRecordFile(
        recordPath,
        (input) => administrativeRestartWitnessRecordSchema.parse(input),
      );
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(
          "The immutable Restart Witness export differs from durable evidence",
        );
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      await createRecordFile(recordPath, record);
    }
    writeJson({ recordPath, record });
  } else if (command === "status") {
    const evaluation = evaluateAdministrativeAutonomyRestartWitness(
      administrativeRestartWitnessRecord(await requireCampaign()),
    );
    writeJson(evaluation);
    if (!evaluation.ready) process.exitCode = 1;
  } else {
    throw new Error(
      "Usage: administrative-autonomy-restart-cli.ts <create|show|export|status>",
    );
  }
} finally {
  await store.close();
}

async function requireCampaign() {
  const campaign = await store.readCampaignForRelease(releaseCommit);
  if (campaign === undefined) {
    throw new Error("Create the server-recorded Restart Witness campaign first");
  }
  return campaign;
}

function nextChallenge() {
  return administrativeRestartWitnessChallengeSchema.parse(
    `administrative-restart-challenge-${randomUUID()}`,
  );
}

async function readActiveReleaseCommit() {
  const [marker, releasePath, runningCliPath] = await Promise.all([
    readFile(activeReleaseMarkerPath, "utf8"),
    realpath(activeReleaseLinkPath),
    realpath(fileURLToPath(import.meta.url)),
  ]);
  const commit = administrativeRestartWitnessReleaseCommitSchema.parse(
    marker.trim(),
  );
  const expectedCliPath =
    `${releasePath}/apps/acceptance/src/administrative-autonomy-restart-cli.ts`;
  if (
    releasePath !== `/opt/voice-agent/releases/${commit}` ||
    runningCliPath !== expectedCliPath
  ) {
    throw new Error(
      "Run this only from the exact active immutable Agent Host Release",
    );
  }
  if (
    !(await administrativeRestartWitnessReleaseTreeIsOwnedAndImmutable(
      releasePath,
      0,
    ))
  ) {
    throw new Error(
      "The active Agent Host Release is not root-owned and immutable",
    );
  }
  return commit;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
