import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTelephoneBountywellScenario } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Telephone Bountywell health inquiry", () => {
  test("a paraphrased finalized turn produces one supported spoken answer and Evidence Record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-health-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: [
        "task-telephone-001",
        "operation-telephone-001",
        "event-task-accepted",
        "event-operation-accepted",
        "event-observed",
        "event-operation-completed",
        "event-task-completed",
      ],
      now: "2026-08-17T12:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
          {
            facts: { statusCode: 401 },
            outcome: "pass",
            source: "authentication-boundary",
            summary: "The protected data endpoint required authentication.",
          },
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "local-health",
            summary: "The registered local endpoint responded successfully.",
          },
          {
            facts: { active: true, subState: "running" },
            outcome: "pass",
            source: "service-state",
            summary: "The registered API service is active.",
          },
          {
            facts: { availability: "available", diskPressure: false },
            outcome: "pass",
            source: "resource-health",
            summary: "No bounded resource-health check failed.",
          },
        ],
        observedAt: "2026-08-17T12:00:01.000Z",
        rejectedEvidenceCount: 1,
        uncertainty: "One unrelated host observation was excluded.",
      },
    });

    try {
      const result = await scenario.receiveProviderEvent({
        deliveryId: "turn-delivery-001",
        kind: "turn-finalized",
        occurredAt: "2026-08-17T12:00:00.500Z",
        stt: {
          durationMs: 320,
          provider: "assemblyai",
        },
        telephoneSessionId: "telephone-session-001",
        transcript: "Could you tell me how Bountywell is doing?",
        turnId: "turn-delivery-001",
      });

      expect(result.actions).toEqual([
        {
          interruptible: true,
          kind: "speak-semantic-response",
          responseId: "turn-delivery-001:response",
          taskId: "task-telephone-001",
          text:
            "Bountywell's API is healthy. The primary /api/health check returned 200. The authentication-boundary /api/data check returned the expected 401. The registered local endpoint and service are healthy, and the bounded resource check passed. Uncertainty: One unrelated host observation was excluded.",
        },
      ]);
      expect(scenario.brokerRequests).toEqual([
        {
          operationId: "operation-telephone-001",
          taskId: "task-telephone-001",
        },
      ]);

      const record = await scenario.readEvidenceRecord("task-telephone-001");
      expect(record?.task.conclusion).toBe("Bountywell API is healthy.");
      expect(record?.evidence.map((event) => event.kind)).toEqual([
        "telephone.turn.finalized",
        "telephone.provider.timing",
        "telephone.provider.timing",
        "task.accepted",
        "operation.accepted",
        "evidence.observed",
        "operation.completed",
        "task.completed",
        "telephone.semantic.response",
      ]);
      expect(JSON.stringify(record)).toContain(
        "Could you tell me how Bountywell is doing?",
      );
      expect(JSON.stringify(record)).toContain(
        "The authentication-boundary /api/data check returned the expected 401.",
      );
      const page = await scenario.readTaskPage(
        "task-telephone-001",
        "scenario-trusted-session",
      );
      expect(page.statusCode).toBe(200);
      expect(page.html).toContain("Could you tell me how Bountywell is doing?");
      expect(page.html).toContain("Health check accepted");
      expect(page.html).toContain("Spoken response prepared");
      expect(page.html).toContain("Bountywell API is healthy.");
      const metrics = await scenario.readMetrics();
      expect(metrics).toContain(
        'voice_agent_speech_stage_duration_ms_sum{stage="stt",provider="assemblyai"} 320',
      );
      expect(metrics).toContain(
        'voice_agent_speech_stage_duration_ms_count{stage="stt",provider="assemblyai"} 1',
      );
      expect(metrics).toContain(
        'voice_agent_speech_stage_duration_ms_sum{stage="coordinator",provider="other"} 24',
      );
      expect(metrics).toContain("voice_agent_telephone_turns 1");
      expect(metrics).toContain("voice_agent_telephone_interruptions 0");
      expect(metrics).not.toContain("Could you tell me how Bountywell is doing?");
      expect(metrics).not.toContain("deterministic-scenario-coordinator");
    } finally {
      await scenario.close();
    }
  });

  test("an interim speech hypothesis is discarded before interpretation or persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-interim-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: ["must-not-be-used"],
      now: "2026-08-17T13:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-17T13:00:01.000Z",
        rejectedEvidenceCount: 0,
      },
    });

    try {
      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "interim-delivery-001",
          kind: "speech-hypothesis",
          occurredAt: "2026-08-17T13:00:00.500Z",
          telephoneSessionId: "telephone-session-interim",
          transcript: "Is Bountywell healthy",
        }),
      ).resolves.toEqual({ actions: [] });
      expect(scenario.brokerRequests).toEqual([]);
    } finally {
      await scenario.close();
    }
  });

  test("an unrelated finalized request receives guidance without a Bountywell Operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-unrelated-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: ["must-not-be-used"],
      now: "2026-08-17T14:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-17T14:00:01.000Z",
        rejectedEvidenceCount: 0,
      },
    });

    try {
      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "unrelated-delivery-001",
          kind: "turn-finalized",
          occurredAt: "2026-08-17T14:00:00.500Z",
          stt: { durationMs: 280, provider: "assemblyai" },
          telephoneSessionId: "telephone-session-unrelated",
          transcript: "What's the weather tomorrow?",
          turnId: "unrelated-delivery-001",
        }),
      ).resolves.toEqual({
        actions: [
          {
            interruptible: true,
            kind: "speak-guidance",
            responseId: "unrelated-delivery-001:guidance",
            text:
              "I can only answer the registered read-only Bountywell health question in this Telephone Session.",
          },
        ],
      });
      expect(scenario.brokerRequests).toEqual([]);
      expect(scenario.sessionEvidence.map((event) => event.kind)).toEqual([
        "telephone.turn.finalized",
        "telephone.provider.timing",
        "telephone.provider.timing",
        "telephone.semantic.response",
      ]);
      expect(JSON.stringify(scenario.sessionEvidence)).toContain(
        "What's the weather tomorrow?",
      );
    } finally {
      await scenario.close();
    }
  });

  test("insufficient evidence produces a conservative spoken conclusion with supported facts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-insufficient-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: [
        "task-insufficient",
        "operation-insufficient",
        "event-insufficient-accepted",
        "event-insufficient-operation",
        "event-insufficient-observed",
        "event-insufficient-completed",
        "event-insufficient-task",
      ],
      now: "2026-08-17T15:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 401 },
            outcome: "pass",
            source: "authentication-boundary",
            summary: "The protected data endpoint required authentication.",
          },
        ],
        observedAt: "2026-08-17T15:00:01.000Z",
        rejectedEvidenceCount: 0,
        uncertainty: "The primary health observation was missing.",
      },
    });

    try {
      const result = await scenario.receiveProviderEvent({
        deliveryId: "insufficient-delivery-001",
        kind: "turn-finalized",
        occurredAt: "2026-08-17T15:00:00.500Z",
        stt: { durationMs: 310, provider: "assemblyai" },
        telephoneSessionId: "telephone-session-insufficient",
        transcript: "What's Bountywell's health status?",
        turnId: "insufficient-delivery-001",
      });

      expect(result.actions[0]).toMatchObject({
        kind: "speak-semantic-response",
        text:
          "I could not confirm that Bountywell's API is healthy. Supported facts: no primary /api/health evidence was available; the authentication-boundary /api/data check returned the expected 401. Uncertainty: The primary health observation was missing.",
      });
      const record = await scenario.readEvidenceRecord("task-insufficient");
      expect(record?.task.conclusion).toBe(
        "Bountywell API health could not be confirmed.",
      );
    } finally {
      await scenario.close();
    }
  });

  test("a primary-only healthy observation answers with explicit authentication uncertainty", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-telephone-primary-only-"),
    );
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: Array.from(
        { length: 8 },
        (_, index) => `primary-only-id-${index + 1}`,
      ),
      now: "2026-08-17T15:30:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-17T15:30:01.000Z",
        rejectedEvidenceCount: 0,
        uncertainty: "The authentication-boundary check was unavailable.",
      },
    });

    try {
      const result = await scenario.receiveProviderEvent({
        deliveryId: "primary-only-delivery-001",
        kind: "turn-finalized",
        occurredAt: "2026-08-17T15:30:00.500Z",
        stt: { durationMs: 300, provider: "assemblyai" },
        telephoneSessionId: "telephone-session-primary-only",
        transcript: "Is Bountywell healthy?",
        turnId: "primary-only-delivery-001",
      });

      expect(result.actions[0]).toMatchObject({
        kind: "speak-semantic-response",
        text:
          "Bountywell's API is healthy. The primary /api/health check returned 200. The authentication-boundary check was unavailable. Some secondary registered checks were unavailable, so the answer is limited to the supported facts. Uncertainty: The authentication-boundary check was unavailable.",
      });
    } finally {
      await scenario.close();
    }
  });

  test("spoken credential forms are redacted before session or task evidence is retained", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-telephone-redaction-"),
    );
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: Array.from(
        { length: 8 },
        (_, index) => `redaction-id-${index + 1}`,
      ),
      now: "2026-08-17T15:45:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
          {
            facts: { statusCode: 401 },
            outcome: "pass",
            source: "authentication-boundary",
            summary: "The protected data endpoint required authentication.",
          },
        ],
        observedAt: "2026-08-17T15:45:01.000Z",
        rejectedEvidenceCount: 0,
      },
    });

    try {
      const result = await scenario.receiveProviderEvent({
        deliveryId: "redaction-delivery-001",
        kind: "turn-finalized",
        occurredAt: "2026-08-17T15:45:00.500Z",
        stt: { durationMs: 300, provider: "assemblyai" },
        telephoneSessionId: "telephone-session-redaction",
        transcript:
          "Is Bountywell healthy? My password is: hunter2, the API key equals sk-live-secret, and our token was tok-sensitive",
        turnId: "redaction-delivery-001",
      });
      const action = result.actions[0];
      if (action?.kind !== "speak-semantic-response") {
        throw new Error("Expected a semantic spoken response");
      }
      const record = await scenario.readEvidenceRecord(action.taskId);
      const retained = JSON.stringify({
        record,
        sessionEvidence: scenario.sessionEvidence,
      });
      expect(retained).not.toContain("hunter2");
      expect(retained).not.toContain("sk-live-secret");
      expect(retained).not.toContain("tok-sensitive");
      expect(retained).toContain("[redacted]");
    } finally {
      await scenario.close();
    }
  });

  test("duplicated finalized turns and interruption events converge on one Operation and conclusion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-duplicate-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: Array.from({ length: 24 }, (_, index) => `duplicate-id-${index + 1}`),
      now: "2026-08-17T16:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
          {
            facts: { statusCode: 401 },
            outcome: "pass",
            source: "authentication-boundary",
            summary: "The protected data endpoint required authentication.",
          },
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "local-health",
            summary: "The registered local endpoint responded successfully.",
          },
          {
            facts: { active: true },
            outcome: "pass",
            source: "service-state",
            summary: "The registered API service is active.",
          },
          {
            facts: { availability: "available" },
            outcome: "pass",
            source: "resource-health",
            summary: "No bounded resource-health check failed.",
          },
        ],
        observedAt: "2026-08-17T16:00:01.000Z",
        rejectedEvidenceCount: 0,
      },
    });
    const finalizedTurn = {
      deliveryId: "duplicate-delivery-001",
      kind: "turn-finalized" as const,
      occurredAt: "2026-08-17T16:00:00.500Z",
      stt: { durationMs: 300, provider: "assemblyai" },
      telephoneSessionId: "telephone-session-duplicate",
      transcript: "Is Bountywell up and healthy?",
      turnId: "duplicate-delivery-001",
    };
    const redeliveredTurn = {
      ...finalizedTurn,
      deliveryId: "duplicate-delivery-002",
      occurredAt: "2026-08-17T16:00:00.717Z",
    };

    try {
      const first = await scenario.receiveProviderEvent(finalizedTurn);
      const duplicate = await scenario.receiveProviderEvent(redeliveredTurn);
      expect(duplicate).toEqual({ actions: [] });
      const spoken = first.actions[0];
      if (spoken?.kind !== "speak-semantic-response") {
        throw new Error("Expected a semantic spoken response");
      }
      await expect(
        scenario.receiveProviderEvent({
          ...redeliveredTurn,
          deliveryId: "duplicate-delivery-003",
          transcript: "Restart Bountywell production",
        }),
      ).resolves.toEqual({
        actions: [
          {
            interruptible: false,
            kind: "play-prerecorded-failure-and-end",
            taskId: spoken.taskId,
            text:
              "The voice service is temporarily unavailable. Please check the Evidence Record.",
          },
        ],
      });

      const interruption = {
        deliveryId: "interruption-delivery-001",
        durationMs: 640,
        kind: "response-interrupted" as const,
        occurredAt: "2026-08-17T16:00:02.000Z",
        responseId: spoken.responseId,
        taskId: spoken.taskId,
      };
      await expect(scenario.receiveProviderEvent(interruption)).resolves.toEqual({
        actions: [],
      });
      await expect(scenario.receiveProviderEvent(interruption)).resolves.toEqual({
        actions: [],
      });

      expect(scenario.brokerRequests).toHaveLength(1);
      const record = await scenario.readEvidenceRecord(spoken.taskId);
      expect(record?.task).toMatchObject({
        conclusion: "Bountywell API is healthy.",
        status: "completed",
      });
      expect(
        record?.evidence.filter(
          (event) => event.kind === "telephone.turn.finalized",
        ),
      ).toHaveLength(1);
      expect(
        scenario.sessionEvidence.filter(
          (event) => event.kind === "telephone.turn.finalized",
        ),
      ).toHaveLength(1);
      expect(
        record?.evidence.filter(
          (event) => event.kind === "telephone.semantic.response",
        ),
      ).toHaveLength(1);
      expect(
        record?.evidence.filter(
          (event) => event.kind === "telephone.response.interrupted",
        ),
      ).toHaveLength(1);
      expect(
        record?.evidence.filter(
          (event) => event.kind === "telephone.provider.failure",
        ),
      ).toHaveLength(1);
      expect(
        scenario.sessionEvidence.filter(
          (event) => event.kind === "telephone.provider.failure",
        ),
      ).toHaveLength(1);
      expect(scenario.failureNotifications).toHaveLength(1);
    } finally {
      await scenario.close();
    }
  });

  test("a state-changing interpretation requires Task Confirmation without gaining control authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-confirmation-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: ["must-not-be-used"],
      now: "2026-08-17T17:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-17T17:00:01.000Z",
        rejectedEvidenceCount: 0,
      },
      stateChangingDecisions: ["accepted", "accepted"],
    });

    try {
      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "confirmation-delivery-001",
          kind: "turn-finalized",
          occurredAt: "2026-08-17T17:00:00.500Z",
          stt: { durationMs: 330, provider: "assemblyai" },
          telephoneSessionId: "telephone-session-confirmation",
          transcript: "Restart Bountywell production so the API becomes healthy",
          turnId: "confirmation-delivery-001",
        }),
      ).resolves.toEqual({
        actions: [
          {
            confirmationId: "confirmation-delivery-001:confirmation",
            interruptible: true,
            kind: "request-task-confirmation",
            text:
              "Please confirm this state-changing task: Bountywell production — Restart Bountywell production so the API becomes healthy.",
          },
        ],
      });
      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "confirmation-delivery-002",
          kind: "turn-finalized",
          occurredAt: "2026-08-17T17:00:01.500Z",
          stt: { durationMs: 280, provider: "assemblyai" },
          telephoneSessionId: "telephone-session-confirmation",
          transcript: "Yes, please",
          turnId: "confirmation-delivery-002",
        }),
      ).resolves.toEqual({
        actions: [
          {
            interruptible: true,
            kind: "speak-guidance",
            responseId: "confirmation-delivery-002:guidance",
            text:
              "Task confirmation recorded. Use the secure app to authorize execution.",
          },
        ],
      });
      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "confirmation-delivery-003",
          kind: "turn-finalized",
          occurredAt: "2026-08-17T17:00:02.500Z",
          stt: { durationMs: 280, provider: "assemblyai" },
          telephoneSessionId: "telephone-session-confirmation",
          transcript: "Deploy the Bountywell fix now",
          turnId: "confirmation-delivery-003",
        }),
      ).resolves.toMatchObject({
        actions: [{ kind: "request-task-confirmation" }],
      });
      expect(scenario.brokerRequests).toEqual([]);
    } finally {
      await scenario.close();
    }
  });

  test("provider timing and timeouts produce deterministic sanitized evidence and actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-provider-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBountywellScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      ids: Array.from({ length: 12 }, (_, index) => `provider-id-${index + 1}`),
      now: "2026-08-17T18:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
          {
            facts: { statusCode: 401 },
            outcome: "pass",
            source: "authentication-boundary",
            summary: "The protected data endpoint required authentication.",
          },
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "local-health",
            summary: "The registered local endpoint responded successfully.",
          },
          {
            facts: { active: true },
            outcome: "pass",
            source: "service-state",
            summary: "The registered API service is active.",
          },
          {
            facts: { availability: "available" },
            outcome: "pass",
            source: "resource-health",
            summary: "No bounded resource-health check failed.",
          },
        ],
        observedAt: "2026-08-17T18:00:01.000Z",
        rejectedEvidenceCount: 0,
      },
    });

    try {
      const answered = await scenario.receiveProviderEvent({
        deliveryId: "provider-turn-001",
        kind: "turn-finalized",
        occurredAt: "2026-08-17T18:00:00.500Z",
        stt: { durationMs: 290, provider: "assemblyai" },
        telephoneSessionId: "telephone-session-provider",
        transcript: "How is Bountywell doing?",
        turnId: "provider-turn-001",
      });
      const spoken = answered.actions[0];
      if (spoken?.kind !== "speak-semantic-response") {
        throw new Error("Expected a semantic spoken response");
      }

      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "tts-timing-001",
          durationMs: 410,
          kind: "provider-timing",
          occurredAt: "2026-08-17T18:00:01.500Z",
          provider: "inworld",
          stage: "tts",
          taskId: spoken.taskId,
        }),
      ).resolves.toEqual({ actions: [] });
      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "tts-timeout-001",
          kind: "provider-timeout",
          occurredAt: "2026-08-17T18:00:02.000Z",
          provider: "inworld",
          stage: "tts",
          taskId: spoken.taskId,
          timeoutMs: 10_000,
        }),
      ).resolves.toEqual({
        actions: [
          {
            interruptible: false,
            kind: "play-prerecorded-failure-and-end",
            taskId: spoken.taskId,
            text:
              "The voice service is temporarily unavailable. Please check the Evidence Record.",
          },
        ],
      });
      await expect(
        scenario.receiveProviderEvent({
          deliveryId: "coordinator-failure-001",
          failure: "unavailable",
          kind: "provider-failure",
          occurredAt: "2026-08-17T18:00:02.500Z",
          provider: "openai",
          stage: "coordinator",
          taskId: spoken.taskId,
        }),
      ).resolves.toEqual({
        actions: [
          {
            interruptible: false,
            kind: "play-prerecorded-failure-and-end",
            taskId: spoken.taskId,
            text:
              "The voice service is temporarily unavailable. Please check the Evidence Record.",
          },
        ],
      });

      const record = await scenario.readEvidenceRecord(spoken.taskId);
      expect(record?.evidence.at(-3)?.kind).toBe("telephone.provider.timing");
      expect(record?.evidence.at(-2)).toMatchObject({
        details: {
          failure: "timeout",
          provider: "inworld",
          stage: "tts",
        },
        kind: "telephone.provider.failure",
      });
      expect(record?.evidence.at(-1)).toMatchObject({
        details: {
          failure: "unavailable",
          provider: "openai",
          stage: "coordinator",
        },
        kind: "telephone.provider.failure",
      });
      expect(scenario.failureNotifications).toEqual([
        {
          failureEventId: "tts-timeout-001:failure",
          occurredAt: "2026-08-17T18:00:02.000Z",
        },
        {
          failureEventId: "coordinator-failure-001:failure",
          occurredAt: "2026-08-17T18:00:02.500Z",
        },
      ]);
      expect(JSON.stringify(record)).not.toContain("rawProviderPayload");
    } finally {
      await scenario.close();
    }
  });
});
