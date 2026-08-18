import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

import {
  appendSliceOneAcceptanceEvent,
  createSliceOneAcceptanceRecord,
  evaluateSliceOneAcceptance,
  markSliceOneAccepted,
  parseSliceOneAcceptanceRecord,
  type PstnRunEvent,
} from "../src/index.ts";

const releaseCommit = "a".repeat(40);
const execFileAsync = promisify(execFile);

test("five consecutive passing runs across both carriers and outdoors can accept slice one", () => {
  let record = createSliceOneAcceptanceRecord({
    campaignId: "slice-one-production",
    releaseCommit,
  });
  record = appendSliceOneAcceptanceEvent(record, {
    checks: {
      deploymentHealth: "passed",
      metricsScrape: "passed",
      testSuite: "passed",
      typecheck: "passed",
    },
    commit: releaseCommit,
    kind: "automated-verification",
    recordedAt: "2026-08-18T01:00:00.000Z",
  });
  for (const run of [
    passingRun(1, "att", "indoor"),
    passingRun(2, "tello", "indoor"),
    passingRun(3, "att", "outdoor-walking"),
    passingRun(4, "tello", "indoor"),
    passingRun(5, "att", "indoor"),
  ]) {
    record = appendSliceOneAcceptanceEvent(record, run);
  }

  expect(evaluateSliceOneAcceptance(record)).toEqual({
    accepted: false,
    errors: [],
    qualifyingRunSequences: [1, 2, 3, 4, 5],
    ready: true,
  });
  const accepted = markSliceOneAccepted(record, {
    recordedAt: "2026-08-18T02:00:00.000Z",
  });
  expect(evaluateSliceOneAcceptance(accepted)).toMatchObject({
    accepted: true,
    errors: [],
    ready: true,
  });
});

test("a failed run remains in the record and breaks the consecutive sequence", () => {
  let record = verifiedRecord();
  const firstFive = [
    passingRun(1, "att", "indoor"),
    failingRun(2, "tello", "indoor"),
    passingRun(3, "att", "outdoor-walking"),
    passingRun(4, "tello", "indoor"),
    passingRun(5, "att", "indoor"),
  ];
  for (const run of firstFive) record = appendSliceOneAcceptanceEvent(record, run);

  expect(evaluateSliceOneAcceptance(record)).toMatchObject({
    accepted: false,
    qualifyingRunSequences: [],
    ready: false,
  });
  record = appendSliceOneAcceptanceEvent(
    record,
    passingRun(6, "tello", "outdoor-walking"),
  );
  record = appendSliceOneAcceptanceEvent(record, passingRun(7, "att", "indoor"));
  expect(evaluateSliceOneAcceptance(record)).toMatchObject({
    errors: [],
    qualifyingRunSequences: [3, 4, 5, 6, 7],
    ready: true,
  });
  expect(record.events.filter((event) => event.kind === "pstn-run")).toHaveLength(7);
  expect(record.events).toContainEqual(failingRun(2, "tello", "indoor"));
});

test("acceptance is refused without automated verification and the carrier/walking campaign", () => {
  let record = createSliceOneAcceptanceRecord({
    campaignId: "incomplete",
    releaseCommit,
  });
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    record = appendSliceOneAcceptanceEvent(
      record,
      passingRun(sequence, "att", "indoor"),
    );
  }

  const evaluation = evaluateSliceOneAcceptance(record);
  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toEqual(
    expect.arrayContaining([
      "Automated verification has not passed for the release commit.",
      "The qualifying sequence does not include the Tello line.",
      "The qualifying sequence does not include an outdoor walking run.",
    ]),
  );
  expect(() =>
    markSliceOneAccepted(record, {
      recordedAt: "2026-08-18T02:00:00.000Z",
    }),
  ).toThrow("Slice one is not ready for acceptance");
});

test("the CLI initializes and atomically appends automated verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-acceptance-"));
  const recordPath = join(directory, "slice-one.json");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  try {
    await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      cli,
      "init",
      "--record",
      recordPath,
      "--campaign-id",
      "production-campaign",
      "--release-commit",
      releaseCommit,
    ]);
    await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      cli,
      "record-verification",
      "--record",
      recordPath,
      "--recorded-at",
      "2026-08-18T01:00:00.000Z",
      "--release-commit",
      releaseCommit,
    ]);

    const record = parseSliceOneAcceptanceRecord(
      JSON.parse(await readFile(recordPath, "utf8")),
    );
    expect(record.events).toHaveLength(1);
    expect(record.events[0]).toMatchObject({
      commit: releaseCommit,
      kind: "automated-verification",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function verifiedRecord() {
  return appendSliceOneAcceptanceEvent(
    createSliceOneAcceptanceRecord({
      campaignId: "sequence-recovery",
      releaseCommit,
    }),
    {
      checks: {
        deploymentHealth: "passed",
        metricsScrape: "passed",
        testSuite: "passed",
        typecheck: "passed",
      },
      commit: releaseCommit,
      kind: "automated-verification",
      recordedAt: "2026-08-18T01:00:00.000Z",
    },
  );
}

function passingRun(
  sequence: number,
  carrier: "att" | "tello",
  environment: "indoor" | "outdoor-walking",
): PstnRunEvent {
  return {
    boundaries: "passed",
    bountywellAnswer: "correct",
    callbackHandshake: "passed",
    carrier,
    completionNotice: sequence % 2 === 0 ? "sent" : "not-requested",
    environment,
    evidenceRecord: "complete",
    interruptions: {
      count: sequence === 3 ? 1 : 0,
      observation: sequence === 3 ? "Recovered after one natural interruption." : "None observed.",
    },
    kind: "pstn-run",
    latency: { callbackMs: 2_100, healthAnswerMs: 1_300 },
    manualIntervention: false,
    recordedAt: `2026-08-18T01:${String(sequence).padStart(2, "0")}:00.000Z`,
    result: "passed",
    sequence,
    taskUrl: `https://voice.stephens.page/?task=task-${sequence}`,
    transcriptionObservation: "Bountywell and the health question were transcribed correctly.",
  };
}

function failingRun(
  sequence: number,
  carrier: "att" | "tello",
  environment: "indoor" | "outdoor-walking",
): PstnRunEvent {
  return {
    ...passingRun(sequence, carrier, environment),
    bountywellAnswer: "incorrect",
    result: "failed",
    transcriptionObservation: "Bountywell was mistranscribed and the answer was incorrect.",
  };
}
