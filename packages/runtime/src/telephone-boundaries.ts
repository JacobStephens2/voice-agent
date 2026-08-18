import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  telephoneAudioDebugCleanedEvidenceEventSchema,
  telephoneAudioDebugEnabledEvidenceEventSchema,
  telephoneAudioDebugRevokedEvidenceEventSchema,
  telephoneProviderFailureStages,
  telephoneSpendingWarningEvidenceEventSchema,
  telephoneSessionEndedEvidenceEventSchema,
  telephoneUsageRecordedEvidenceEventSchema,
  type TelephoneBoundaryEvidenceEvent,
  type TelephoneProviderFailureStage,
} from "@voice-agent/contracts";
import type {
  TelephoneBoundaryStore,
  TelephoneProviderFailureClass,
  TelephoneUsageSource,
} from "@voice-agent/durable-store";

const maximumTelephoneSessionMs = 2 * 60 * 60 * 1_000;
// The hourly durable cleanup pass then removes artifacts no later than 24 hours.
const rawAudioDebugLifetimeMs = 23 * 60 * 60 * 1_000;
const maximumProlongedSilenceMs = 15 * 60 * 1_000;
const minimumProlongedSilenceMs = 30 * 1_000;
const maximumWarmSessionMs = 5 * 60 * 1_000;
const defaultSubagentLeaseDurationMs = 30_000;
const defaultSubagentPollIntervalMs = 25;

export interface TelephoneBoundaryEvidenceSink {
  append(
    sessionId: string,
    event: Omit<TelephoneBoundaryEvidenceEvent, "sequence">,
  ): Promise<void>;
}

export interface RawAudioArtifactRemover {
  remove(path: string): Promise<"deleted" | "missing">;
}

export function createNodeRawAudioArtifactRemover(): RawAudioArtifactRemover {
  return {
    async remove(path) {
      try {
        await rm(path, { force: false });
        return "deleted";
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return "missing";
        }
        throw error;
      }
    },
  };
}

export interface TelephoneBoundaryRuntimeOptions {
  readonly evidence?: TelephoneBoundaryEvidenceSink;
  readonly nextId?: () => string;
  readonly now: () => string;
  readonly prolongedSilenceMs?: number;
  readonly rawAudioArtifacts?: RawAudioArtifactRemover;
  readonly rawAudioDebugDirectory?: string;
  readonly store: TelephoneBoundaryStore;
  readonly subagentLeaseDurationMs?: number;
  readonly subagentPollIntervalMs?: number;
}

