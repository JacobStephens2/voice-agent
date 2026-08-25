import { expect, test } from "vitest";

import {
  appendSliceThreeAcceptanceEvent,
  createSliceThreeAcceptanceRecord,
  evaluateSliceThreeAcceptance,
  markSliceThreeAccepted,
  parseSliceThreeAcceptanceRecord,
  type SliceThreeAcceptanceRecord,
} from "../src/index.ts";

const mergeCommit = "3".repeat(40);
const evidenceRecordUrl = "https://voice.stephens.page/?task=task-button-trial";

test("slice three is accepted only after production verification follows the Human Merge", () => {
  const record = verifiedRecord();

  expect(evaluateSliceThreeAcceptance(record)).toEqual({
    accepted: false,
    errors: [],
    ready: true,
    verifiedCommit: mergeCommit,
  });
  const accepted = markSliceThreeAccepted(record, {
    recordedAt: "2026-08-25T16:00:00.000Z",
  });
  expect(evaluateSliceThreeAcceptance(accepted)).toMatchObject({
    accepted: true,
    ready: true,
  });
  expect(() =>
    markSliceThreeAccepted(accepted, { recordedAt: "2026-08-25T17:00:00.000Z" }),
  ).toThrow(/terminal/u);
  expect(parseSliceThreeAcceptanceRecord(JSON.parse(JSON.stringify(accepted)))).toEqual(
    accepted,
  );
});

test("a merged pull request alone is not acceptance", () => {
  let record = createSliceThreeAcceptanceRecord({ campaignId: "slice-three" });
  record = appendSliceThreeAcceptanceEvent(record, publication());
  record = appendSliceThreeAcceptanceEvent(record, humanMerge());

  expect(evaluateSliceThreeAcceptance(record)).toEqual({
    accepted: false,
    errors: ["Production has not been verified after the Human Merge."],
    ready: false,
    verifiedCommit: null,
  });
  expect(() =>
    markSliceThreeAccepted(record, { recordedAt: "2026-08-25T16:00:00.000Z" }),
  ).toThrow(/production verification succeeds following Human Merge/u);
});

test("a rolled-back Promotion is retained and never reads as accepted", () => {
  let record = createSliceThreeAcceptanceRecord({ campaignId: "slice-three" });
  record = appendSliceThreeAcceptanceEvent(record, publication());
  record = appendSliceThreeAcceptanceEvent(record, humanMerge());
  record = appendSliceThreeAcceptanceEvent(record, {
    ...productionVerification(),
    appearance: "failed",
    cardView: "regressed",
    rollback: "performed",
  });

  expect(evaluateSliceThreeAcceptance(record)).toMatchObject({
    errors: [
      "Production table-view appearance verification did not pass.",
      "Card view regressed in production.",
      "The Promotion rolled back, so the feature is not complete.",
    ],
    ready: false,
  });

  // A later passing verification of the same merge supersedes the failure
  // without erasing it from the history.
  record = appendSliceThreeAcceptanceEvent(record, {
    ...productionVerification(),
    recordedAt: "2026-08-25T15:45:00.000Z",
  });
  expect(evaluateSliceThreeAcceptance(record).ready).toBe(true);
  expect(record.events).toHaveLength(4);
});

test("verification of a commit no human merged is refused", () => {
  let record = createSliceThreeAcceptanceRecord({ campaignId: "slice-three" });
  record = appendSliceThreeAcceptanceEvent(record, publication());
  record = appendSliceThreeAcceptanceEvent(record, humanMerge());

  expect(() =>
    appendSliceThreeAcceptanceEvent(record, {
      ...productionVerification(),
      commit: "9".repeat(40),
    }),
  ).toThrow(/must follow the Human Merge of the same commit/u);
});

test("incomplete production evidence blocks acceptance", () => {
  let record = createSliceThreeAcceptanceRecord({ campaignId: "slice-three" });
  record = appendSliceThreeAcceptanceEvent(record, publication());
  record = appendSliceThreeAcceptanceEvent(record, humanMerge());
  record = appendSliceThreeAcceptanceEvent(record, {
    ...productionVerification(),
    screenshots: { desktop: true, mobile: false },
  });

  expect(evaluateSliceThreeAcceptance(record).errors).toEqual([
    "Authenticated production desktop and mobile evidence is incomplete.",
  ]);
});

test("evidence must be linked at the authenticated Voice Agent origin", () => {
  let record = createSliceThreeAcceptanceRecord({ campaignId: "slice-three" });
  record = appendSliceThreeAcceptanceEvent(record, publication());
  record = appendSliceThreeAcceptanceEvent(record, humanMerge());

  expect(() =>
    appendSliceThreeAcceptanceEvent(record, {
      ...productionVerification(),
      evidenceRecordUrl: "https://example.com/tasks/task-button-trial",
    }),
  ).toThrow(/authenticated Voice Agent origin/u);
});

function verifiedRecord(): SliceThreeAcceptanceRecord {
  let record = createSliceThreeAcceptanceRecord({ campaignId: "slice-three" });
  record = appendSliceThreeAcceptanceEvent(record, publication());
  record = appendSliceThreeAcceptanceEvent(record, humanMerge());
  return appendSliceThreeAcceptanceEvent(record, productionVerification());
}

function publication() {
  return {
    branch: "codex/keeplore-button-delegation-button-trial",
    kind: "trial-published",
    pullRequestUrl: "https://github.com/JacobStephens2/keeplore/pull/101",
    recordedAt: "2026-08-25T14:30:00.000Z",
  };
}

function humanMerge() {
  return {
    actor: "JacobStephens2",
    commit: mergeCommit,
    kind: "human-merge",
    mergedAt: "2026-08-25T15:00:00.000Z",
    recordedAt: "2026-08-25T15:00:00.000Z",
  };
}

function productionVerification() {
  return {
    appearance: "passed",
    cardView: "unchanged",
    commit: mergeCommit,
    evidenceRecordUrl,
    health: "healthy",
    kind: "production-verification",
    recordedAt: "2026-08-25T15:30:00.000Z",
    rollback: "none",
    screenshots: { desktop: true, mobile: true },
  };
}
