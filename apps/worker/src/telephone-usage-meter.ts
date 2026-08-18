const usageSources = ["api", "telephony", "realtime-media"] as const;
type TelephoneUsageSource = (typeof usageSources)[number];

export type TelephoneUsageRates = Readonly<
  Record<TelephoneUsageSource, number>
>;

interface TelephoneUsageSliceResult {
  readonly disposition: "continue" | "safe-terminal-only";
  readonly month: string;
  readonly reservedSources: readonly TelephoneUsageSource[];
  readonly totalMicrousd: number;
  readonly warnings: readonly (25_000_000 | 40_000_000)[];
}

interface TelephoneUsageSliceRecorder {
  (input: {
    readonly amountsMicrousd: TelephoneUsageRates;
    readonly sessionId?: string;
    readonly usageScopeId: string;
  }): Promise<TelephoneUsageSliceResult>;
}

export interface TelephoneSpendingWarning {
  readonly month: string;
  readonly thresholdMicrousd: 25_000_000 | 40_000_000;
  readonly totalMicrousd: number;
}

export function reportTelephoneSpendingWarning(
  warning: TelephoneSpendingWarning,
): void {
  process.stderr.write(
    `Telephone provider spending crossed ${warning.thresholdMicrousd} microusd for ${warning.month}; monthly total is ${warning.totalMicrousd} microusd.\n`,
  );
}

export async function reserveTelephoneUsageSlice(options: {
  readonly onSpendingWarning: (warning: TelephoneSpendingWarning) => void;
  readonly ratesMicrousdPerMinute: TelephoneUsageRates;
  readonly reserveUsageSlice: TelephoneUsageSliceRecorder;
  readonly sessionId?: string;
  readonly usageScopeId: string;
}): Promise<TelephoneUsageSliceResult> {
  validateRates(options.ratesMicrousdPerMinute);
  const result = await options.reserveUsageSlice({
    amountsMicrousd: options.ratesMicrousdPerMinute,
    usageScopeId: options.usageScopeId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  for (const thresholdMicrousd of result.warnings) {
    options.onSpendingWarning({
      month: result.month,
      thresholdMicrousd,
      totalMicrousd: result.totalMicrousd,
    });
  }
  return result;
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
  readonly onSpendingWarning: (warning: TelephoneSpendingWarning) => void;
  readonly onSpendingCeiling: () => Promise<void>;
  readonly ratesMicrousdPerMinute: TelephoneUsageRates;
  readonly reserveUsageSlice: TelephoneUsageSliceRecorder;
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
    const result = await reserveTelephoneUsageSlice({
      onSpendingWarning: options.onSpendingWarning,
      ratesMicrousdPerMinute: options.ratesMicrousdPerMinute,
      reserveUsageSlice: options.reserveUsageSlice,
      sessionId: options.sessionId,
      usageScopeId: `${usageScopeId}:minute:${minute}`,
    });
    if (result.disposition === "safe-terminal-only") {
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
