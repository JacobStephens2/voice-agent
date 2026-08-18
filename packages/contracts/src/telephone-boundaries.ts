import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const durationSchema = z.number().int().nonnegative().max(7_200_000);
const moneySchema = z.number().int().nonnegative().max(1_000_000_000_000);
const spendingCeilingSchema = moneySchema.max(1_000_000_000);
const usageSourceSchema = z.enum(["api", "telephony", "realtime-media"]);
export type TelephoneUsageSource = z.infer<typeof usageSourceSchema>;
export const telephoneSpendingWarningThresholds = [
  25_000_000,
  40_000_000,
] as const;
export type TelephoneSpendingWarningThreshold =
  (typeof telephoneSpendingWarningThresholds)[number];

export interface TelephoneUsageResult {
  readonly disposition: "continue" | "safe-terminal-only";
  readonly month: string;
  readonly totalMicrousd: number;
  readonly warnings: readonly TelephoneSpendingWarningThreshold[];
}

export interface TelephoneUsageReservationResult extends TelephoneUsageResult {
  readonly reservedSources: readonly TelephoneUsageSource[];
}

const evidenceFields = {
  id: identifierSchema,
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
};

export const telephoneSessionEndedEvidenceEventSchema = z.object({
  ...evidenceFields,
  details: z.object({
    durationMs: durationSchema,
    reason: z.enum([
      "completed",
      "disconnected",
      "maximum-duration",
      "prolonged-silence",
      "provider-failure",
      "spending-ceiling",
    ]),
  }),
  kind: z.literal("telephone.session.ended"),
});

export const telephoneUsageRecordedEvidenceEventSchema = z.object({
  ...evidenceFields,
  details: z.object({
    amountMicrousd: moneySchema,
    monthTotalMicrousd: moneySchema,
    source: usageSourceSchema,
  }),
  kind: z.literal("telephone.usage.recorded"),
});

export const telephoneSpendingWarningEvidenceEventSchema = z.object({
  ...evidenceFields,
  details: z.object({
    monthTotalMicrousd: moneySchema,
    thresholdMicrousd: z.union([
      z.literal(telephoneSpendingWarningThresholds[0]),
      z.literal(telephoneSpendingWarningThresholds[1]),
    ]),
  }),
  kind: z.literal("telephone.spending.warning"),
});

export const telephoneAudioDebugEnabledEvidenceEventSchema = z.object({
  ...evidenceFields,
  details: z.object({
    expiresAt: timestampSchema,
    rawAudio: z.literal(true),
  }),
  kind: z.literal("telephone.audio-debug.enabled"),
});

export const telephoneAudioDebugRevokedEvidenceEventSchema = z.object({
  ...evidenceFields,
  details: z.object({
    reason: z.enum(["session-ended", "session-unavailable"]),
  }),
  kind: z.literal("telephone.audio-debug.revoked"),
});

export const telephoneAudioDebugCleanedEvidenceEventSchema = z.object({
  ...evidenceFields,
  details: z.object({
    outcome: z.enum(["deleted", "failed", "missing"]),
  }),
  kind: z.literal("telephone.audio-debug.cleaned"),
});

export const telephoneBoundaryEvidenceEventSchema = z.discriminatedUnion(
  "kind",
  [
    telephoneAudioDebugCleanedEvidenceEventSchema,
    telephoneAudioDebugEnabledEvidenceEventSchema,
    telephoneAudioDebugRevokedEvidenceEventSchema,
    telephoneSessionEndedEvidenceEventSchema,
    telephoneSpendingWarningEvidenceEventSchema,
    telephoneUsageRecordedEvidenceEventSchema,
  ],
);
export type TelephoneBoundaryEvidenceEvent = z.infer<
  typeof telephoneBoundaryEvidenceEventSchema
>;

export const telephoneBoundaryStatusSchema = z.object({
  audioDebug: z.object({ activeGrants: z.number().int().nonnegative() }),
  spending: z.object({
    bySourceMicrousd: z.object({
      api: moneySchema,
      "realtime-media": moneySchema,
      telephony: moneySchema,
    }),
    ceilingMicrousd: spendingCeilingSchema,
    month: z.string().regex(/^\d{4}-\d{2}$/u),
    totalMicrousd: moneySchema,
  }),
});
export type TelephoneBoundaryStatus = z.infer<
  typeof telephoneBoundaryStatusSchema
>;

export const changeTelephoneSpendingCeilingRequestSchema = z
  .object({
    ceilingMicrousd: spendingCeilingSchema.min(1_000_000),
    csrfToken: z.string().min(1).max(200),
  })
  .strict();

export const changeTelephoneSpendingCeilingResultSchema = z.object({
  ceilingMicrousd: spendingCeilingSchema,
  decision: z.literal("accepted"),
  revision: z.number().int().positive(),
});

export const authorizeRawAudioDebugRequestSchema = z
  .object({ csrfToken: z.string().min(1).max(200) })
  .strict();

export const authorizeRawAudioDebugResultSchema = z.object({
  decision: z.literal("accepted"),
  expiresAt: timestampSchema,
  sessionId: identifierSchema,
});
