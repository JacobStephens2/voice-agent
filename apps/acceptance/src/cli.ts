import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  appendSliceOneAcceptanceEvent,
  createSliceOneAcceptanceRecord,
  evaluateSliceOneAcceptance,
  markSliceOneAccepted,
  parseSliceOneAcceptanceRecord,
  type SliceOneAcceptanceRecord,
} from "./index.ts";

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

if (command === "init") {
  requireOnlyOptions(options, ["campaign-id", "record", "release-commit"]);
  const recordPath = requiredOption(options, "record");
  await withRecordLock(recordPath, async () => {
    const record = createSliceOneAcceptanceRecord({
      campaignId: requiredOption(options, "campaign-id"),
      releaseCommit: requiredOption(options, "release-commit"),
    });
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, serialize(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
  });
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
  return parseSliceOneAcceptanceRecord(
    JSON.parse(await readFile(recordPath, "utf8")),
  );
}

async function updateRecord(
  recordPath: string,
  update: (record: SliceOneAcceptanceRecord) => SliceOneAcceptanceRecord,
): Promise<void> {
  await withRecordLock(recordPath, async () => {
    const updated = update(await readRecord(recordPath));
    const candidatePath = `${recordPath}.${process.pid}.tmp`;
    try {
      await writeFile(candidatePath, serialize(updated), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      await rename(candidatePath, recordPath);
    } catch (error) {
      await unlink(candidatePath).catch(() => undefined);
      throw error;
    }
  });
}

async function withRecordLock(
  recordPath: string,
  action: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true });
  const lockPath = `${recordPath}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await action();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

function serialize(record: SliceOneAcceptanceRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function parseOptions(arguments_: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Options must be provided as --name value pairs");
    }
    const key = name.slice(2);
    if (parsed.has(key)) throw new Error(`Duplicate option --${key}`);
    parsed.set(key, value);
  }
  return parsed;
}

function requireOnlyOptions(
  options: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name}`);
  }
}

function requiredOption(
  options: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requiredIntegerOption(
  options: ReadonlyMap<string, string>,
  name: string,
): number {
  const raw = requiredOption(options, name);
  if (!/^\d+$/u.test(raw)) throw new Error(`--${name} must be an integer`);
  return Number(raw);
}

function requiredBooleanOption(
  options: ReadonlyMap<string, string>,
  name: string,
): boolean {
  const raw = requiredOption(options, name);
  if (raw !== "true" && raw !== "false") {
    throw new Error(`--${name} must be true or false`);
  }
  return raw === "true";
}
