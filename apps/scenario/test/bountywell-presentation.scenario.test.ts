import { describe, expect, test } from "vitest";
import { defaultRecognizedSpeechModel } from "@voice-agent/contracts";

import type { EvidenceRecordProjection } from "@voice-agent/contracts";
import {
  createTelephoneSessionCoordinator,
  unrecognizedStateChangingRequestText,
} from "@voice-agent/runtime";

const recovered: EvidenceRecordProjection = {
  evidence: [
    {
      details: {
        alreadyRecovered: false,
        basis: "observation",
        hypotheses: [
          {
            statement:
              "The registered bountywell-api.service unit is inactive and explains the unavailable API.",
            status: "supported",
          },
        ],
        inactiveUnit: "bountywell-api.service",
      },
      id: "diagnosis",
      kind: "diagnosis.recorded",
      occurredAt: "2026-08-18T12:05:00.000Z",
      sequence: 1,
      summary:
        "The diagnosis is observation: the registered bountywell-api.service unit is inactive.",
    },
  ],
  task: {
    conclusion: "Bountywell API was recovered.",
    createdAt: "2026-08-18T12:00:00.000Z",
    id: "drill-task",
    kind: "bountywell.outage.recovery",
    question: "Bountywell's API appears unavailable.",
    status: "completed",
    updatedAt: "2026-08-18T12:05:00.000Z",
  },
};

function createCoordinator(
  options: { readonly presentedDrill: boolean } = { presentedDrill: true },
) {
  const drill = options.presentedDrill
    ? { taskId: recovered.task.id }
    : undefined;
  const calls = { presented: 0, recovered: 0 };
  const coordinator = createTelephoneSessionCoordinator({
    recognitionModel: defaultRecognizedSpeechModel,
    interpreter: {
      async interpret() {
        return {
          durationMs: 4,
          intent: "state-changing" as const,
          provider: "scenario",
        };
      },
    },
    stateChangingTasks: {
      async claim() {
        return { decision: "accepted" as const, resource: "state-changing-task" as const };
      },
      async release() {
        return {};
      },
    },
    tasks: {
      async appendTelephoneEvidence() {
        return recovered;
      },
      async presentBountywellOutage() {
        calls.presented += 1;
        return drill;
      },
      async processNextBountywellOutageRecovery() {
        calls.recovered += 1;
        return recovered;
      },
      async submitTelephoneBountywellHealthInquiry() {
        return recovered;
      },
    },
  });
  return { calls, coordinator };
}

async function speak(
  coordinator: ReturnType<typeof createCoordinator>["coordinator"],
  transcript: string,
  turnId: string,
) {
  return coordinator.receiveProviderEvent({
    deliveryId: turnId,
    kind: "turn-finalized",
    occurredAt: "2026-08-18T12:04:00.000Z",
    stt: { durationMs: 120, provider: "scenario" },
    telephoneSessionId: "telephone-session-drill",
    transcript,
    turnId,
  });
}

describe("the presented drill is the only outage an affirmative confirmation recovers", () => {
  test("confirming the presented unavailable-API report recovers the drill", async () => {
    const { calls, coordinator } = createCoordinator();

    await expect(
      speak(coordinator, "Bountywell's API appears unavailable.", "presentation"),
    ).resolves.toMatchObject({
      actions: [{ kind: "request-task-confirmation" }],
    });
    expect(calls.presented).toBe(0);

    const answer = await speak(coordinator, "Yes, please", "confirmation");
    expect(answer.actions).toEqual([
      {
        interruptible: true,
        kind: "speak-semantic-response",
        responseId: "confirmation:outage-response",
        taskId: "drill-task",
        text:
          "Bountywell's API was recovered. Observation identified the inactive registered bountywell-api.service unit. The public /api/health check returned 200 and /api/data returned the expected 401. The recovery timer has been removed.",
      },
    ]);
    expect(calls).toEqual({ presented: 1, recovered: 1 });
  });

  test("an outage reported in the owner's own words still recovers the presented drill", async () => {
    const { calls, coordinator } = createCoordinator();

    await speak(coordinator, "Bountywell is down", "spoken-report");
    await expect(
      speak(coordinator, "Yes", "spoken-confirmation"),
    ).resolves.toMatchObject({
      actions: [{ kind: "speak-semantic-response", taskId: "drill-task" }],
    });
    expect(calls).toEqual({ presented: 1, recovered: 1 });
  });

  test("an outage nobody presented recovers nothing, however it is described", async () => {
    const { calls, coordinator } = createCoordinator({ presentedDrill: false });

    await speak(coordinator, "Bountywell's API appears unavailable.", "unpresented");
    await expect(
      speak(coordinator, "Yes, please", "unpresented-confirmation"),
    ).resolves.toEqual({
      actions: [
        {
          interruptible: true,
          kind: "speak-guidance",
          responseId: "unpresented-confirmation:guidance",
          text: "Task confirmation recorded. Use the secure app to authorize execution.",
        },
      ],
    });
    expect(calls).toEqual({ presented: 1, recovered: 0 });
  });

  test("a request matched to no outage is never read back, so nothing recovers", async () => {
    const { calls, coordinator } = createCoordinator();
    await expect(
      speak(
        coordinator,
        "Restart production so the API becomes healthy",
        "unrelated",
      ),
    ).resolves.toEqual({
      actions: [
        {
          interruptible: true,
          kind: "speak-guidance",
          responseId: "unrelated:guidance",
          text: unrecognizedStateChangingRequestText,
        },
      ],
    });
    // No Task Confirmation was prepared, so the affirmative that follows
    // confirms nothing and the presented drill stays where it was.
    await expect(
      speak(coordinator, "Yes, please", "unrelated-confirmation"),
    ).resolves.toEqual({
      actions: [
        {
          interruptible: true,
          kind: "speak-guidance",
          responseId: "unrelated-confirmation:guidance",
          text: unrecognizedStateChangingRequestText,
        },
      ],
    });
    expect(calls).toEqual({ presented: 0, recovered: 0 });
  });
});
