import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createBountywellHostProbes,
  createBountywellOperationsBroker,
  createOperationsBrokerServer,
  renderApplicationProbeMetrics,
  createDeterministicBountywellHost,
  createSqliteBrokerOperationStore,
  createSystemdBountywellServiceController,
  createUnixSocketBountywellController,
  createUnixSocketBountywellObserver,
  type BountywellHostProbes,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("the broker returns only fixed bounded evidence and replays its durable result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-broker-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "broker.sqlite");
  let probeCount = 0;
  const probes: BountywellHostProbes = {
    async readAuthenticationBoundaryStatus() {
      probeCount += 1;
      return 401;
    },
    async readLocalHealthStatus() {
      probeCount += 1;
      return 200;
    },
    async readPublicHealthStatus() {
      probeCount += 1;
      return 200;
    },
    async readResourceEvidence() {
      probeCount += 1;
      return {
        availability: "available",
        memoryPressure: false,
        taskPressure: false,
      };
    },
    async readServiceMetadata() {
      probeCount += 1;
      return { active: true, subState: "running" };
    },
  };
  const firstStore = createSqliteBrokerOperationStore(databasePath);
  const broker = createBountywellOperationsBroker({
    now: () => "2026-08-15T20:00:00.000Z",
    probes,
    store: firstStore,
  });
  const request = { operationId: "operation-broker", taskId: "task-broker" };

  const observation = await broker.observe(request);
  expect(observation).toEqual({
    checks: [
      {
        facts: { statusCode: 200 },
        outcome: "pass",
        provenance: "bountywell-public:/api/health",
        source: "public-health",
        summary: "The public health endpoint returned the required 200 status.",
      },
      {
        facts: { statusCode: 401 },
        outcome: "pass",
        provenance: "bountywell-public:/api/data",
        source: "authentication-boundary",
        summary: "The protected data endpoint preserved its 401 boundary.",
      },
      {
        facts: { statusCode: 200 },
        outcome: "pass",
        provenance: "bountywell-local:/api/health",
        source: "local-health",
        summary: "The registered local health endpoint returned 200.",
      },
      {
        facts: { active: true, subState: "running" },
        outcome: "pass",
        provenance: "systemd:bountywell-api.service",
        source: "service-state",
        summary: "The registered systemd unit is active and running.",
      },
      {
        facts: {
          availability: "available",
          memoryPressure: false,
          taskPressure: false,
        },
        outcome: "pass",
        provenance: "systemd:bountywell-api.service:cgroup",
        source: "resource-health",
        summary: "Bounded service resource thresholds are not under pressure.",
      },
    ],
    observedAt: "2026-08-15T20:00:00.000Z",
    rejectedEvidenceCount: 0,
    uncertainty:
      "This same-host inquiry cannot independently detect loss of the Agent Host or its network.",
  });
  expect(probeCount).toBe(5);
  await firstStore.close();

  const replayStore = createSqliteBrokerOperationStore(databasePath);
  const replayBroker = createBountywellOperationsBroker({
    now: () => "2026-08-15T21:00:00.000Z",
    probes: rejectingProbes(),
    store: replayStore,
  });
  try {
    expect(await replayBroker.observe(request)).toEqual(observation);
  } finally {
    await replayStore.close();
  }
});

test("the production probe adapter can observe only the registered Bountywell targets", async () => {
  const requestedUrls: string[] = [];
  const requestedUnits: string[] = [];
  const probes = createBountywellHostProbes({
    async readUnitProperties(unit) {
      requestedUnits.push(unit);
      return {
        ActiveState: "active",
        MemoryCurrent: String(64 * 1024 * 1024),
        SubState: "running",
        TasksCurrent: "12",
      };
    },
    async requestStatus(url) {
      requestedUrls.push(url);
      if (url.endsWith("/api/data")) return 401;
      return 200;
    },
  });

  expect(await probes.readPublicHealthStatus()).toBe(200);
  expect(await probes.readAuthenticationBoundaryStatus()).toBe(401);
  expect(await probes.readLocalHealthStatus()).toBe(200);
  expect(await probes.readServiceMetadata()).toEqual({
    active: true,
    subState: "running",
  });
  expect(await probes.readResourceEvidence()).toEqual({
    availability: "available",
    memoryPressure: false,
    taskPressure: false,
  });
  expect(requestedUrls).toEqual([
    "https://bountywell.com/api/health",
    "https://bountywell.com/api/data",
    "http://127.0.0.1:3000/api/health",
  ]);
  expect(requestedUnits).toEqual([
    "bountywell-api.service",
    "bountywell-api.service",
  ]);
});

test("unavailable resource properties remain unknown instead of claiming pressure", async () => {
  const probes = createBountywellHostProbes({
    async readUnitProperties() {
      return {
        ActiveState: "active",
        MemoryCurrent: "[not set]",
        SubState: "running",
        TasksCurrent: "[not set]",
      };
    },
  });

  expect(await probes.readResourceEvidence()).toEqual({
    availability: "unavailable",
  });
});

