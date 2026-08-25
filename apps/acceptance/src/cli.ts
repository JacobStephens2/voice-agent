import {
  appendSliceOneAcceptanceEvent,
  createSliceOneAcceptanceRecord,
  evaluateSliceOneAcceptance,
  markSliceOneAccepted,
  parseSliceOneAcceptanceRecord,
  type SliceOneAcceptanceRecord,
} from "./index.ts";
import {
  parseOptions,
  requireOnlyOptions,
  requiredBooleanOption,
  requiredIntegerOption,
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
  requireOnlyOptions(options, ["campaign-id", "record", "release-commit"]);
  const recordPath = requiredOption(options, "record");
  await createRecordFile(
    recordPath,
    createSliceOneAcceptanceRecord({
      campaignId: requiredOption(options, "campaign-id"),
      releaseCommit: requiredOption(options, "release-commit"),
    }),
  );
  process.stdout.write(`Initialized ${recordPath}\n`);
} else if (command === "record-verification") {
  requireOnlyOptions(options, ["record", "recorded-at", "release-commit"]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendSliceOneAcceptanceEvent(record, {
      checks: {
        deploymentHealth: "passed",
        metricsScrape: "passed",
        testSuite: "passed",
        typecheck: "passed",
      },
      commit: requiredOption(options, "release-commit"),
      kind: "automated-verification",
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else if (command === "record-run") {
  requireOnlyOptions(options, [
    "bountywell-answer",
    "callback-handshake",
    "callback-ms",
    "carrier",
    "completion-notice",
    "environment",
    "evidence-record",
    "health-answer-ms",
    "interruption-count",
    "interruption-observation",
    "manual-intervention",
    "notes",
    "record",
    "recorded-at",
    "result",
    "sequence",
    "task-url",
    "telephone-boundary-checks",
    "transcription-observation",
  ]);
  const notes = options.get("notes");
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendSliceOneAcceptanceEvent(record, {
      bountywellAnswer: requiredOption(options, "bountywell-answer"),
      callbackHandshake: requiredOption(options, "callback-handshake"),
      carrier: requiredOption(options, "carrier"),
      completionNotice: requiredOption(options, "completion-notice"),
      environment: requiredOption(options, "environment"),
      evidenceRecord: requiredOption(options, "evidence-record"),
      interruptions: {
        count: requiredIntegerOption(options, "interruption-count"),
        observation: requiredOption(options, "interruption-observation"),
      },
      kind: "pstn-run",
      latency: {
        callbackMs: requiredIntegerOption(options, "callback-ms"),
        healthAnswerMs: requiredIntegerOption(options, "health-answer-ms"),
      },
      manualIntervention: requiredBooleanOption(options, "manual-intervention"),
      ...(notes === undefined ? {} : { notes }),
      recordedAt: requiredOption(options, "recorded-at"),
      result: requiredOption(options, "result"),
      sequence: requiredIntegerOption(options, "sequence"),
      taskUrl: requiredOption(options, "task-url"),
      telephoneBoundaryChecks: requiredOption(
        options,
        "telephone-boundary-checks",
      ),
      transcriptionObservation: requiredOption(
        options,
        "transcription-observation",
      ),
    }));
} else if (command === "status") {
  requireOnlyOptions(options, ["record"]);
  const record = await readRecord(requiredOption(options, "record"));
  const evaluation = evaluateSliceOneAcceptance(record);
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (!evaluation.ready) process.exitCode = 1;
} else if (command === "accept") {
  requireOnlyOptions(options, ["record", "recorded-at"]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    markSliceOneAccepted(record, {
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else {
  throw new Error(
    "Usage: cli.ts <init|record-verification|record-run|status|accept> [options]",
  );
}

async function readRecord(recordPath: string): Promise<SliceOneAcceptanceRecord> {
  return readRecordFile(recordPath, parseSliceOneAcceptanceRecord);
}

async function updateRecord(
  recordPath: string,
  update: (record: SliceOneAcceptanceRecord) => SliceOneAcceptanceRecord,
): Promise<void> {
  await updateRecordFile(recordPath, parseSliceOneAcceptanceRecord, update);
}