export function createTelephoneBoundaryRuntime(
  options: TelephoneBoundaryRuntimeOptions,
) {
  const subagentExecutions = new Set<string>();
  const subagentLeaseDurationMs =
    options.subagentLeaseDurationMs ?? defaultSubagentLeaseDurationMs;
  const subagentPollIntervalMs =
    options.subagentPollIntervalMs ?? defaultSubagentPollIntervalMs;
  if (
    !Number.isInteger(subagentLeaseDurationMs) ||
    subagentLeaseDurationMs < 3_000 ||
    !Number.isInteger(subagentPollIntervalMs) ||
    subagentPollIntervalMs < 1 ||
    subagentPollIntervalMs >= subagentLeaseDurationMs / 3
  ) {
    throw new Error(
      "Subagent polling must be positive and shorter than one third of a lease of at least three seconds",
    );
  }
  const prolongedSilenceMs =
    options.prolongedSilenceMs ?? 60 * 1_000;
  if (
    !Number.isInteger(prolongedSilenceMs) ||
    prolongedSilenceMs < minimumProlongedSilenceMs ||
    prolongedSilenceMs > maximumProlongedSilenceMs
  ) {
    throw new Error(
      "Prolonged silence must be configured between 30 seconds and 15 minutes",
    );
  }

  async function endSession(
    sessionId: string,
    reason:
      | "completed"
      | "disconnected"
      | "maximum-duration"
      | "prolonged-silence"
      | "provider-failure"
      | "spending-ceiling",
  ) {
    const session = await options.store.findSession(sessionId);
    if (session?.state !== "active" || session.activatedAt === undefined) {
      return { ended: false } as const;
    }
    const occurredAt = options.now();
    const durationMs = Math.min(
      maximumTelephoneSessionMs,
      Math.max(
        0,
        new Date(occurredAt).getTime() -
          new Date(session.activatedAt).getTime(),
      ),
    );
    const persisted = await options.store.endSession({
      durationMs,
      endedAt: occurredAt,
      reason,
      sessionId,
    });
    if (!persisted.ended) return { ended: false } as const;
    if (options.evidence !== undefined && options.nextId !== undefined) {
      if (session.rawAudioDebugConfirmed === true) {
        await options.evidence.append(
          sessionId,
          telephoneAudioDebugRevokedEvidenceEventSchema
            .omit({ sequence: true })
            .parse({
              details: { reason: "session-ended" },
              id: options.nextId(),
              kind: "telephone.audio-debug.revoked",
              occurredAt,
              summary:
                "Raw-audio debugging was revoked when its Telephone Session ended.",
            }),
        );
      }
      await options.evidence.append(
        sessionId,
        telephoneSessionEndedEvidenceEventSchema.omit({ sequence: true }).parse({
          details: { durationMs, reason },
          id: options.nextId(),
          kind: "telephone.session.ended",
          occurredAt,
          summary: "The Telephone Session reached a bounded terminal state.",
        }),
      );
    }
    return { durationMs, ended: true, reason } as const;
  }

  async function releaseSubagent(
    delegationId: string,
    executionId: string,
  ): Promise<void> {
    await options.store.releaseSubagent({ delegationId, executionId });
  }

  return {
    activateSession(sessionId: string) {
      return options.store.activateSession({
        activatedAt: options.now(),
        sessionId,
      });
    },
    async authorizeRawAudioDebug(input: {
      readonly actor: "owner" | "subagent";
      readonly freshPasskey: boolean;
      readonly sessionId: string;
    }) {
      if (input.actor === "subagent") {
        await options.store.recordRawAudioDebugDecision("rejected");
        return { decision: "rejected", reason: "subagent-ineligible" } as const;
      }
      if (!input.freshPasskey) {
        await options.store.recordRawAudioDebugDecision("rejected");
        return {
          decision: "rejected",
          reason: "fresh-passkey-required",
        } as const;
      }
      if (
        options.rawAudioDebugDirectory === undefined ||
        options.evidence === undefined ||
        options.nextId === undefined
      ) {
        await options.store.recordRawAudioDebugDecision("rejected");
        return { decision: "rejected", reason: "debug-unavailable" } as const;
      }
      const occurredAt = options.now();
      const expiresAt = new Date(
        new Date(occurredAt).getTime() + rawAudioDebugLifetimeMs,
      ).toISOString();
      if (
        !(await options.store.grantRawAudioDebug({
          authorizedAt: occurredAt,
          expiresAt,
          sessionId: input.sessionId,
        }))
      ) {
        await options.store.recordRawAudioDebugDecision("rejected");
        return { decision: "rejected", reason: "session-unavailable" } as const;
      }
      try {
        await options.evidence.append(
          input.sessionId,
          telephoneAudioDebugEnabledEvidenceEventSchema
            .omit({ sequence: true })
            .parse({
              details: { expiresAt, rawAudio: true },
              id: options.nextId(),
              kind: "telephone.audio-debug.enabled",
              occurredAt,
              summary:
                "RAW AUDIO DEBUGGING ENABLED for this Telephone Session only.",
            }),
        );
      } catch (error) {
        await options.store.revokeRawAudioDebug(input.sessionId);
        await options.store.recordRawAudioDebugDecision("rejected");
        throw error;
      }
      if (
        !(await options.store.confirmRawAudioDebug({
          confirmedAt: occurredAt,
          sessionId: input.sessionId,
        }))
      ) {
        await options.store.revokeRawAudioDebug(input.sessionId);
        await options.store.recordRawAudioDebugDecision("rejected");
        await options.evidence.append(
          input.sessionId,
          telephoneAudioDebugRevokedEvidenceEventSchema
            .omit({ sequence: true })
            .parse({
              details: { reason: "session-unavailable" },
              id: options.nextId(),
              kind: "telephone.audio-debug.revoked",
              occurredAt: options.now(),
              summary:
                "Raw-audio debugging was revoked because the Telephone Session ended before activation.",
            }),
        );
        return { decision: "rejected", reason: "session-unavailable" } as const;
      }
      await options.store.recordRawAudioDebugDecision("accepted");
      return { decision: "accepted", expiresAt } as const;
    },
    async claimRawAudioCapture(input: {
      readonly actor: "subagent" | "voice-agent";
      readonly sessionId: string;
    }) {
      if (input.actor === "subagent") {
        return { decision: "rejected", reason: "subagent-ineligible" } as const;
      }
      if (options.rawAudioDebugDirectory === undefined) {
        return { decision: "rejected", reason: "debug-grant-required" } as const;
      }
      const artifactName = `${createHash("sha256")
        .update(input.sessionId)
        .digest("hex")}.pcm`;
      const root = resolve(options.rawAudioDebugDirectory);
      const artifactPath = resolve(join(root, artifactName));
      if (!artifactPath.startsWith(`${root}/`)) {
        throw new Error("Raw-audio artifact path escaped its configured directory");
      }
      const accepted = await options.store.claimRawAudioArtifact({
        artifactPath,
        claimedAt: options.now(),
        sessionId: input.sessionId,
      });
      if (!accepted) {
        return { decision: "rejected", reason: "debug-grant-required" } as const;
      }
      const session = await options.store.findSession(input.sessionId);
      if (session?.rawAudioDebugExpiresAt === undefined) {
        throw new Error("Raw-audio debug grant disappeared after capture claim");
      }
      return {
        artifactPath,
        decision: "accepted",
        expiresAt: session.rawAudioDebugExpiresAt,
      } as const;
    },
    claimStateChangingTask(sessionId: string, taskId: string) {
      return options.store.claimStateChangingTask({
        requestedAt: options.now(),
        sessionId,
        taskId,
      });
    },
    /**
     * Runs the Subagent adapter only after its durable global lease is active.
     * Queued adapters poll the durable lease, so separate runtime processes
     * observe release and expired owners without a caller-managed retry path.
     */
    async executeSubagent<Result>(
      delegationId: string,
      execute: (signal: AbortSignal) => Promise<Result>,
      signal?: AbortSignal,
    ) {
      if (subagentExecutions.has(delegationId)) {
        throw new Error("Subagent execution is already pending");
      }
      subagentExecutions.add(delegationId);
      const executionId = randomUUID();
      const leaseLost = new AbortController();
      const executionSignal =
        signal === undefined
          ? leaseLost.signal
          : AbortSignal.any([signal, leaseLost.signal]);
      let ownsSlot = false;
      try {
        while (true) {
          const requestedAt = options.now();
          const decision = await options.store.claimSubagent({
            delegationId,
            executionId,
            leaseExpiresAt: addMilliseconds(
              requestedAt,
              subagentLeaseDurationMs,
            ),
            requestedAt,
          });
          if (decision.decision === "accepted") {
            ownsSlot = true;
            break;
          }
          if (decision.decision === "rejected") return decision;
          if (
            (await waitForDelayOrAbort(
              subagentPollIntervalMs,
              executionSignal,
            )) === "aborted"
          ) {
            await releaseSubagent(delegationId, executionId);
            return { decision: "cancelled", resource: "subagent" } as const;
          }
        }
        if (executionSignal.aborted) {
          await releaseSubagent(delegationId, executionId);
          ownsSlot = false;
          return { decision: "cancelled", resource: "subagent" } as const;
        }
        let renewal = Promise.resolve();
        const renewLease = () => {
          renewal = renewal.then(async () => {
            try {
              const renewedAt = options.now();
              const renewed = await options.store.renewSubagentLease({
                delegationId,
                executionId,
                leaseExpiresAt: addMilliseconds(
                  renewedAt,
                  subagentLeaseDurationMs,
                ),
              });
              if (!renewed) leaseLost.abort();
            } catch {
              leaseLost.abort();
            }
          });
        };
        const heartbeat = setInterval(
          renewLease,
          Math.floor(subagentLeaseDurationMs / 3),
        );
        try {
          const result = await execute(executionSignal);
          if (executionSignal.aborted) {
            return { decision: "cancelled", resource: "subagent" } as const;
          }
          return {
            decision: "accepted",
            resource: "subagent",
            result,
          } as const;
        } finally {
          clearInterval(heartbeat);
          await renewal;
        }
      } finally {
        subagentExecutions.delete(delegationId);
        if (ownsSlot) await releaseSubagent(delegationId, executionId);
      }
    },
    async changeSpendingCeiling(input: {
      readonly ceilingMicrousd: number;
      readonly freshPasskey: boolean;
    }) {
      if (!input.freshPasskey) {
        return {
          decision: "rejected",
          reason: "fresh-passkey-required",
        } as const;
      }
      if (
        !Number.isInteger(input.ceilingMicrousd) ||
        input.ceilingMicrousd < 1_000_000 ||
        input.ceilingMicrousd > 1_000_000_000
      ) {
        throw new Error("Spending ceiling must be between $1 and $1,000");
      }
      const changed = await options.store.changeSpendingCeiling({
        ceilingMicrousd: input.ceilingMicrousd,
        changedAt: options.now(),
      });
      return { decision: "accepted", ...changed } as const;
    },
    close: () => options.store.close(),
    async cleanupExpiredRawAudio() {
      const now = options.now();
      const totals = { deleted: 0, failed: 0, missing: 0 };
      for (const expired of await options.store.findExpiredRawAudioDebug(now)) {
        let outcome: "deleted" | "failed" | "missing";
        if (
          expired.artifactPath === undefined ||
          options.rawAudioArtifacts === undefined
        ) {
          outcome = expired.artifactPath === undefined ? "missing" : "failed";
        } else {
          try {
            outcome = await options.rawAudioArtifacts.remove(expired.artifactPath);
          } catch {
            outcome = "failed";
          }
        }
        totals[outcome] += 1;
        await options.store.recordRawAudioCleanup({
          outcome,
          sessionId: expired.sessionId,
        });
        if (options.evidence !== undefined && options.nextId !== undefined) {
          await options.evidence.append(
            expired.sessionId,
            telephoneAudioDebugCleanedEvidenceEventSchema
              .omit({ sequence: true })
              .parse({
                details: { outcome },
                id: options.nextId(),
                kind: "telephone.audio-debug.cleaned",
                occurredAt: now,
                summary:
                  outcome === "failed"
                    ? "Expired raw-audio cleanup failed and will be retried."
                    : "Expired raw-audio debugging material was removed.",
              }),
          );
        }
      }
      return totals;
    },
    endSession,
    async enforceDeadline(sessionId: string) {
      const session = await options.store.findSession(sessionId);
      if (
        session?.state !== "active" ||
        session.activatedAt === undefined ||
        session.lastActivityAt === undefined
      ) {
        return { ended: false } as const;
      }
      const now = new Date(options.now()).getTime();
      const durationMs = now - new Date(session.activatedAt).getTime();
      if (durationMs >= maximumTelephoneSessionMs) {
        return endSession(sessionId, "maximum-duration");
      }
      const silenceMs = now - new Date(session.lastActivityAt).getTime();
      if (silenceMs >= prolongedSilenceMs) {
        return endSession(sessionId, "prolonged-silence");
      }
      return { ended: false } as const;
    },
    async enforceDeadlines() {
      const now = options.now();
      const expiredWarmSessions = await options.store.expireWarmSessions({
        cutoff: new Date(
          new Date(now).getTime() - maximumWarmSessionMs,
        ).toISOString(),
        endedAt: now,
      });
      let endedActiveSessions = 0;
      for (const sessionId of await options.store.findActiveSessionIds()) {
        const result = await this.enforceDeadline(sessionId);
        if (result.ended) endedActiveSessions += 1;
      }
      return { endedActiveSessions, expiredWarmSessions };
    },
    noteActivity(sessionId: string) {
      return options.store.touchSession({
        occurredAt: options.now(),
        sessionId,
      });
    },
    readMetrics: () => options.store.readMetrics(options.now()),
    async readBoundaryStatus() {
      const metrics = await options.store.readMetrics(options.now());
      return {
        audioDebug: { activeGrants: metrics.audioDebug.activeGrants },
        spending: metrics.spending,
      };
    },
    readSession: (sessionId: string) => options.store.findSession(sessionId),
    async recordProviderFailure(input: {
      readonly failureClass: TelephoneProviderFailureClass;
      readonly sessionId: string;
      readonly stage: TelephoneProviderFailureStage;
    }) {
      await options.store.recordProviderFailure(input);
      return endSession(input.sessionId, "provider-failure");
    },
    async recordUsage(input: {
      readonly amountMicrousd: number;
      readonly sessionId?: string;
      readonly source: TelephoneUsageSource;
      readonly usageId: string;
    }) {
      if (
        !Number.isInteger(input.amountMicrousd) ||
        input.amountMicrousd <= 0 ||
        input.amountMicrousd > 1_000_000_000
      ) {
        throw new Error(
          "Metered usage must be between one microusd and $1,000",
        );
      }
      const recordedAt = options.now();
      const result = await options.store.recordUsage({
        ...input,
        recordedAt,
      });
      if (
        input.sessionId !== undefined &&
        options.evidence !== undefined &&
        options.nextId !== undefined
      ) {
        await options.evidence.append(
          input.sessionId,
          telephoneUsageRecordedEvidenceEventSchema
            .omit({ sequence: true })
            .parse({
              details: {
                amountMicrousd: input.amountMicrousd,
                monthTotalMicrousd: result.totalMicrousd,
                source: input.source,
              },
              id: options.nextId(),
              kind: "telephone.usage.recorded",
              occurredAt: recordedAt,
              summary: "Sanitized metered provider usage was recorded.",
            }),
        );
        for (const thresholdMicrousd of result.warnings) {
          await options.evidence.append(
            input.sessionId,
            telephoneSpendingWarningEvidenceEventSchema
              .omit({ sequence: true })
              .parse({
                details: {
                  monthTotalMicrousd: result.totalMicrousd,
                  thresholdMicrousd,
                },
                id: options.nextId(),
                kind: "telephone.spending.warning",
                occurredAt: recordedAt,
                summary: "The monthly provider spending warning was reached.",
              }),
          );
        }
      }
      return result;
    },
    async reserveUsageSlice(input: {
      readonly amountsMicrousd: Readonly<Record<TelephoneUsageSource, number>>;
      readonly sessionId?: string;
      readonly usageScopeId: string;
    }) {
      for (const amountMicrousd of Object.values(input.amountsMicrousd)) {
        validateUsageAmount(amountMicrousd);
      }
      const recordedAt = options.now();
      const result = await options.store.reserveUsageSlice({
        ...input,
        recordedAt,
      });
      if (
        input.sessionId !== undefined &&
        options.evidence !== undefined &&
        options.nextId !== undefined
      ) {
        for (const source of result.reservedSources) {
          await options.evidence.append(
            input.sessionId,
            telephoneUsageRecordedEvidenceEventSchema
              .omit({ sequence: true })
              .parse({
                details: {
                  amountMicrousd: input.amountsMicrousd[source],
                  monthTotalMicrousd: result.totalMicrousd,
                  source,
                },
                id: options.nextId(),
                kind: "telephone.usage.recorded",
                occurredAt: recordedAt,
                summary: "Sanitized metered provider usage was recorded.",
              }),
          );
        }
        for (const thresholdMicrousd of result.warnings) {
          await options.evidence.append(
            input.sessionId,
            telephoneSpendingWarningEvidenceEventSchema
              .omit({ sequence: true })
              .parse({
                details: {
                  monthTotalMicrousd: result.totalMicrousd,
                  thresholdMicrousd,
                },
                id: options.nextId(),
                kind: "telephone.spending.warning",
                occurredAt: recordedAt,
                summary: "The monthly provider spending warning was reached.",
              }),
          );
        }
      }
      return result;
    },
    releaseWarmSession: (sessionId: string) =>
      options.store.releaseWarmSession(sessionId),
    releaseStateChangingTask(sessionId: string, taskId: string) {
      return options.store.releaseStateChangingTask({ sessionId, taskId });
    },
    reserveWarmSession(sessionId: string) {
      return options.store.reserveWarmSession({
        reservedAt: options.now(),
        sessionId,
      });
    },
  };
}

