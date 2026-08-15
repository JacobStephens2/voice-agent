import { z } from "zod";

export type TaskStatus = "completed";

export interface EvidenceEventProjection {
  readonly id: string;
  readonly sequence: number;
  readonly kind:
    | "task.accepted"
    | "operation.accepted"
    | "evidence.observed"
    | "operation.completed"
    | "task.completed";
  readonly occurredAt: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface EvidenceRecordProjection {
  readonly task: {
    readonly id: string;
    readonly kind: "bountywell.health.inquiry";
    readonly status: TaskStatus;
    readonly question: string;
    readonly conclusion: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly evidence: readonly EvidenceEventProjection[];
}

export interface BountywellHealthObservation {
  readonly observedAt: string;
  readonly checks: readonly {
    readonly source:
      | "public-health"
      | "authentication-boundary"
      | "service-state"
      | "resource-health";
    readonly outcome: "pass" | "fail";
    readonly summary: string;
    readonly facts: Readonly<Record<string, string | number | boolean>>;
  }[];
  readonly rejectedEvidenceCount: number;
}

export interface BountywellHealthObservationRequest {
  readonly operationId: string;
  readonly taskId: string;
}

export interface BountywellHealthObserver {
  observe(
    request: BountywellHealthObservationRequest,
  ): Promise<BountywellHealthObservation>;
}

export const bountywellHealthInquirySchema = z.object({
  question: z.literal("Is Bountywell healthy?"),
  requestId: z.string().min(1).max(120),
});

const boundedFactValueSchema = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
]);

export const bountywellHealthObservationSchema = z.object({
  checks: z
    .array(
      z.object({
        facts: z
          .record(z.string().min(1).max(60), boundedFactValueSchema)
          .refine((facts) => Object.keys(facts).length <= 8),
        outcome: z.enum(["pass", "fail"]),
        source: z.enum([
          "public-health",
          "authentication-boundary",
          "service-state",
          "resource-health",
        ]),
        summary: z.string().max(240),
      }),
    )
    .max(8),
  observedAt: z.iso.datetime(),
  rejectedEvidenceCount: z.number().int().nonnegative(),
});

export const evidenceRecordProjectionSchema = z.object({
  evidence: z.array(
    z.object({
      details: z.record(z.string(), z.unknown()),
      id: z.string().min(1),
      kind: z.enum([
        "task.accepted",
        "operation.accepted",
        "evidence.observed",
        "operation.completed",
        "task.completed",
      ]),
      occurredAt: z.iso.datetime(),
      sequence: z.number().int().positive(),
      summary: z.string(),
    }),
  ),
  task: z.object({
    conclusion: z.string(),
    createdAt: z.iso.datetime(),
    id: z.string().min(1),
    kind: z.literal("bountywell.health.inquiry"),
    question: z.string(),
    status: z.literal("completed"),
    updatedAt: z.iso.datetime(),
  }),
});
