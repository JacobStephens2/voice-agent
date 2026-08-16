import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createBountywellHealthScenario } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Bountywell health inquiry scenario", () => {
  test("the fixed read-only Bountywell registration gates inquiry acceptance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-registration-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellHealthScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: [
        "registration-001",
        "task-registration",
        "operation-registration",
        "event-registration-1",
        "event-registration-2",
        "event-registration-3",
        "event-registration-4",
        "event-registration-5",
      ],
      now: "2026-08-15T13:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-15T13:00:01.000Z",
        rejectedEvidenceCount: 0,
      },
      registered: false,
    });

    try {
      await expect(
        scenario.submit({
          question: "Is Bountywell healthy?",
          requestId: "request-registration",
        }),
      ).rejects.toThrow("Bountywell is not registered");

      const registration = await scenario.registerBountywell();
      expect(registration).toMatchObject({
        applicationId: "bountywell-production",
        capabilities: [
          "bountywell.public-health.read",
          "bountywell.authentication-boundary.read",
          "bountywell.local-health.read",
          "bountywell.service-metadata.read",
          "bountywell.resource-evidence.read",
        ],
        healthSemantics: {
          authenticationBoundary: { expectedStatus: 401, path: "/api/data" },
          primary: { expectedStatus: 200, path: "/api/health" },
          registeredLocal: {
            expectedStatus: 200,
            path: "/api/health",
            port: 3000,
          },
        },
        serviceUnit: "bountywell-api.service",
      });

      const record = await scenario.submit({
        question: "Is Bountywell healthy?",
        requestId: "request-registration",
      });
      expect(record.task.status).toBe("completed");
    } finally {
      await scenario.close();
    }
  });

  test("a healthy inquiry produces a supported Evidence Record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-scenario-"));
    temporaryDirectories.push(directory);

    const scenario = await createBountywellHealthScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: [
        "task-001",
        "operation-001",
        "event-001",
        "event-002",
        "event-003",
        "event-004",
        "event-005",
      ],
      now: "2026-08-15T14:00:00.000Z",
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
            facts: { active: true },
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
        observedAt: "2026-08-15T14:00:00.000Z",
        rejectedEvidenceCount: 2,
      },
    });

    try {
      const record = await scenario.submit({
        question: "Is Bountywell healthy?",
        requestId: "request-001",
      });

      expect(record).toEqual({
        evidence: [
          {
            details: { requestId: "request-001" },
            id: "event-001",
            kind: "task.accepted",
            occurredAt: "2026-08-15T14:00:00.000Z",
            sequence: 1,
            summary: "Bountywell health inquiry accepted.",
          },
          {
            details: { operationId: "operation-001" },
            id: "event-002",
            kind: "operation.accepted",
            occurredAt: "2026-08-15T14:00:00.000Z",
            sequence: 2,
            summary: "Read-only Bountywell health observation accepted.",
          },
          {
            details: {
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
                  facts: { active: true },
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
              rejectedEvidenceCount: 2,
            },
            id: "event-003",
            kind: "evidence.observed",
            occurredAt: "2026-08-15T14:00:00.000Z",
            sequence: 3,
            summary: "Bounded Bountywell health evidence observed.",
          },
          {
            details: { operationId: "operation-001" },
            id: "event-004",
            kind: "operation.completed",
            occurredAt: "2026-08-15T14:00:00.000Z",
            sequence: 4,
            summary: "Read-only Bountywell health observation completed.",
          },
          {
            details: {},
            id: "event-005",
            kind: "task.completed",
            occurredAt: "2026-08-15T14:00:00.000Z",
            sequence: 5,
            summary: "Bountywell API is healthy.",
          },
        ],
        task: {
          conclusion: "Bountywell API is healthy.",
          createdAt: "2026-08-15T14:00:00.000Z",
          id: "task-001",
          kind: "bountywell.health.inquiry",
          question: "Is Bountywell healthy?",
          status: "completed",
          updatedAt: "2026-08-15T14:00:00.000Z",
        },
      });
      expect(scenario.brokerRequests).toEqual([
        { operationId: "operation-001", taskId: "task-001" },
      ]);
    } finally {
      await scenario.close();
    }
  });

  test("replay and restart return persisted evidence without repeating the broker request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-replay-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tasks.sqlite");
    const observation = {
      checks: [
        {
          facts: { statusCode: 200 },
          outcome: "pass" as const,
          source: "public-health" as const,
          summary: "The public health endpoint responded successfully.",
        },
      ],
      observedAt: "2026-08-15T15:00:00.000Z",
      rejectedEvidenceCount: 0,
    };

    const scenario = await createBountywellHealthScenario({
      databasePath,
      ids: [
        "task-replay",
        "operation-replay",
        "event-replay-1",
        "event-replay-2",
        "event-replay-3",
        "event-replay-4",
        "event-replay-5",
      ],
      now: "2026-08-15T15:00:00.000Z",
      observation,
    });

    const request = {
      question: "Is Bountywell healthy?",
      requestId: "request-replay",
    };

    const firstRecord = await scenario.submit(request);
    const immediateReplay = await scenario.submit(request);
    const operationReplay = await scenario.replayOperation("operation-replay");

    expect(immediateReplay).toEqual(firstRecord);
    expect(operationReplay).toEqual(firstRecord);
    expect(scenario.brokerRequests).toHaveLength(1);
    await scenario.close();

    const reopenedScenario = await createBountywellHealthScenario({
      databasePath,
      ids: ["must-not-be-used"],
      now: "2026-08-15T16:00:00.000Z",
      observation,
    });

    try {
      const restartedReplay = await reopenedScenario.submit(request);
      expect(restartedReplay).toEqual(firstRecord);
      expect(reopenedScenario.brokerRequests).toEqual([]);
    } finally {
      await reopenedScenario.close();
    }
  });

  test("an accepted inquiry survives a worker restart before the broker runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-accepted-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "tasks.sqlite");
    const observation = {
      checks: [
        {
          facts: { statusCode: 200 },
          outcome: "pass" as const,
          source: "public-health" as const,
          summary: "The public health endpoint responded successfully.",
        },
      ],
      observedAt: "2026-08-15T16:00:01.000Z",
      rejectedEvidenceCount: 0,
    };
    const request = {
      question: "Is Bountywell healthy?" as const,
      requestId: "request-accepted",
    };
    const apiProcess = await createBountywellHealthScenario({
      databasePath,
      ids: [
        "task-accepted",
        "operation-accepted",
        "event-accepted-1",
        "event-accepted-2",
      ],
      now: "2026-08-15T16:00:00.000Z",
      observation,
    });

    const accepted = await apiProcess.accept(request);
    expect(accepted.task.status).toBe("pending");
    expect(apiProcess.brokerRequests).toEqual([]);
    await apiProcess.close();

    const workerProcess = await createBountywellHealthScenario({
      databasePath,
      ids: ["event-accepted-3", "event-accepted-4", "event-accepted-5"],
      now: "2026-08-15T16:00:01.000Z",
      observation,
    });
    try {
      expect(await workerProcess.accept(request)).toEqual(accepted);
      const completed = await workerProcess.processNext();
      expect(completed?.task.status).toBe("completed");
      expect(workerProcess.brokerRequests).toEqual([
        { operationId: "operation-accepted", taskId: "task-accepted" },
      ]);
      expect(await workerProcess.processNext()).toBeUndefined();
    } finally {
      await workerProcess.close();
    }
  });

  test("concurrent duplicate submissions retain one Durable Task and Operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-duplicate-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellHealthScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: Array.from({ length: 12 }, (_value, index) => `duplicate-${index + 1}`),
      now: "2026-08-15T16:30:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-15T16:30:01.000Z",
        rejectedEvidenceCount: 0,
      },
    });
    const request = {
      question: "Is Bountywell healthy?" as const,
      requestId: "request-duplicate",
    };

    try {
      const [first, second] = await Promise.all([
        scenario.accept(request),
        scenario.accept(request),
      ]);
      expect(second).toEqual(first);
      expect(scenario.brokerRequests).toEqual([]);

      const completed = await scenario.processNext();
      expect(completed?.task.id).toBe(first.task.id);
      expect(scenario.brokerRequests).toHaveLength(1);
      expect(await scenario.processNext()).toBeUndefined();
    } finally {
      await scenario.close();
    }
  });

  test("the PWA reads a sanitized chronological Evidence Record through the API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-projection-"));
    temporaryDirectories.push(directory);
    const rejectedMaterial = "authorization: Bearer must-never-leave-the-broker";
    const scenario = await createBountywellHealthScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: [
        "task-page",
        "operation-page",
        "event-page-1",
        "event-page-2",
        "event-page-3",
        "event-page-4",
        "event-page-5",
      ],
      now: "2026-08-15T17:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-15T17:00:01.000Z",
        rejectedEvidenceCount: 1,
      },
      rejectedBrokerMaterial: [rejectedMaterial],
    });

    try {
      const record = await scenario.submit({
        question: "Is Bountywell healthy?",
        requestId: "request-page",
      });
      const denied = await scenario.readTaskPage(record.task.id);
      expect(denied.statusCode).toBe(401);
      expect(JSON.stringify(denied.body)).not.toContain(record.task.conclusion);

      const page = await scenario.readTaskPage(
        record.task.id,
        "scenario-trusted-session",
      );

      expect(page.statusCode).toBe(200);
      expect(page.headers["content-security-policy"]).toContain(
        "default-src 'self'",
      );
      expect(page.headers["strict-transport-security"]).toContain(
        "max-age=63072000",
      );
      expect(page.body).toEqual(record);
      expect(page.html).toContain("Bountywell API is healthy.");
      expect(page.html).toContain("completed");
      expect(page.html).toContain("<details");
      expect(page.html.indexOf("Inquiry accepted")).toBeLessThan(
        page.html.indexOf("Health evidence observed"),
      );
      expect(page.html.indexOf("Health evidence observed")).toBeLessThan(
        page.html.indexOf("Inquiry completed"),
      );
      expect(JSON.stringify(page)).not.toContain(rejectedMaterial);
    } finally {
      await scenario.close();
    }
  });

  test("an unsupported request is rejected before any broker operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-policy-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellHealthScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: [
        "task-policy",
        "operation-policy",
        "event-policy-1",
        "event-policy-2",
        "event-policy-3",
        "event-policy-4",
        "event-policy-5",
      ],
      now: "2026-08-15T18:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 200 },
            outcome: "pass",
            source: "public-health",
            summary: "The public health endpoint responded successfully.",
          },
        ],
        observedAt: "2026-08-15T18:00:00.000Z",
        rejectedEvidenceCount: 0,
      },
    });

    try {
      await expect(
        scenario.submit({
          question: "Restart every service on the server.",
          requestId: "request-policy",
        }),
      ).rejects.toThrow("Unsupported Bountywell health inquiry");
      expect(scenario.brokerRequests).toEqual([]);
    } finally {
      await scenario.close();
    }
  });

  test("a passing unrelated check does not support a healthy API conclusion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-support-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellHealthScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: [
        "task-support",
        "operation-support",
        "event-support-1",
        "event-support-2",
        "event-support-3",
        "event-support-4",
        "event-support-5",
      ],
      now: "2026-08-15T19:00:00.000Z",
      observation: {
        checks: [
          {
            facts: { availability: "available", diskPressure: false },
            outcome: "pass",
            source: "resource-health",
            summary: "No bounded resource-health check failed.",
          },
        ],
        observedAt: "2026-08-15T19:00:00.000Z",
        rejectedEvidenceCount: 0,
      },
    });

    try {
      const record = await scenario.submit({
        question: "Is Bountywell healthy?",
        requestId: "request-support",
      });

      expect(record.task.conclusion).toBe(
        "Bountywell API health could not be confirmed.",
      );
    } finally {
      await scenario.close();
    }
  });

  test("a 401 authentication boundary does not replace primary health evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-primary-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellHealthScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: [
        "task-primary",
        "operation-primary",
        "event-primary-1",
        "event-primary-2",
        "event-primary-3",
        "event-primary-4",
        "event-primary-5",
      ],
      now: "2026-08-15T19:30:00.000Z",
      observation: {
        checks: [
          {
            facts: { statusCode: 401 },
            outcome: "pass",
            source: "authentication-boundary",
            summary: "The protected data endpoint required authentication.",
          },
        ],
        observedAt: "2026-08-15T19:30:00.000Z",
        rejectedEvidenceCount: 0,
      },
    });

    try {
      const record = await scenario.submit({
        question: "Is Bountywell healthy?",
        requestId: "request-primary",
      });
      expect(record.task.conclusion).toBe(
        "Bountywell API health could not be confirmed.",
      );
    } finally {
      await scenario.close();
    }
  });
});
