import { expect, test } from "vitest";
import { defaultRecognizedSpeechModel } from "@voice-agent/contracts";

import type {
  EvidenceRecordProjection,
  TelephoneSessionActionResult,
} from "@voice-agent/contracts";
import { createTelephoneSessionCoordinator } from "@voice-agent/runtime";

const unusedRecord: EvidenceRecordProjection = {
  evidence: [],
  task: {
    conclusion: "Bountywell inquiry is pending.",
    createdAt: "2026-08-24T10:00:00.000Z",
    id: "task-unused",
    kind: "bountywell.health.inquiry",
    question: "Is Bountywell healthy?",
    status: "pending",
    updatedAt: "2026-08-24T10:00:00.000Z",
  },
};

test.each([
  ["I confirm - Yes", "confirmed"],
  ["I confirm—yes", "confirmed"],
  ["yes, I confirm", "confirmed"],
  ["That is correct", "confirmed"],
  ["That's correct.", "confirmed"],
  ["Yes. Yes. Yes, please.", "confirmed"],
  ["Well, okay — go ahead.", "confirmed"],
  ["Okay.", "confirmed"],
  ["Sorry, yes — that's correct.", "confirmed"],
  ["No.", "declined"],
  ["Nope, cancel that.", "declined"],
  ["That is not correct.", "declined"],
  ["Yes — no, do not do that.", "declined"],
  ["Yes, but only if you also restart the database.", "declined"],
  ["Correct, unless it touches production data.", "declined"],
  ["Sorry, the line broke up there.", "pending"],
  ["Okay, so", "pending"],
  ["Um, okay then", "pending"],
  ["Restart it tomorrow instead of now", "declined"],
])(
  "a pending Task Confirmation answered with %j is %s",
  async (transcript, outcome) => {
    const released: string[] = [];
    const coordinator = createTelephoneSessionCoordinator({
      recognitionModel: defaultRecognizedSpeechModel,
      interpreter: {
        async interpret() {
          return {
            durationMs: 1,
            intent: "state-changing" as const,
            provider: "deterministic-confirmation-scenario",
          };
        },
      },
      stateChangingTasks: {
        async claim() {
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

    const requested = await coordinator.receiveProviderEvent({
      deliveryId: "confirmation-request",
      kind: "turn-finalized",
      occurredAt: "2026-08-24T10:00:00.000Z",
      stt: { durationMs: 100, provider: "deterministic-scenario-stt" },
      telephoneSessionId: "telephone-session-confirmation-language",
      transcript: "Bountywell is unavailable, restart it",
      turnId: "confirmation-request",
    });
    expect(requested.actions).toMatchObject([
      { kind: "request-task-confirmation" },
    ]);

    const answered = await coordinator.receiveProviderEvent({
      deliveryId: "confirmation-answer",
      kind: "turn-finalized",
      occurredAt: "2026-08-24T10:00:01.000Z",
      stt: { durationMs: 100, provider: "deterministic-scenario-stt" },
      telephoneSessionId: "telephone-session-confirmation-language",
      transcript,
      turnId: "confirmation-answer",
    });

    if (outcome === "pending") {
      expect(spokenText(answered)).toBe(
        "I did not catch that. The same Task Confirmation is still pending. Please say yes to confirm it or no to decline it.",
      );
      // The claimed state-changing slot is held for the decision still to come.
      expect(released).toEqual([]);
      return;
    }
    expect(released).toEqual(["confirmation-request:confirmation"]);
    expect(spokenText(answered)).toBe(
      outcome === "declined"
        ? "Okay. I did not confirm that state-changing task."
        : "Task confirmation recorded. Use the secure app to authorize execution.",
    );
  },
);

test("a Task Confirmation held through unclear speech is accepted by a later affirmative", async () => {
  const released: string[] = [];
  const coordinator = createTelephoneSessionCoordinator({
    recognitionModel: defaultRecognizedSpeechModel,
    interpreter: {
      async interpret() {
        return {
          durationMs: 1,
          intent: "state-changing" as const,
          provider: "deterministic-confirmation-scenario",
        };
      },
    },
    stateChangingTasks: {
      async claim() {
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

  await coordinator.receiveProviderEvent({
    deliveryId: "held-request",
    kind: "turn-finalized",
    occurredAt: "2026-08-24T10:00:00.000Z",
    stt: { durationMs: 100, provider: "deterministic-scenario-stt" },
    telephoneSessionId: "telephone-session-held",
    transcript: "Bountywell is unavailable, restart it",
    turnId: "held-request",
  });
  for (const [index, unclear] of ["Sorry?", "Hmm, what was that"].entries()) {
    const answered = await coordinator.receiveProviderEvent({
      deliveryId: `held-unclear-${index}`,
      kind: "turn-finalized",
      occurredAt: "2026-08-24T10:00:01.000Z",
      stt: { durationMs: 100, provider: "deterministic-scenario-stt" },
      telephoneSessionId: "telephone-session-held",
      transcript: unclear,
      turnId: `held-unclear-${index}`,
    });
    // The readback itself is never repeated, only the short prompt.
    expect(answered.actions).toMatchObject([{ kind: "speak-guidance" }]);
  }

  const confirmed = await coordinator.receiveProviderEvent({
    deliveryId: "held-confirm",
    kind: "turn-finalized",
    occurredAt: "2026-08-24T10:00:02.000Z",
    stt: { durationMs: 100, provider: "deterministic-scenario-stt" },
    telephoneSessionId: "telephone-session-held",
    transcript: "Yes, I confirm.",
    turnId: "held-confirm",
  });

  expect(spokenText(confirmed)).toBe(
    "Task confirmation recorded. Use the secure app to authorize execution.",
  );
  expect(released).toEqual(["held-request:confirmation"]);
});

function spokenText(result: TelephoneSessionActionResult): string {
  const action = result.actions[0];
  if (
    action?.kind !== "speak-guidance" &&
    action?.kind !== "speak-semantic-response"
  ) {
    throw new Error("Expected one spoken Telephone Session response");
  }
  return action.text;
}
