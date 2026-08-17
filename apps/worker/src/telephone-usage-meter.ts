const usageSources = ["api", "telephony", "realtime-media"] as const;
type TelephoneUsageSource = (typeof usageSources)[number];

export type TelephoneUsageRates = Readonly<
  Record<TelephoneUsageSource, number>
>;

interface TelephoneUsageRecorder {
  (input: {
    readonly amountMicrousd: number;
    readonly sessionId: string;
    readonly source: TelephoneUsageSource;
    readonly usageId: string;
  }): Promise<{ readonly disposition: "continue" | "safe-terminal-only" }>;
}

export async function reserveTelephoneUsageSlice(options: {
  readonly ratesMicrousdPerMinute: TelephoneUsageRates;
  readonly recordUsage: TelephoneUsageRecorder;
  readonly sessionId: string;
  readonly usageScopeId: string;
}): Promise<"continue" | "safe-terminal-only"> {
  validateRates(options.ratesMicrousdPerMinute);
  let disposition: "continue" | "safe-terminal-only" = "continue";
  for (const source of usageSources) {
    const result = await options.recordUsage({
      amountMicrousd: options.ratesMicrousdPerMinute[source],
      sessionId: options.sessionId,
      source,
      usageId: `${options.usageScopeId}:${source}`,
    });
    if (result.disposition === "safe-terminal-only") {
      disposition = "safe-terminal-only";
    }
  }
  return disposition;
}

export function telephoneUsageRatesFromEnvironment(): TelephoneUsageRates {
  return {
    api: positiveEnvironmentInteger(
      "VOICE_AGENT_API_MICROUSD_PER_MINUTE",
      50_000,
    ),
    "realtime-media": positiveEnvironmentInteger(
      "VOICE_AGENT_REALTIME_MEDIA_MICROUSD_PER_MINUTE",
      100_000,
    ),
    telephony: positiveEnvironmentInteger(
      "VOICE_AGENT_TELEPHONY_MICROUSD_PER_MINUTE",
      50_000,
    ),
  };
}

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
  readonly recordUsage: TelephoneUsageRecorder;
  readonly sessionId: string;
  readonly stop: Promise<void>;
  readonly usageScopeId?: string;
}): Promise<void> {
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Telephone usage interval must be a positive integer");
  }
  validateRates(options.ratesMicrousdPerMinute);

  let minute = 0;
  const usageScopeId = options.usageScopeId ?? options.sessionId;
  while (true) {
    minute += 1;
    const disposition = await reserveTelephoneUsageSlice({
      ratesMicrousdPerMinute: options.ratesMicrousdPerMinute,
      recordUsage: options.recordUsage,
      sessionId: options.sessionId,
      usageScopeId: `${usageScopeId}:minute:${minute}`,
    });
    if (disposition === "safe-terminal-only") {
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

function validateRates(rates: TelephoneUsageRates): void {
  for (const source of usageSources) {
    const rate = rates[source];
    if (!Number.isInteger(rate) || rate < 1) {
      throw new Error(`Telephone ${source} rate must be positive microusd`);
    }
  }
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new Error(`${name} must be between one microusd and $1,000`);
  }
  return value;
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
