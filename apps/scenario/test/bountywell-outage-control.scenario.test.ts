import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createTaskApi,
  trustedSessionCookieName,
} from "@voice-agent/api";
import {
  createBountywellOperationsBroker,
  createDeterministicBountywellHost,
  createSqliteBrokerOperationStore,
} from "@voice-agent/operations-broker";
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

test("Fresh Passkey Action is required to grant Bountywell restart and start the drill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-outage-control-"));
  temporaryDirectories.push(directory);
  const ids = Array.from({ length: 40 }, (_, index) => `control-${index + 1}`);
  let nowMs = Date.parse("2026-08-18T18:00:00.000Z");
  const now = () => new Date(nowMs).toISOString();
  const host = createDeterministicBountywellHost({
    advanceMs(milliseconds) {
      nowMs += milliseconds;
    },
    now,
  });
  const store = createSqliteDurableTaskStore(join(directory, "tasks.sqlite"));
  const brokerStore = createSqliteBrokerOperationStore(
    join(directory, "broker.sqlite"),
  );
  const runtime = createDurableTaskRuntime({
    advanceMs(milliseconds) {
      nowMs += milliseconds;
    },
    applicationRegistry: store,
    healthObserver: createBountywellOperationsBroker({
      now,
      probes: host.probes,
      store: brokerStore,
    }),
    nextId: () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("test ids exhausted");
      return id;
    },
    now,
    serviceController: host.controller,
    store,
  });
  let fresh = false;
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
    records: runtime,
  });
  const headers = {
    cookie: `${trustedSessionCookieName}=trusted-session`,
    origin: "https://voice.stephens.page",
  };

  try {
    await runtime.registerBountywell();

    const blockedGrant = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/applications/bountywell/restart-authority",
    });
    expect(blockedGrant.statusCode).toBe(403);

    fresh = true;
    const granted = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/applications/bountywell/restart-authority",
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({
      applicationId: "bountywell-production",
      revision: 2,
      serviceUnit: "bountywell-api.service",
    });
    expect(granted.json().capabilities).toContain("bountywell.service.restart");

    const armed = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/bountywell-outage-drill/arm-timer",
    });
    expect(armed.statusCode).toBe(200);
    expect(armed.json()).toEqual({
      armed: true,
      delaySeconds: 600,
      unit: "bountywell-api.service",
    });

    const proven = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/bountywell-outage-drill/prove-timer",
    });
    expect(proven.statusCode).toBe(200);
    expect(proven.json()).toEqual({
      capable: true,
      delaySeconds: 600,
      unit: "bountywell-api.service",
    });

    await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/bountywell-outage-drill/arm-timer",
    });
    await runtime.captureBountywellBaseline();

    const blockedInject = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value", ownerAvailable: false },
      url: "/api/operations/bountywell-outage-drill/inject",
    });
    expect(blockedInject.statusCode).toBe(400);

    const injected = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value", ownerAvailable: true },
      url: "/api/operations/bountywell-outage-drill/inject",
    });
    expect(injected.statusCode).toBe(202);
    expect(injected.json()).toMatchObject({
      report: "Bountywell's API appears unavailable.",
    });
  } finally {
    await api.close();
    await runtime.close();
    await brokerStore.close();
  }
});
