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
  let deploymentAuthorityUpgradeRequests = 0;
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
      async readDeploymentAuthorityUpgradeChallenge() {
        return {
          challenge: "c".repeat(43),
          commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          createdAt: "2026-08-15T22:00:00.000Z",
          expiresAt: "2026-08-15T22:05:00.000Z",
          kind: "authentication" as const,
          options: { challenge: "c".repeat(43) },
        };
      },
      async requestDeploymentAuthorityUpgrade() {
        deploymentAuthorityUpgradeRequests += 1;
        return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
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

    const authorityUpgradeOptions = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/deployment-authority/upgrade-authorization/options",
    });
    expect(authorityUpgradeOptions.statusCode).toBe(200);
    expect(authorityUpgradeOptions.json()).toEqual({
      kind: "authentication",
      options: { challenge: "c".repeat(43) },
    });

    const blockedAuthorityUpgrade = await api.inject({
      headers: { origin: "https://voice.stephens.page" },
      method: "POST",
      payload: { ceremonyId: "c".repeat(43), response: { id: "passkey" } },
      url: "/api/operations/deployment-authority/upgrade-authorization/verify",
    });
    expect(blockedAuthorityUpgrade.statusCode).toBe(401);
    expect(deploymentAuthorityUpgradeRequests).toBe(0);

    fresh = true;
    const authorizedUpgrade = await api.inject({
      headers,
      method: "POST",
      payload: { ceremonyId: "c".repeat(43), response: { id: "passkey" } },
      url: "/api/operations/deployment-authority/upgrade-authorization/verify",
    });
    expect(authorizedUpgrade.statusCode).toBe(202);
    expect(authorizedUpgrade.json()).toEqual({
      commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      status: "submitted",
    });
    expect(deploymentAuthorityUpgradeRequests).toBe(1);

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
    expect(metrics.body).toContain("voice_agent_policy_denials_total 3");
    expect(metrics.body).toMatch(/voice_agent_sqlite_database_bytes [1-9]\d*/u);
    expect(metrics.body).toMatch(
      /voice_agent_sqlite_filesystem_available_bytes [1-9]\d*/u,
    );
  } finally {
    await api.close();
    await runtime.close();
  }
});
