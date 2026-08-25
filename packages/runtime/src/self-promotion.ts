import {
  isNonInterruptibleOperationKind,
  type CallAdmissionRecord,
  type SafePointDisposition,
  type SafePointObservation,
} from "@voice-agent/contracts";
import type {
  SelfPromotionStore,
  UnsettledOperation,
} from "@voice-agent/durable-store";

export type {
  SelfPromotionStore,
  TelephoneBoundaryDecision,
  TelephoneBoundaryStore,
  UnsettledOperation,
} from "@voice-agent/durable-store";

/**
 * The Self-Promotion boundary: closing Call Admission, waiting for a Promotion
 * Safe Point, and reopening admission only once a healthy runtime has been
 * confirmed.
 *
 * Waiting is expressed as one observation at a time rather than as a sleep loop
 * so the caller owns its own clock. The pinned promoter polls on the host; a
 * scenario advances the world between observations and reads exactly what the
 * Evidence Record will say.
 */
export interface SelfPromotionRuntime {
  /**
   * Close Call Admission for one Self-Promotion. Idempotent: a repeated request
   * for the same Promotion Attempt re-reads the closed state rather than
   * recording a second pause, so a retried or duplicated merge event cannot
   * pause admission twice.
   */
  pauseCallAdmission(input: {
    readonly commit: string;
    readonly promotionId: string;
  }): Promise<CallAdmissionRecord>;
  /** One reading of whether the Promotion Safe Point has been reached. */
  observeSafePoint(): Promise<SafePointObservation>;
  /**
   * Observe until the safe point is reached or `maximumObservations` readings
   * have been taken, waiting between readings through the injected delay. A
   * deadline that expires never ends a live call; it reports
   * `deadline-exceeded` and leaves the runtime unchanged so the caller can
   * abandon the attempt with the prior Release still active.
   */
  awaitSafePoint(input?: {
    readonly maximumObservations?: number;
  }): Promise<SafePointDisposition>;
  /** Work carried across the switch under its own durable identity. */
  readResumableWork(): Promise<readonly UnsettledOperation[]>;
  readCallAdmission(): Promise<CallAdmissionRecord>;
  reopenCallAdmission(): Promise<CallAdmissionRecord>;
}

export interface SelfPromotionRuntimeOptions {
  /** Waited between safe-point observations. */
  readonly delay?: (durationMs: number) => Promise<void>;
  readonly maximumObservations?: number;
  readonly now: () => string;
  readonly observationIntervalMs?: number;
  readonly store: SelfPromotionStore;
}

export function createSelfPromotionRuntime(
  options: SelfPromotionRuntimeOptions,
): SelfPromotionRuntime {
  const observationIntervalMs = options.observationIntervalMs ?? 1_000;
  const defaultMaximumObservations = options.maximumObservations ?? 900;
  const delay =
    options.delay ??
    ((durationMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }));

  async function observeSafePoint(): Promise<SafePointObservation> {
    const [admission, activeSessions, unsettled] = await Promise.all([
      options.store.readCallAdmission(),
      options.store.findActiveTelephoneSessionIds(),
      options.store.findUnsettledOperations(),
    ]);
    const nonInterruptible = unsettled.filter((operation) =>
      isNonInterruptibleOperationKind(operation.kind),
    );
    return {
      activeTelephoneSessions: activeSessions.length,
      admission: admission.state,
      nonInterruptibleOperations: nonInterruptible.length,
      // A safe point requires admission already closed: reaching it with
      // admission open would only mean no call had arrived yet.
      reached:
        admission.state === "paused" &&
        activeSessions.length === 0 &&
        nonInterruptible.length === 0,
      resumableOperations: unsettled.length - nonInterruptible.length,
    };
  }

  return {
    async awaitSafePoint(input) {
      const maximumObservations =
        input?.maximumObservations ?? defaultMaximumObservations;
      const first = await observeSafePoint();
      let latest = first;
      let observations = 1;
      while (!latest.reached && observations < maximumObservations) {
        await delay(observationIntervalMs);
        latest = await observeSafePoint();
        observations += 1;
      }
      return {
        activeTelephoneSessionsAtRequest: first.activeTelephoneSessions,
        disposition: latest.reached
          ? observations === 1
            ? "already-safe"
            : "waited"
          : "deadline-exceeded",
        endedForPromotion: 0,
        nonInterruptibleOperationsAtRequest: first.nonInterruptibleOperations,
        observations,
        resumableOperationsAtRequest: first.resumableOperations,
      };
    },
    observeSafePoint,
    async pauseCallAdmission(input) {
      const current = await options.store.readCallAdmission();
      if (
        current.state === "paused" &&
        current.promotionId === input.promotionId
      ) {
        return current;
      }
      return options.store.pauseCallAdmission({
        changedAt: options.now(),
        commit: input.commit,
        promotionId: input.promotionId,
        reason: "self-promotion",
      });
    },
    async readCallAdmission() {
      return options.store.readCallAdmission();
    },
    async readResumableWork() {
      const unsettled = await options.store.findUnsettledOperations();
      return unsettled.filter(
        (operation) => !isNonInterruptibleOperationKind(operation.kind),
      );
    },
    async reopenCallAdmission() {
      return options.store.reopenCallAdmission({ changedAt: options.now() });
    },
  };
}
