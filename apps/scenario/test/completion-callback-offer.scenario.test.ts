import { expect, test } from "vitest";
import { defaultRecognizedSpeechModel } from "@voice-agent/contracts";

import type { EvidenceRecordProjection } from "@voice-agent/contracts";
import { createTelephoneSessionCoordinator } from "@voice-agent/runtime";

const pendingRecord: EvidenceRecordProjection = {
  evidence: [],
  task: {
    conclusion: "Bountywell inquiry is pending.",
    createdAt: "2026-08-17T20:00:00.000Z",
    id: "task-background",
    kind: "bountywell.health.inquiry",
    question: "Is Bountywell healthy?",
    status: "pending",
    updatedAt: "2026-08-17T20:00:00.000Z",
  },
};

test("pending telephone work offers an explicit Completion Callback before disconnect", async () => {
  const coordinator = createTelephoneSessionCoordinator({
    recognitionModel: defaultRecognizedSpeechModel,
    interpreter: {
      async interpret() {
        return {
          durationMs: 1,
          intent: "bountywell-health" as const,
          provider: "scenario",
        };
      },
    },
    tasks: {
      async appendTelephoneEvidence() {
        return pendingRecord;
      },
      async submitTelephoneBountywellHealthInquiry() {
        return pendingRecord;
      },
    },
  });

  await expect(
    coordinator.receiveProviderEvent({
      deliveryId: "background-question",
      kind: "turn-finalized",
      occurredAt: "2026-08-17T20:00:00.000Z",
      stt: { durationMs: 100, provider: "scenario" },
      telephoneSessionId: "telephone-session-background",
      transcript: "Is Bountywell healthy?",
      turnId: "background-question",
    }),
  ).resolves.toEqual({
    actions: [
      {
        interruptible: true,
        kind: "offer-completion-callback",
        responseId: "background-question:completion-offer",
        taskId: "task-background",
        text: "This is still running. I can disconnect and call your registered telephone when it finishes. Would you like that?",
      },
    ],
  });

  await expect(
    coordinator.receiveProviderEvent({
      deliveryId: "background-confirmation",
      kind: "turn-finalized",
      occurredAt: "2026-08-17T20:00:01.000Z",
      stt: { durationMs: 80, provider: "scenario" },
      telephoneSessionId: "telephone-session-background",
      transcript: "Yes, please.",
      turnId: "background-confirmation",
    }),
  ).resolves.toEqual({
    actions: [
      {
        interruptible: false,
        kind: "request-completion-callback-and-disconnect",
        requestId: "completion-callback:background-confirmation",
        taskId: "task-background",
        telephoneSessionId: "telephone-session-background",
      },
    ],
  });
});