test("monitoring probes publish only bounded application and API health labels", async () => {
  const metrics = await renderApplicationProbeMetrics({
    bountywell: {
      async readAuthenticationBoundaryStatus() { return 401; },
      async readLocalHealthStatus() { return 200; },
      async readPublicHealthStatus() { return 200; },
      async readResourceEvidence() {
        return {
          availability: "available",
          memoryPressure: false,
          taskPressure: false,
        };
      },
      async readServiceMetadata() {
        return { active: true, subState: "running" };
      },
    },
    now: () => new Date("2026-08-17T20:00:00.000Z"),
    voiceAgent: {
      async readApiHealthStatus() { return 200; },
      async readBrokerHealthStatus() { return 200; },
      async readWorkerHealthStatus() { return 200; },
    },
  });

  expect(metrics).toContain(
    'voice_agent_application_probe_success{application="voice-agent",probe="api-health"} 1',
  );
  expect(metrics).toContain(
    'voice_agent_application_probe_success{application="bountywell",probe="authentication-boundary"} 1',
  );
  expect(metrics).toContain(
    'voice_agent_application_probe_success{application="bountywell",probe="resource-health"} 1',
  );
  expect(metrics).toContain("voice_agent_monitoring_same_host 1");
  expect(metrics).toContain(
    "voice_agent_application_probe_last_run_unixtime_seconds 1786996800",
  );
  expect(metrics).not.toContain("https://bountywell.com");
  expect(metrics).not.toContain("bountywell-api.service");
});

test("a broker restart completes an accepted Operation as uncertain without repeating probes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-broker-interrupted-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "broker.sqlite");
  const request = {
    operationId: "operation-interrupted",
    taskId: "task-interrupted",
  };
  const interruptedStore = createSqliteBrokerOperationStore(databasePath);
  expect(
    await interruptedStore.begin(request, "2026-08-15T20:00:00.000Z"),
  ).toEqual({ kind: "execute" });
  await interruptedStore.close();

  const replayStore = createSqliteBrokerOperationStore(databasePath);
  const replayBroker = createBountywellOperationsBroker({
    now: () => "2026-08-15T20:01:00.000Z",
    probes: rejectingProbes(),
    store: replayStore,
  });

  try {
    const observation = await replayBroker.observe(request);
    expect(observation.checks).toHaveLength(5);
    expect(observation.checks.every((check) => check.outcome === "fail")).toBe(true);
    expect(observation.uncertainty).toContain(
      "accepted broker Operation was interrupted",
    );
    expect(await replayBroker.observe(request)).toEqual(observation);
  } finally {
    await replayStore.close();
  }
});

test("the worker reaches the bounded broker contract through a Unix socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-broker-socket-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "broker.sock");
  const expected = {
    checks: [
      {
        facts: { statusCode: 200 },
        outcome: "pass" as const,
        provenance: "bountywell-public:/api/health",
        source: "public-health" as const,
        summary: "The public health endpoint returned the required 200 status.",
      },
    ],
    observedAt: "2026-08-15T23:00:00.000Z",
    rejectedEvidenceCount: 0,
  };
  const server = createOperationsBrokerServer({
    observer: { async observe() { return expected; } },
  });
  await server.listen(socketPath);
  const client = createUnixSocketBountywellObserver(socketPath);

  try {
    expect(
      await client.observe({ operationId: "operation-socket", taskId: "task-socket" }),
    ).toEqual(expected);
  } finally {
    await server.close();
  }
});

test("the broker starts only the registered unit and replays timer arming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-broker-control-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "broker.sock");
  let nowMs = Date.parse("2026-08-18T19:00:00.000Z");
  const host = createDeterministicBountywellHost({
    advanceMs(milliseconds) {
      nowMs += milliseconds;
    },
    now: () => new Date(nowMs).toISOString(),
  });
  const server = createOperationsBrokerServer({
    controller: host.controller,
    observer: { async observe() {
      throw new Error("observe is not used");
    } },
  });
  await server.listen(socketPath);
  const client = createUnixSocketBountywellController(socketPath);

  try {
    expect(await client.armRecoveryTimer()).toEqual({
      armed: true,
      delaySeconds: 600,
      unit: "bountywell-api.service",
    });
    expect(await client.stopRegisteredUnit()).toEqual({ stopped: true });
    expect(await client.startRegisteredUnit()).toEqual({
      previousActive: false,
      started: true,
    });
    expect(await client.startRegisteredUnit()).toEqual({
      previousActive: true,
      started: true,
    });
    expect(host.commands.every((command) => command.unit === "bountywell-api.service")).toBe(
      true,
    );
  } finally {
    await server.close();
  }
});

test("a pinned recovery timer can be armed when systemctl link is denied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-broker-pinned-timer-"));
  temporaryDirectories.push(directory);
  const controller = createSystemdBountywellServiceController({
    unitDirectory: directory,
    async execute(_command, args) {
      if (args[0] === "link" || args[0] === "daemon-reload") {
        throw new Error("Access denied");
      }
      if (args[0] === "start" && args[1] === "bountywell-api-recovery.timer") {
        return "";
      }
      throw new Error(`unexpected systemctl ${args.join(" ")}`);
    },
  });

  expect(await controller.armRecoveryTimer()).toEqual({
    armed: true,
    delaySeconds: 600,
    unit: "bountywell-api.service",
  });
});

test("stopping a pinned recovery timer removes it when disable is denied", async () => {
  const controller = createSystemdBountywellServiceController({
    async execute(_command, args) {
      if (args[0] === "stop" && args[1] === "bountywell-api-recovery.timer") {
        return "";
      }
      if (args[0] === "disable") {
        throw new Error("Access denied");
      }
      throw new Error(`unexpected systemctl ${args.join(" ")}`);
    },
  });

  expect(await controller.removeRecoveryTimer()).toEqual({ removed: true });
});

function rejectingProbes(): BountywellHostProbes {
  const reject = () => Promise.reject(new Error("probes must not repeat"));
  return {
    readAuthenticationBoundaryStatus: reject,
    readLocalHealthStatus: reject,
    readPublicHealthStatus: reject,
    readResourceEvidence: reject,
    readServiceMetadata: reject,
  };
}
