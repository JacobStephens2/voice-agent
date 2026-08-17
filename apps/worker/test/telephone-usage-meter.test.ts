import { describe, expect, test, vi } from "vitest";

import { meterTelephoneSessionUsage } from "../src/telephone-usage-meter.ts";

describe("Telephone Session paid-usage meter", () => {
  test("combines all paid sources and enters a safe terminal state at the ceiling", async () => {
    const recorded: Array<{
      amountMicrousd: number;
      sessionId: string;
      source: string;
      usageId: string;
    }> = [];
    const onSpendingCeiling = vi.fn(async () => undefined);

    await meterTelephoneSessionUsage({
      onSpendingCeiling,
      ratesMicrousdPerMinute: {
        api: 50_000,
        "realtime-media": 100_000,
        telephony: 50_000,
      },
      recordUsage: async (input) => {
        recorded.push(input);
        return {
          disposition:
            input.source === "realtime-media"
              ? "safe-terminal-only" as const
              : "continue" as const,
        };
      },
      sessionId: "session-1",
      stop: new Promise(() => undefined),
    });

    expect(recorded).toEqual([
      { amountMicrousd: 50_000, sessionId: "session-1", source: "api", usageId: "session-1:minute:1:api" },
      { amountMicrousd: 50_000, sessionId: "session-1", source: "telephony", usageId: "session-1:minute:1:telephony" },
      { amountMicrousd: 100_000, sessionId: "session-1", source: "realtime-media", usageId: "session-1:minute:1:realtime-media" },
    ]);
    expect(onSpendingCeiling).toHaveBeenCalledOnce();
  });
});
