import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { formatTelephoneBoundaryPrometheusMetrics } from "@voice-agent/runtime";

import { createTelephoneBoundaryScenario } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Telephone fail-closed boundaries", () => {
  test("excess sessions, state-changing tasks, and Subagents are explicitly rejected or queued", async () => {
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

      await expect(scenario.claimSubagent("delegation-1")).resolves.toEqual({
        decision: "accepted",
        resource: "subagent",
      });
      await expect(scenario.claimSubagent("delegation-2")).resolves.toEqual({
        decision: "queued",
        position: 1,
        resource: "subagent",
      });

      await expect(
        scenario.releaseStateChangingTask("session-1", "task-1"),
      ).resolves.toEqual({ promotedOwnerId: "task-2" });
      await expect(scenario.releaseSubagent("delegation-1")).resolves.toEqual({
        promotedOwnerId: "delegation-2",
      });

      const metrics = await scenario.readMetrics();
      expect(metrics.limitDecisions).toEqual({
        accepted: 5,
        queued: 2,
        rejected: 3,
      });
      expect(metrics.resources).toEqual({
        activeSessions: 1,
        queuedStateChangingTasks: 0,
        queuedSubagents: 0,
        runningSubagents: 1,
        warmSessions: 1,
      });
      expect(JSON.stringify(metrics)).not.toContain("task-1");
      expect(JSON.stringify(metrics)).not.toContain("delegation-1");
    } finally {
      await scenario.close();
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
        coordinator: { timeout: 0, unavailable: 0 },
        stt: { timeout: 1, unavailable: 0 },
        tts: { timeout: 0, unavailable: 0 },
      });
      expect(metrics.totalDurationMs).toBe(7_290_000);
      expect(JSON.stringify(metrics)).not.toContain("maximum-session");
      const renderedMetrics = formatTelephoneBoundaryPrometheusMetrics(metrics);
      expect(renderedMetrics).toContain(
        'voice_agent_telephone_provider_failures_total{stage="stt",class="timeout"} 1',
      );
      expect(renderedMetrics).not.toContain("failed-session");
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
});
