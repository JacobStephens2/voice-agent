import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createTaskApi,
  trustedSessionCookieName,
} from "@voice-agent/api";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("the authenticated API registers and runs only the fixed Bountywell read capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-control-"));
  temporaryDirectories.push(directory);
  const store = createSqliteDurableTaskStore(join(directory, "tasks.sqlite"));
  const ids = ["task-control", "operation-control", "event-control-1", "event-control-2"];
  const runtime = createDurableTaskRuntime({
    applicationRegistry: store,
    nextId: () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("test ids exhausted");
      return id;
    },
    now: () => "2026-08-15T22:00:00.000Z",
    store,
  });
  let fresh = false;
  let promotionResumeRequests = 0;
  const api = createTaskApi({
    authentication: {
      async canChangeState({ csrfToken, sessionToken }) {
        return sessionToken === "trusted-session" && csrfToken === "csrf-token-value";
      },
      async canViewEvidence(sessionToken) {
        return sessionToken === "trusted-session";
      },
      async hasFreshPasskeyAction() {
        return fresh;
      },
    },
    controls: runtime,
    origin: "https://voice.stephens.page",
    promotionControl: {
      async requestResume() {
        promotionResumeRequests += 1;
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
    },
    records: runtime,
  });
  const headers = {
    cookie: `${trustedSessionCookieName}=trusted-session`,
    origin: "https://voice.stephens.page",
  };

  try {
    const notFresh = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/applications/bountywell/registration",
    });
    expect(notFresh.statusCode).toBe(403);

    const blockedResume = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/promotions/resume",
    });
    expect(blockedResume.statusCode).toBe(403);

    fresh = true;
    const queuedResume = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/promotions/resume",
    });
    expect(queuedResume.statusCode).toBe(202);
    expect(queuedResume.json()).toEqual({
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "queued",
    });
    expect(promotionResumeRequests).toBe(1);

    const registration = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/applications/bountywell/registration",
    });
    expect(registration.statusCode).toBe(200);
    expect(registration.json()).toMatchObject({
      applicationId: "bountywell-production",
      serviceUnit: "bountywell-api.service",
    });

    const arbitraryTarget = await api.inject({
      headers,
      method: "POST",
      payload: {
        csrfToken: "csrf-token-value",
        requestId: "request-control",
        service: "ssh.service",
      },
      url: "/api/tasks/bountywell-health",
    });
    expect(arbitraryTarget.statusCode).toBe(400);

    const accepted = await api.inject({
      headers,
      method: "POST",
      payload: {
        csrfToken: "csrf-token-value",
        requestId: "request-control",
      },
      url: "/api/tasks/bountywell-health",
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      task: {
        id: "task-control",
        question: "Is Bountywell healthy?",
        status: "pending",
      },
    });

    const metrics = await api.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain(
      'voice_agent_durable_tasks{status="pending"} 1',
    );
    expect(metrics.body).toContain(
      'voice_agent_operations{status="accepted"} 1',
    );
    expect(metrics.body).toContain("voice_agent_policy_denials_total 2");
    expect(metrics.body).toMatch(/voice_agent_sqlite_database_bytes [1-9]\d*/u);
    expect(metrics.body).toMatch(
      /voice_agent_sqlite_filesystem_available_bytes [1-9]\d*/u,
    );
  } finally {
    await api.close();
    await runtime.close();
  }
});
