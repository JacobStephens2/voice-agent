import {
  appendSliceThreeAcceptanceEvent,
  createSliceThreeAcceptanceRecord,
  evaluateSliceThreeAcceptance,
  markSliceThreeAccepted,
  parseSliceThreeAcceptanceRecord,
  type SliceThreeAcceptanceRecord,
} from "./index.ts";
import {
  parseOptions,
  requireOnlyOptions,
  requiredBooleanOption,
  requiredOption,
} from "./cli-options.ts";
import {
  createRecordFile,
  readRecordFile,
  updateRecordFile,
} from "./record-file.ts";

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

if (command === "init") {
  requireOnlyOptions(options, ["campaign-id", "record"]);
  const recordPath = requiredOption(options, "record");
  await createRecordFile(
    recordPath,
    createSliceThreeAcceptanceRecord({
      campaignId: requiredOption(options, "campaign-id"),
    }),
  );
  process.stdout.write(`Initialized ${recordPath}\n`);
} else if (command === "record-publication") {
  requireOnlyOptions(options, ["branch", "pull-request", "record", "recorded-at"]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendSliceThreeAcceptanceEvent(record, {
      branch: requiredOption(options, "branch"),
      kind: "trial-published",
      pullRequestUrl: requiredOption(options, "pull-request"),
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else if (command === "record-merge") {
  requireOnlyOptions(options, ["actor", "commit", "merged-at", "record", "recorded-at"]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendSliceThreeAcceptanceEvent(record, {
      actor: requiredOption(options, "actor"),
      commit: requiredOption(options, "commit"),
      kind: "human-merge",
      mergedAt: requiredOption(options, "merged-at"),
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else if (command === "record-verification") {
  requireOnlyOptions(options, [
    "appearance",
    "card-view",
    "commit",
    "desktop-screenshot",
    "evidence-record",
    "health",
    "mobile-screenshot",
    "record",
    "recorded-at",
    "rollback",
  ]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendSliceThreeAcceptanceEvent(record, {
      appearance: requiredOption(options, "appearance"),
      cardView: requiredOption(options, "card-view"),
      commit: requiredOption(options, "commit"),
      evidenceRecordUrl: requiredOption(options, "evidence-record"),
      health: requiredOption(options, "health"),
      kind: "production-verification",
      recordedAt: requiredOption(options, "recorded-at"),
      rollback: requiredOption(options, "rollback"),
      screenshots: {
        desktop: requiredBooleanOption(options, "desktop-screenshot"),
        mobile: requiredBooleanOption(options, "mobile-screenshot"),
      },
    }));
} else if (command === "status") {
  requireOnlyOptions(options, ["record"]);
  const evaluation = evaluateSliceThreeAcceptance(
    await readRecord(requiredOption(options, "record")),
  );
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (!evaluation.ready) process.exitCode = 1;
} else if (command === "accept") {
  requireOnlyOptions(options, ["record", "recorded-at"]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    markSliceThreeAccepted(record, {
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else {
  throw new Error(
    "Usage: slice-three-cli.ts <init|record-publication|record-merge|record-verification|status|accept> [options]",
  );
}

async function readRecord(recordPath: string): Promise<SliceThreeAcceptanceRecord> {
  return readRecordFile(recordPath, parseSliceThreeAcceptanceRecord);
}

async function updateRecord(
  recordPath: string,
  update: (record: SliceThreeAcceptanceRecord) => SliceThreeAcceptanceRecord,
): Promise<void> {
  await updateRecordFile(recordPath, parseSliceThreeAcceptanceRecord, update);
}
