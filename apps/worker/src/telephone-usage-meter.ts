const usageSources = ["api", "telephony", "realtime-media"] as const;
type TelephoneUsageSource = (typeof usageSources)[number];

export type TelephoneUsageRates = Readonly<
  Record<TelephoneUsageSource, number>
>;

/**
 * Reserves one configured minute of each paid provider class at admission and
 * once per minute thereafter. Reserving at the start of each slice prevents a
 * call from running paid work after the durable monthly ceiling is reached.
 */
export async function meterTelephoneSessionUsage(options: {
  readonly intervalMs?: number;
  readonly onFirstSliceComplete?: () => void;
  readonly onSpendingCeiling: () => Promise<void>;
  readonly ratesMicrousdPerMinute: TelephoneUsageRates;
  readonly recordUsage: (input: {
    readonly amountMicrousd: number;
    readonly sessionId: string;
    readonly source: TelephoneUsageSource;
    readonly usageId: string;
  }) => Promise<{ readonly disposition: "continue" | "safe-terminal-only" }>;
  readonly sessionId: string;
  readonly stop: Promise<void>;
  readonly usageScopeId?: string;
}): Promise<void> {
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Telephone usage interval must be a positive integer");
  }
  for (const source of usageSources) {
    const rate = options.ratesMicrousdPerMinute[source];
    if (!Number.isInteger(rate) || rate < 1) {
      throw new Error(`Telephone ${source} rate must be positive microusd`);
    }
  }

  let minute = 0;
  const usageScopeId = options.usageScopeId ?? options.sessionId;
  while (true) {
    minute += 1;
    let atCeiling = false;
    for (const source of usageSources) {
      const result = await options.recordUsage({
        amountMicrousd: options.ratesMicrousdPerMinute[source],
        sessionId: options.sessionId,
        source,
        usageId: `${usageScopeId}:minute:${minute}:${source}`,
      });
      atCeiling ||= result.disposition === "safe-terminal-only";
    }
    if (atCeiling) {
      await options.onSpendingCeiling();
      if (minute === 1) options.onFirstSliceComplete?.();
      return;
    }
    if (minute === 1) options.onFirstSliceComplete?.();
    if ((await waitForNextMinuteOrStop(options.stop, intervalMs)) === "stopped") {
      return;
    }
  }
}

async function waitForNextMinuteOrStop(
  stop: Promise<void>,
  intervalMs: number,
): Promise<"next-minute" | "stopped"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stop.then(() => "stopped" as const),
      new Promise<"next-minute">((resolve) => {
        timer = setTimeout(() => resolve("next-minute"), intervalMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
