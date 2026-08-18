import { describe, expect, test, vi } from "vitest";

import {
  meterTelephoneSessionUsage,
  reserveTelephoneUsageSlice,
} from "../src/telephone-usage-meter.ts";

describe("Telephone Session paid-usage meter", () => {
  test("reserves every paid source through one atomic boundary call", async () => {
    const slices: unknown[] = [];

    await expect(
      reserveTelephoneUsageSlice({
        onSpendingWarning: () => {},
        ratesMicrousdPerMinute: {
          api: 50_000,
          "realtime-media": 100_000,
          telephony: 50_000,
        },
        reserveUsageSlice: async (input) => {
          slices.push(input);
          return {
            disposition: "continue" as const,
            month: "2026-08",
            reservedSources: ["api", "telephony", "realtime-media"] as const,
            totalMicrousd: 200_000,
            warnings: [],
          };
        },
        sessionId: "session-atomic",
        usageScopeId: "callback-effect-atomic",
      }),
    ).resolves.toMatchObject({ disposition: "continue", totalMicrousd: 200_000 });
    expect(slices).toEqual([
      {
        amountsMicrousd: {
          api: 50_000,
          "realtime-media": 100_000,
          telephony: 50_000,
        },
        sessionId: "session-atomic",
        usageScopeId: "callback-effect-atomic",
      },
    ]);
  });

  test("reserves a paid setup slice before a callback is placed", async () => {
    await expect(
      reserveTelephoneUsageSlice({
        onSpendingWarning: () => {},
        ratesMicrousdPerMinute: {
          api: 50_000,
          "realtime-media": 100_000,
          telephony: 50_000,
        },
        reserveUsageSlice: async () => {
          return {
            disposition: "safe-terminal-only" as const,
            month: "2026-08",
            reservedSources: [],
            totalMicrousd: 49_900_000,
            warnings: [],
          };
        },
        sessionId: "session-setup",
        usageScopeId: "callback-effect-1",
      }),
    ).resolves.toMatchObject({ disposition: "safe-terminal-only" });
  });

  test("meters rejected inbound media without creating a Telephone Session", async () => {
    const recorded: unknown[] = [];
    await reserveTelephoneUsageSlice({
      onSpendingWarning: () => {},
      ratesMicrousdPerMinute: {
        api: 1,
        "realtime-media": 2,
        telephony: 3,
      },
      reserveUsageSlice: async (input) => {
        recorded.push(input);
        return {
          disposition: "continue" as const,
          month: "2026-08",
          reservedSources: ["api", "telephony", "realtime-media"] as const,
          totalMicrousd: 6,
          warnings: [],
        };
      },
      usageScopeId: "rejected-inbound-1",
    });
    expect(recorded).toEqual([
      {
        amountsMicrousd: {
          api: 1,
          "realtime-media": 2,
          telephony: 3,
        },
        usageScopeId: "rejected-inbound-1",
      },
    ]);
  });

  test("reports warning crossings from pre-session usage without a session Evidence Record", async () => {
    const onSpendingWarning = vi.fn();

    await reserveTelephoneUsageSlice({
      onSpendingWarning,
      ratesMicrousdPerMinute: {
        api: 50_000,
        "realtime-media": 100_000,
        telephony: 50_000,
      },
      reserveUsageSlice: async () => ({
        disposition: "continue",
        month: "2026-08",
        reservedSources: ["api", "telephony", "realtime-media"],
        totalMicrousd: 25_100_000,
        warnings: [25_000_000],
      }),
      usageScopeId: "inbound-before-session",
    });

    expect(onSpendingWarning).toHaveBeenCalledWith({
      month: "2026-08",
      thresholdMicrousd: 25_000_000,
      totalMicrousd: 25_100_000,
    });
  });

  test("reconciles the pre-live reservation as the first live minute", async () => {
    const usageScopes: string[] = [];

    await meterTelephoneSessionUsage({
      initialUsageScopeId: "prelive:callback-effect-1",
      onSpendingCeiling: async () => {},
      onSpendingWarning: () => {},
      ratesMicrousdPerMinute: {
        api: 50_000,
        "realtime-media": 100_000,
        telephony: 50_000,
      },
      reserveUsageSlice: async (input) => {
        usageScopes.push(input.usageScopeId);
        return {
          disposition: "continue",
          month: "2026-08",
          reservedSources: [],
          totalMicrousd: 200_000,
          warnings: [],
        };
      },
      sessionId: "session-prelive",
      stop: Promise.resolve(),
    });

    expect(usageScopes).toEqual(["prelive:callback-effect-1"]);
  });

  test("combines all paid sources and enters a safe terminal state at the ceiling", async () => {
    const recorded: unknown[] = [];
    const onSpendingCeiling = vi.fn(async () => undefined);

    await meterTelephoneSessionUsage({
      onSpendingCeiling,
      onSpendingWarning: () => {},
      ratesMicrousdPerMinute: {
        api: 50_000,
        "realtime-media": 100_000,
        telephony: 50_000,
      },
      reserveUsageSlice: async (input) => {
        recorded.push(input);
        return {
          disposition: "safe-terminal-only" as const,
          month: "2026-08",
          reservedSources: ["api", "telephony", "realtime-media"] as const,
          totalMicrousd: 50_000_000,
          warnings: [],
        };
      },
      sessionId: "session-1",
      stop: new Promise(() => undefined),
    });

    expect(recorded).toEqual([
      {
        amountsMicrousd: {
          api: 50_000,
          "realtime-media": 100_000,
          telephony: 50_000,
        },
        sessionId: "session-1",
        usageScopeId: "session-1:minute:1",
      },
    ]);
    expect(onSpendingCeiling).toHaveBeenCalledOnce();
  });
});
