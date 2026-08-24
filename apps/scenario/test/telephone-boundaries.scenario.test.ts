import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createTelephoneBoundaryRuntime,
  formatTelephoneBoundaryPrometheusMetrics,
} from "@voice-agent/runtime";
import { createSqliteTelephoneBoundaryStore } from "@voice-agent/sqlite-store";

import { createTelephoneBoundaryScenario } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Telephone fail-closed boundaries", () => {
  test("excess sessions and state-changing tasks are explicitly rejected or queued", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-boundaries-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      now: "2026-08-17T12:00:00.000Z",
    });

    try {
      await expect(scenario.reserveWarmSession("session-1")).resolves.toEqual({
        decision: "accepted",
        resource: "warm-session",
      });
      await expect(scenario.reserveWarmSession("session-2")).resolves.toEqual({
        decision: "rejected",
        reason: "warm-session-limit",
        resource: "warm-session",
      });
      await expect(scenario.activateSession("session-1")).resolves.toEqual({
        decision: "accepted",
        resource: "active-session",
      });
      await expect(scenario.reserveWarmSession("session-1")).resolves.toEqual({
        decision: "rejected",
        reason: "warm-session-limit",
        resource: "warm-session",
      });

      await expect(scenario.reserveWarmSession("session-2")).resolves.toEqual({
        decision: "accepted",
        resource: "warm-session",
      });
      await expect(scenario.activateSession("session-2")).resolves.toEqual({
        decision: "rejected",
        reason: "active-session-limit",
        resource: "active-session",
      });

      await expect(
        scenario.claimStateChangingTask("session-1", "task-1"),
      ).resolves.toEqual({
        decision: "accepted",
        resource: "state-changing-task",
      });
      await expect(
        scenario.claimStateChangingTask("session-1", "task-2"),
      ).resolves.toEqual({
        decision: "queued",
        position: 1,
        resource: "state-changing-task",
      });
      await expect(
        scenario.claimStateChangingTask("session-1", "task-3"),
      ).resolves.toEqual({
        decision: "queued",
        position: 2,
        resource: "state-changing-task",
      });

      await expect(
        scenario.releaseStateChangingTask("session-1", "task-2"),
      ).resolves.toEqual({});

      await expect(
        scenario.releaseStateChangingTask("session-1", "task-1"),
      ).resolves.toEqual({ promotedOwnerId: "task-3" });

      const metrics = await scenario.readMetrics();
      expect(metrics.limitDecisions).toEqual({
        accepted: 4,
        queued: 2,
        rejected: 3,
      });
      expect(metrics.resources).toEqual({
        activeSessions: 1,
        queuedStateChangingTasks: 0,
        queuedSubagents: 0,
        runningSubagents: 0,
        warmSessions: 1,
      });
      expect(JSON.stringify(metrics)).not.toContain("task-1");
    } finally {
      await scenario.close();
    }
  });

  test("Subagent execution admits only one overlapping adapter globally", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-subagent-execution-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "voice-agent.sqlite");
    const scenario = await createTelephoneBoundaryScenario({
      databasePath,
      now: "2026-08-17T12:00:00.000Z",
    });
    const otherRuntime = await createTelephoneBoundaryScenario({
      databasePath,
      now: "2026-08-17T12:00:00.000Z",
    });
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executionOrder: string[] = [];

    try {
      const first = scenario.executeSubagent(
        "delegation-overlap-1",
        async () => {
          executionOrder.push("first-started");
          markFirstStarted();
          await holdFirst;
          executionOrder.push("first-finished");
          return "first-result";
        },
      );
      await firstStarted;
      let duplicateAdapterRan = false;
      await expect(
        scenario.executeSubagent("delegation-overlap-1", async () => {
          duplicateAdapterRan = true;
        }),
      ).rejects.toThrow("Subagent execution is already pending");
      expect(duplicateAdapterRan).toBe(false);
      await expect(
        otherRuntime.executeSubagent("delegation-overlap-1", async () => {
          duplicateAdapterRan = true;
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "duplicate-delegation",
        resource: "subagent",
      });
      expect(duplicateAdapterRan).toBe(false);

      let secondSettled = false;
      const second = otherRuntime
        .executeSubagent("delegation-overlap-2", async () => {
          executionOrder.push("second-started");
          return "second-result";
        })
        .finally(() => {
          secondSettled = true;
        });
      await expect(otherRuntime.readMetrics()).resolves.toMatchObject({
        resources: {
          queuedSubagents: 1,
          runningSubagents: 1,
        },
      });
      expect(executionOrder).toEqual(["first-started"]);
      expect(secondSettled).toBe(false);

      releaseFirst();
      await expect(first).resolves.toEqual({
        decision: "accepted",
        resource: "subagent",
        result: "first-result",
      });
      await expect(second).resolves.toEqual({
        decision: "accepted",
        resource: "subagent",
        result: "second-result",
      });
      expect(executionOrder).toEqual([
        "first-started",
        "first-finished",
        "second-started",
      ]);
      await expect(scenario.readMetrics()).resolves.toMatchObject({
        resources: {
          queuedSubagents: 0,
          runningSubagents: 0,
        },
      });
    } finally {
      releaseFirst();
      await otherRuntime.close();
      await scenario.close();
    }
  });

  test("cancelling a queued Subagent prevents its adapter from running", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-subagent-cancellation-"),
    );
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      now: "2026-08-17T12:00:00.000Z",
    });
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const cancellation = new AbortController();
    let cancelledAdapterRan = false;

    try {
      const first = scenario.executeSubagent("delegation-cancel-1", async () => {
        markFirstStarted();
        await holdFirst;
      });
      await firstStarted;
      const cancelled = scenario.executeSubagent(
        "delegation-cancel-2",
        async () => {
          cancelledAdapterRan = true;
        },
        cancellation.signal,
      );
      await expect(scenario.readMetrics()).resolves.toMatchObject({
        resources: { queuedSubagents: 1, runningSubagents: 1 },
      });

      cancellation.abort();
      await expect(cancelled).resolves.toEqual({
        decision: "cancelled",
        resource: "subagent",
      });
      expect(cancelledAdapterRan).toBe(false);
      await expect(scenario.readMetrics()).resolves.toMatchObject({
        resources: { queuedSubagents: 0, runningSubagents: 1 },
      });

      releaseFirst();
      await expect(first).resolves.toMatchObject({ decision: "accepted" });
    } finally {
      releaseFirst();
      await scenario.close();
    }
  });

  test("an expired Subagent lease cannot strand later execution", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-subagent-expiry-"),
    );
    temporaryDirectories.push(directory);
    const store = createSqliteTelephoneBoundaryStore(
      join(directory, "voice-agent.sqlite"),
    );

    try {
      await expect(
        store.claimSubagent({
          delegationId: "delegation-abandoned",
          executionId: "execution-abandoned",
          leaseExpiresAt: "2026-08-17T12:00:30.000Z",
          requestedAt: "2026-08-17T12:00:00.000Z",
        }),
      ).resolves.toEqual({
        decision: "accepted",
        resource: "subagent",
      });
      await expect(
        store.claimSubagent({
          delegationId: "delegation-next",
          executionId: "execution-next",
          leaseExpiresAt: "2026-08-17T12:00:30.000Z",
          requestedAt: "2026-08-17T12:00:00.000Z",
        }),
      ).resolves.toEqual({
        decision: "queued",
        position: 1,
        resource: "subagent",
      });

      await expect(
        store.claimSubagent({
          delegationId: "delegation-next",
          executionId: "execution-next",
          leaseExpiresAt: "2026-08-17T12:01:01.000Z",
          requestedAt: "2026-08-17T12:00:31.000Z",
        }),
      ).resolves.toEqual({
        decision: "accepted",
        resource: "subagent",
      });
      await expect(
        store.renewSubagentLease({
          delegationId: "delegation-abandoned",
          executionId: "execution-abandoned",
          leaseExpiresAt: "2026-08-17T12:01:01.000Z",
        }),
      ).resolves.toBe(false);
    } finally {
      await store.close();
    }
  });

  test("a lease-renewal failure aborts active Subagent execution", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-subagent-renewal-failure-"),
    );
    temporaryDirectories.push(directory);
    const durableStore = createSqliteTelephoneBoundaryStore(
      join(directory, "voice-agent.sqlite"),
    );
    const cancellation = new AbortController();
    const runtime = createTelephoneBoundaryRuntime({
      nextId: () => "unused-renewal-failure-id",
      now: () => "2026-08-17T12:00:00.000Z",
      store: {
        ...durableStore,
        async renewSubagentLease() {
          throw new Error("injected durable lease renewal failure");
        },
      },
      subagentLeaseDurationMs: 3_000,
    });
    let executionSignal: AbortSignal | undefined;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execution = runtime
      .executeSubagent(
        "delegation-renewal-failure",
        async (signal) => {
          executionSignal = signal;
          markStarted();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          return "adapter-stopped";
        },
        cancellation.signal,
      )
      .then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );

    try {
      await started;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(executionSignal?.aborted).toBe(true);
      await expect(execution).resolves.toEqual({
        status: "resolved",
        value: { decision: "cancelled", resource: "subagent" },
      });
    } finally {
      cancellation.abort();
      await execution;
      await runtime.close();
    }
  });

  test("active sessions end at configured prolonged silence and the two-hour maximum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-deadlines-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      now: "2026-08-17T12:00:00.000Z",
      prolongedSilenceMs: 90_000,
    });

    try {
      await scenario.reserveWarmSession("silent-session");
      await scenario.activateSession("silent-session");
      scenario.setTime("2026-08-17T12:01:29.999Z");
      await expect(
        scenario.enforceDeadline("silent-session"),
      ).resolves.toEqual({ ended: false });
      scenario.setTime("2026-08-17T12:01:30.000Z");
      await expect(
        scenario.enforceDeadline("silent-session"),
      ).resolves.toEqual({
        durationMs: 90_000,
        ended: true,
        reason: "prolonged-silence",
      });

      scenario.setTime("2026-08-17T13:00:00.000Z");
      await scenario.reserveWarmSession("maximum-session");
      await scenario.activateSession("maximum-session");
      scenario.setTime("2026-08-17T14:59:00.000Z");
      await scenario.noteActivity("maximum-session");
      scenario.setTime("2026-08-17T15:00:00.000Z");
      await expect(
        scenario.enforceDeadline("maximum-session"),
      ).resolves.toEqual({
        durationMs: 7_200_000,
        ended: true,
        reason: "maximum-duration",
      });

      scenario.setTime("2026-08-17T16:00:00.000Z");
      await scenario.reserveWarmSession("failed-session");
      await scenario.activateSession("failed-session");
      await expect(
        scenario.recordProviderFailure({
          failureClass: "timeout",
          sessionId: "failed-session",
          stage: "stt",
        }),
      ).resolves.toMatchObject({
        ended: true,
        reason: "provider-failure",
      });

      expect(scenario.evidence.map((event) => event.kind)).toEqual([
        "telephone.session.ended",
        "telephone.session.ended",
        "telephone.session.ended",
      ]);
      const metrics = await scenario.readMetrics();
      expect(metrics.sessionEndings).toEqual({
        maximumDuration: 1,
        prolongedSilence: 1,
        providerFailure: 1,
        other: 0,
      });
      expect(metrics.providerFailures).toEqual({
        agent: { timeout: 0, unavailable: 0 },
        coordinator: { timeout: 0, unavailable: 0 },
        setup: { timeout: 0, unavailable: 0 },
        stt: { timeout: 1, unavailable: 0 },
        tts: { timeout: 0, unavailable: 0 },
      });
      expect(metrics.totalDurationMs).toBe(7_290_000);
      expect(JSON.stringify(metrics)).not.toContain("maximum-session");
      const renderedMetrics = formatTelephoneBoundaryPrometheusMetrics(metrics);
      expect(renderedMetrics).toContain(
        'voice_agent_telephone_sessions{state="active"} 0',
      );
      expect(renderedMetrics).toContain(
        'voice_agent_telephone_sessions{state="warm"} 0',
      );
      expect(renderedMetrics).toContain(
        'voice_agent_telephone_provider_failures_total{stage="stt",class="timeout"} 1',
      );
      expect(renderedMetrics).not.toContain("failed-session");
    } finally {
      await scenario.close();
    }
  });

  test("durable recovery expires abandoned warm and active sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-recovery-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      now: "2026-08-17T12:00:00.000Z",
    });

    try {
      await scenario.reserveWarmSession("active-session");
      await scenario.activateSession("active-session");
      await scenario.reserveWarmSession("abandoned-warm-session");
      scenario.setTime("2026-08-17T14:00:00.000Z");

      await expect(scenario.enforceDeadlines()).resolves.toEqual({
        endedActiveSessions: 1,
        expiredWarmSessions: 1,
      });
      await expect(scenario.readSession("active-session")).resolves.toMatchObject({
        state: "ended",
      });
      await expect(
        scenario.readSession("abandoned-warm-session"),
      ).resolves.toMatchObject({ state: "ended" });
      await expect(scenario.reserveWarmSession("replacement-session")).resolves.toEqual({
        decision: "accepted",
        resource: "warm-session",
      });
    } finally {
      await scenario.close();
    }
  });

  test("combined monthly usage warns, closes admission, and protects accepted work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-spending-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      now: "2026-08-17T12:00:00.000Z",
    });

    try {
      await scenario.reserveWarmSession("accepted-session");
      await scenario.activateSession("accepted-session");
      await expect(
        scenario.recordUsage({
          amountMicrousd: 24_000_000,
          sessionId: "accepted-session",
          source: "api",
          usageId: "usage-api",
        }),
      ).resolves.toMatchObject({
        disposition: "continue",
        totalMicrousd: 24_000_000,
        warnings: [],
      });
      await expect(
        scenario.recordUsage({
          amountMicrousd: 1_000_000,
          sessionId: "accepted-session",
          source: "telephony",
          usageId: "usage-telephone",
        }),
      ).resolves.toMatchObject({
        disposition: "continue",
        totalMicrousd: 25_000_000,
        warnings: [25_000_000],
      });
      await expect(
        scenario.recordUsage({
          amountMicrousd: 15_000_000,
          sessionId: "accepted-session",
          source: "realtime-media",
          usageId: "usage-realtime",
        }),
      ).resolves.toMatchObject({
        disposition: "continue",
        totalMicrousd: 40_000_000,
        warnings: [40_000_000],
      });
      await expect(
        scenario.recordUsage({
          amountMicrousd: 10_000_000,
          sessionId: "accepted-session",
          source: "api",
          usageId: "usage-ceiling",
        }),
      ).resolves.toMatchObject({
        disposition: "safe-terminal-only",
        totalMicrousd: 50_000_000,
        warnings: [],
      });
      await expect(
        scenario.readSession("accepted-session"),
      ).resolves.toMatchObject({ mode: "safe-terminal-only", state: "active" });

      await expect(
        scenario.reserveWarmSession("rejected-session"),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "spending-ceiling",
        resource: "monthly-spend",
      });

      await expect(
        scenario.changeSpendingCeiling({
          ceilingMicrousd: 75_000_000,
          freshPasskey: false,
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "fresh-passkey-required",
      });
      await expect(
        scenario.changeSpendingCeiling({
          ceilingMicrousd: 75_000_000,
          freshPasskey: true,
        }),
      ).resolves.toMatchObject({
        ceilingMicrousd: 75_000_000,
        decision: "accepted",
      });

      scenario.setTime("2026-09-01T00:00:00.000Z");
      await scenario.endSession("accepted-session", "completed");
      await scenario.reserveWarmSession("new-month-session");
      await expect(
        scenario.activateSession("new-month-session"),
      ).resolves.toEqual({
        decision: "accepted",
        resource: "active-session",
      });

      const metrics = await scenario.readMetrics();
      expect(metrics.spending).toEqual({
        bySourceMicrousd: {
          api: 0,
          "realtime-media": 0,
          telephony: 0,
        },
        ceilingMicrousd: 75_000_000,
        month: "2026-09",
        totalMicrousd: 0,
      });
      expect(JSON.stringify(metrics)).not.toContain("usage-api");
    } finally {
      await scenario.close();
    }
  });

  test("rejects a complete paid slice atomically when it would exceed the monthly ceiling", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "voice-agent-spending-slice-"),
    );
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      now: "2026-08-17T12:00:00.000Z",
    });

    try {
      await scenario.recordUsage({
        amountMicrousd: 49_900_000,
        source: "api",
        usageId: "usage-before-slice",
      });

      await expect(
        scenario.reserveUsageSlice({
          amountsMicrousd: {
            api: 50_000,
            "realtime-media": 100_000,
            telephony: 50_000,
          },
          usageScopeId: "prelive:callback-1",
        }),
      ).resolves.toMatchObject({
        disposition: "safe-terminal-only",
        totalMicrousd: 49_900_000,
      });
      await expect(scenario.readMetrics()).resolves.toMatchObject({
        spending: {
          bySourceMicrousd: {
            api: 49_900_000,
            "realtime-media": 0,
            telephony: 0,
          },
          totalMicrousd: 49_900_000,
        },
      });
    } finally {
      await scenario.close();
    }
  });

  test("raw-audio debugging is session-scoped, passkey-gated, Subagent-proof, and expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-audio-debug-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      now: "2026-08-17T12:00:00.000Z",
      rawAudioDebugDirectory: join(directory, "debug-audio"),
    });

    try {
      await scenario.reserveWarmSession("debug-session");
      await scenario.activateSession("debug-session");
      await expect(
        scenario.authorizeRawAudioDebug({
          actor: "owner",
          freshPasskey: false,
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "fresh-passkey-required",
      });
      await expect(
        scenario.authorizeRawAudioDebug({
          actor: "subagent",
          freshPasskey: true,
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "subagent-ineligible",
      });
      await expect(
        scenario.claimRawAudioCapture({
          actor: "voice-agent",
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "debug-grant-required",
      });

      await expect(
        scenario.authorizeRawAudioDebug({
          actor: "owner",
          freshPasskey: true,
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "accepted",
        expiresAt: "2026-08-18T11:00:00.000Z",
      });
      await expect(
        scenario.authorizeRawAudioDebug({
          actor: "owner",
          freshPasskey: true,
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "session-unavailable",
      });
      const capture = await scenario.claimRawAudioCapture({
        actor: "voice-agent",
        sessionId: "debug-session",
      });
      expect(capture).toMatchObject({ decision: "accepted" });
      if (capture.decision !== "accepted") {
        throw new Error("Expected a raw-audio debug artifact path");
      }
      expect(capture.artifactPath.startsWith(directory)).toBe(true);
      await expect(
        scenario.claimRawAudioCapture({
          actor: "subagent",
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "subagent-ineligible",
      });

      scenario.setTime("2026-08-17T12:10:00.000Z");
      await scenario.endSession("debug-session", "completed");
      await scenario.reserveWarmSession("debug-session");
      await scenario.activateSession("debug-session");
      await expect(
        scenario.claimRawAudioCapture({
          actor: "voice-agent",
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "debug-grant-required",
      });

      scenario.setTime("2026-08-18T10:59:59.999Z");
      await expect(scenario.cleanupExpiredRawAudio()).resolves.toEqual({
        deleted: 0,
        failed: 0,
        missing: 0,
      });
      scenario.setTime("2026-08-18T11:00:00.000Z");
      await expect(scenario.cleanupExpiredRawAudio()).resolves.toEqual({
        deleted: 1,
        failed: 0,
        missing: 0,
      });

      expect(scenario.evidence.map((event) => event.kind)).toEqual([
        "telephone.audio-debug.enabled",
        "telephone.audio-debug.revoked",
        "telephone.session.ended",
        "telephone.audio-debug.cleaned",
      ]);
      expect(JSON.stringify(scenario.evidence)).not.toContain(
        capture.artifactPath,
      );
      const metrics = await scenario.readMetrics();
      expect(metrics.audioDebug).toEqual({
        activeGrants: 0,
        cleanup: { deleted: 1, failed: 0, missing: 0 },
        grants: { accepted: 1, rejected: 3 },
      });
      expect(JSON.stringify(metrics)).not.toContain("debug-session");
    } finally {
      await scenario.close();
    }
  });

  test("raw-audio capture remains disabled when conspicuous evidence cannot persist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-audio-evidence-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      failEvidenceKinds: ["telephone.audio-debug.enabled"],
      now: "2026-08-17T12:00:00.000Z",
      rawAudioDebugDirectory: join(directory, "debug-audio"),
    });

    try {
      await scenario.reserveWarmSession("debug-session");
      await scenario.activateSession("debug-session");
      await expect(
        scenario.authorizeRawAudioDebug({
          actor: "owner",
          freshPasskey: true,
          sessionId: "debug-session",
        }),
      ).rejects.toThrow("Injected Telephone Boundary evidence failure");
      await expect(
        scenario.claimRawAudioCapture({
          actor: "voice-agent",
          sessionId: "debug-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "debug-grant-required",
      });
      expect(scenario.evidence).toEqual([]);
    } finally {
      await scenario.close();
    }
  });

  test("raw-audio evidence is corrected when its session ends before grant confirmation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-audio-race-"));
    temporaryDirectories.push(directory);
    const scenario = await createTelephoneBoundaryScenario({
      databasePath: join(directory, "voice-agent.sqlite"),
      endSessionOnEvidenceKinds: ["telephone.audio-debug.enabled"],
      now: "2026-08-17T12:00:00.000Z",
      rawAudioDebugDirectory: join(directory, "debug-audio"),
    });

    try {
      await scenario.reserveWarmSession("debug-race-session");
      await scenario.activateSession("debug-race-session");
      await expect(
        scenario.authorizeRawAudioDebug({
          actor: "owner",
          freshPasskey: true,
          sessionId: "debug-race-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "session-unavailable",
      });
      expect(scenario.evidence.map((event) => event.kind)).toEqual([
        "telephone.audio-debug.enabled",
        "telephone.audio-debug.revoked",
      ]);
      await expect(
        scenario.claimRawAudioCapture({
          actor: "voice-agent",
          sessionId: "debug-race-session",
        }),
      ).resolves.toEqual({
        decision: "rejected",
        reason: "debug-grant-required",
      });
    } finally {
      await scenario.close();
    }
  });
});
