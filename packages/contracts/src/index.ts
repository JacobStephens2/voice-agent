import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();

export const bountywellHealthInquiryRequestSchema = z.object({
  question: z.string().min(1).max(240),
  requestId: identifierSchema,
});

export const bountywellHealthInquirySchema =
  bountywellHealthInquiryRequestSchema.extend({
    question: z.literal("Is Bountywell healthy?"),
  });

export type BountywellHealthInquiryRequest = z.infer<
  typeof bountywellHealthInquiryRequestSchema
>;
export type BountywellHealthInquiry = z.infer<
  typeof bountywellHealthInquirySchema
>;

const checkFields = {
  outcome: z.enum(["pass", "fail"]),
  summary: z.string().max(240),
};

export const bountywellHealthCheckSchema = z.discriminatedUnion("source", [
  z.object({
    ...checkFields,
    facts: z.object({ statusCode: z.number().int().min(100).max(599) }),
    source: z.literal("public-health"),
  }),
  z.object({
    ...checkFields,
    facts: z.object({ statusCode: z.number().int().min(100).max(599) }),
    source: z.literal("authentication-boundary"),
  }),
  z.object({
    ...checkFields,
    facts: z.object({ active: z.boolean() }),
    source: z.literal("service-state"),
  }),
  z.object({
    ...checkFields,
    facts: z.object({ diskPressure: z.boolean() }),
    source: z.literal("resource-health"),
  }),
]);

export const bountywellHealthObservationSchema = z.object({
  checks: z.array(bountywellHealthCheckSchema).min(1).max(8),
  observedAt: timestampSchema,
  rejectedEvidenceCount: z.number().int().nonnegative(),
});

export type BountywellHealthObservation = z.infer<
  typeof bountywellHealthObservationSchema
>;

export const bountywellHealthObservationRequestSchema = z.object({
  operationId: identifierSchema,
  taskId: identifierSchema,
});

export type BountywellHealthObservationRequest = z.infer<
  typeof bountywellHealthObservationRequestSchema
>;

export interface BountywellHealthObserver {
  observe(
    request: BountywellHealthObservationRequest,
  ): Promise<BountywellHealthObservation>;
}

const eventFields = {
  id: identifierSchema,
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().max(240),
};

export const evidenceEventProjectionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...eventFields,
    details: z.object({ requestId: identifierSchema }),
    kind: z.literal("task.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ operationId: identifierSchema }),
    kind: z.literal("operation.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      checks: z.array(bountywellHealthCheckSchema).min(1).max(8),
      rejectedEvidenceCount: z.number().int().nonnegative(),
    }),
    kind: z.literal("evidence.observed"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ operationId: identifierSchema }),
    kind: z.literal("operation.completed"),
  }),
  z.object({
    ...eventFields,
    details: z.object({}),
    kind: z.literal("task.completed"),
  }),
]);

export type EvidenceEventProjection = z.infer<
  typeof evidenceEventProjectionSchema
>;

export const evidenceRecordProjectionSchema = z.object({
  evidence: z.array(evidenceEventProjectionSchema).max(100),
  task: z.object({
    conclusion: z.enum([
      "Bountywell API is healthy.",
      "Bountywell API health could not be confirmed.",
    ]),
    createdAt: timestampSchema,
    id: identifierSchema,
    kind: z.literal("bountywell.health.inquiry"),
    question: z.literal("Is Bountywell healthy?"),
    status: z.literal("completed"),
    updatedAt: timestampSchema,
  }),
});

export type EvidenceRecordProjection = z.infer<
  typeof evidenceRecordProjectionSchema
>;