function addMilliseconds(timestamp: string, durationMs: number): string {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

async function waitForDelayOrAbort(
  durationMs: number,
  signal: AbortSignal,
): Promise<"aborted" | "elapsed"> {
  if (signal.aborted) return "aborted";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<"aborted" | "elapsed">((resolve) => {
      abort = () => resolve("aborted");
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => resolve("elapsed"), durationMs);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function validateUsageAmount(amountMicrousd: number): void {
  if (
    !Number.isInteger(amountMicrousd) ||
    amountMicrousd <= 0 ||
    amountMicrousd > 1_000_000_000
  ) {
    throw new Error("Metered usage must be between one microusd and $1,000");
  }
}

export function formatTelephoneBoundaryPrometheusMetrics(
  metrics: Awaited<ReturnType<TelephoneBoundaryStore["readMetrics"]>>,
): string {
  const lines = [
    "# HELP voice_agent_telephone_limit_decisions_total Durable telephone limit decisions.",
    "# TYPE voice_agent_telephone_limit_decisions_total counter",
    ...(["accepted", "queued", "rejected"] as const).map(
      (decision) =>
        `voice_agent_telephone_limit_decisions_total{decision="${decision}"} ${metrics.limitDecisions[decision]}`,
    ),
    "# HELP voice_agent_telephone_usage_microusd Current UTC-month metered usage.",
    "# TYPE voice_agent_telephone_usage_microusd gauge",
    ...(["api", "telephony", "realtime-media"] as const).map(
      (source) =>
        `voice_agent_telephone_usage_microusd{source="${source}"} ${metrics.spending.bySourceMicrousd[source]}`,
    ),
    `voice_agent_telephone_spending_ceiling_microusd ${metrics.spending.ceilingMicrousd}`,
    `voice_agent_telephone_session_duration_ms_total ${metrics.totalDurationMs}`,
    ...([
      ["maximum-duration", metrics.sessionEndings.maximumDuration],
      ["prolonged-silence", metrics.sessionEndings.prolongedSilence],
      ["provider-failure", metrics.sessionEndings.providerFailure],
      ["other", metrics.sessionEndings.other],
    ] as const).map(
      ([reason, value]) =>
        `voice_agent_telephone_session_endings_total{reason="${reason}"} ${value}`,
    ),
    ...(["deleted", "missing", "failed"] as const).map(
      (outcome) =>
        `voice_agent_raw_audio_cleanup_total{outcome="${outcome}"} ${metrics.audioDebug.cleanup[outcome]}`,
    ),
    ...telephoneProviderFailureStages.flatMap((stage) =>
      (["timeout", "unavailable"] as const).map(
        (failureClass) =>
          `voice_agent_telephone_provider_failures_total{stage="${stage}",class="${failureClass}"} ${metrics.providerFailures[stage][failureClass]}`,
      ),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
