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

test("a Fresh Passkey Action enrolls restart authority; the drill itself runs on Standing Autonomy Policy", async () => {
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
  let ownerLive = true;
  const runtime = createDurableTaskRuntime({
    applicationRegistry: store,
    ownerAvailability: {
      async countLiveTelephoneSessions() {
        return ownerLive ? 1 : 0;
      },
    },
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

    // Arming, proving, and injecting run on the enrolled Standing Autonomy
    // Policy; only the authority expansion above needed a Fresh Passkey Action.
    fresh = false;

    // The guarded drill refuses to stop the unit before its backstop is armed.
    const earlyInject = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value", ownerAvailable: true },
      url: "/api/operations/bountywell-outage-drill/inject",
    });
    expect(earlyInject.statusCode).toBe(409);
    expect(earlyInject.json()).toEqual({ error: "Recovery timer is not armed" });
    expect(host.commands.filter((command) => command.action === "stop")).toEqual([]);

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

    const installsBeforeReplay = host.commands.filter(
      (command) => command.action === "install-timer",
    ).length;
    const rearmed = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/bountywell-outage-drill/arm-timer",
    });
    expect(rearmed.json()).toEqual(armed.json());
    expect(
      host.commands.filter((command) => command.action === "install-timer"),
    ).toHaveLength(installsBeforeReplay);
    await runtime.captureBountywellBaseline();

    const blockedInject = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value", ownerAvailable: false },
      url: "/api/operations/bountywell-outage-drill/inject",
    });
    expect(blockedInject.statusCode).toBe(400);

    // An asserted flag is not availability: the owner must be on a live
    // Telephone Session for the fault to be injected.
    ownerLive = false;
    const unattendedInject = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value", ownerAvailable: true },
      url: "/api/operations/bountywell-outage-drill/inject",
    });
    expect(unattendedInject.statusCode).toBe(400);
    expect(unattendedInject.json()).toEqual({
      error: "The live drill occurs only while the owner is available",
    });
    expect(host.commands.filter((command) => command.action === "stop")).toEqual([]);
    ownerLive = true;

    // Nothing has been presented to the Voice Agent before the fault exists.
    const earlyPresentation = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/bountywell-outage-drill/present",
    });
    expect(earlyPresentation.statusCode).toBe(409);

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

    const duplicateInject = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value", ownerAvailable: true },
      url: "/api/operations/bountywell-outage-drill/inject",
    });
    expect(duplicateInject.json()).toEqual(injected.json());
    expect(host.commands.filter((command) => command.action === "stop")).toEqual([
      { action: "stop", unit: "bountywell-api.service" },
    ]);
    expect(
      host.commands.every((command) => command.unit === "bountywell-api.service"),
    ).toBe(true);

    // The drill controller presents the Voice Agent with that one sentence.
    const presented = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/operations/bountywell-outage-drill/present",
    });
    expect(presented.statusCode).toBe(202);
    expect(presented.json()).toEqual({
      report: "Bountywell's API appears unavailable.",
      requestId: injected.json().requestId,
      taskId: injected.json().taskId,
    });
  } finally {
    await api.close();
    await runtime.close();
    await brokerStore.close();
  }
});
