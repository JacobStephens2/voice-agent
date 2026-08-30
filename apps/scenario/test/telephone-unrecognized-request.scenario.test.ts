import { expect, test } from "vitest";
import {
  defaultConfiguredSpeechSynthesis,
  defaultRecognizedSpeechModel,
} from "@voice-agent/contracts";

import type {
  EvidenceRecordProjection,
  TelephoneSessionActionResult,
} from "@voice-agent/contracts";
import {
  createTelephoneSessionCoordinator,
  unrecognizedStateChangingRequestText,
} from "@voice-agent/runtime";

const unusedRecord: EvidenceRecordProjection = {
  evidence: [],
  task: {
    conclusion: "Bountywell inquiry is pending.",
    createdAt: "2026-08-25T10:00:00.000Z",
    id: "task-unused",
    kind: "bountywell.health.inquiry",
    question: "Is Bountywell healthy?",
    status: "pending",
    updatedAt: "2026-08-25T10:00:00.000Z",
  },
};

function createScenario() {
  const claimed: string[] = [];
  const released: string[] = [];
  const coordinator = createTelephoneSessionCoordinator({
    recognitionModel: defaultRecognizedSpeechModel,
    synthesisModel: defaultConfiguredSpeechSynthesis,
    interpreter: {
      async interpret() {
        return {
          durationMs: 1,
          intent: "state-changing" as const,
          provider: "deterministic-unrecognized-request-scenario",
        };
      },
    },
    stateChangingTasks: {
      async claim(_telephoneSessionId, taskId) {
        claimed.push(taskId);
        return {
          decision: "accepted" as const,
          resource: "state-changing-task" as const,
        };
      },
      async release(_telephoneSessionId, taskId) {
        released.push(taskId);
        return {};
      },
    },
    tasks: {
      async appendTelephoneEvidence() {
        return unusedRecord;
      },
      async submitTelephoneBountywellHealthInquiry() {
        return unusedRecord;
      },
    },
  });
  return { claimed, coordinator, released };
}

async function speak(
  coordinator: ReturnType<typeof createScenario>["coordinator"],
  transcript: string,
  turnId: string,
): Promise<TelephoneSessionActionResult> {
  return coordinator.receiveProviderEvent({
    deliveryId: turnId,
    kind: "turn-finalized",
    occurredAt: "2026-08-25T10:00:00.000Z",
    stt: { durationMs: 100, provider: "deterministic-scenario-stt" },
    telephoneSessionId: "telephone-session-unrecognized-request",
    transcript,
    turnId,
  });
}

test.each([
  ["Restart Bountywell production so the API becomes healthy"],
  ["change in Keeplore"],
  ["Deploy the fix now"],
])(
  "a state-changing request %j the system matched to nothing names no Registered Codebase",
  async (transcript) => {
    const { claimed, coordinator, released } = createScenario();

    const answered = await speak(coordinator, transcript, "unmatched-request");

    expect(answered.actions).toEqual([
      {
        interruptible: true,
        kind: "speak-guidance",
        responseId: "unmatched-request:guidance",
        text: unrecognizedStateChangingRequestText,
      },
    ]);
    // No Task Confirmation was prepared, so no state-changing slot is held.
    expect(claimed).toEqual([]);
    expect(released).toEqual([]);
  },
);

test("an unmatched request leaves nothing for a later affirmative to accept", async () => {
  const { coordinator } = createScenario();

  await speak(coordinator, "Deploy the fix now", "unmatched-request");
  const answered = await speak(coordinator, "Yes, I confirm.", "later-yes");

  // The affirmative answers no pending Task Confirmation, so it is read as the
  // unmatched request it is rather than as consent to a sentence never spoken.
  expect(answered.actions).toEqual([
    {
      interruptible: true,
      kind: "speak-guidance",
      responseId: "later-yes:guidance",
      text: unrecognizedStateChangingRequestText,
    },
  ]);
});

test("a matched Keeplore Button Trial request keeps its named readback", async () => {
  const { claimed, coordinator } = createScenario();

  const answered = await speak(
    coordinator,
    "In Keeplore, make the table view Get Rid Of and Remove buttons match",
    "keeplore-request",
  );

  expect(answered.actions).toMatchObject([
    {
      confirmationId: "keeplore-request:confirmation",
      kind: "request-task-confirmation",
    },
  ]);
  expect(claimed).toEqual(["keeplore-request:confirmation"]);
});

test("a matched Bountywell outage report keeps its named readback", async () => {
  const { claimed, coordinator } = createScenario();

  const answered = await speak(
    coordinator,
    "Bountywell is unavailable",
    "outage-report",
  );

  expect(answered.actions).toMatchObject([
    {
      kind: "request-task-confirmation",
      text: "Please confirm this state-changing task: Bountywell production — Bountywell is unavailable.",
    },
  ]);
  expect(claimed).toEqual(["outage-report:confirmation"]);
});
