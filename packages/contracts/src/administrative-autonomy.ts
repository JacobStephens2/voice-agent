import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();

export const administrativePolicyActivationSourceSchema = z.enum([
  "fresh-passkey-action",
  "trusted-browser-session",
  "voice",
  "repository",
  "provider",
]);
export type AdministrativePolicyActivationSource = z.infer<
  typeof administrativePolicyActivationSourceSchema
>;

export const administrativeOperationKindSchema = z.enum([
  "production.observe",
  "delegated-worktree.change",
  "live-patch.apply",
]);
export type AdministrativeOperationKind = z.infer<
  typeof administrativeOperationKindSchema
>;

export const forbiddenAdministrativeOperationKinds = [
  "policy.revise",
  "shell.root",
  "credential-custody.read",
  "production-data.mutate",
  "git.production-ref.write",
  "pull-request.merge",
  "deployment.execute",
] as const;

export const administrativePolicyDefinitionSchema = z
  .object({
    branchOnlyOperations: z.tuple([
      z.literal("delegated-worktree.change"),
    ]),
    forbiddenOperations: z.tuple([
      z.literal(forbiddenAdministrativeOperationKinds[0]),
      z.literal(forbiddenAdministrativeOperationKinds[1]),
      z.literal(forbiddenAdministrativeOperationKinds[2]),
      z.literal(forbiddenAdministrativeOperationKinds[3]),
      z.literal(forbiddenAdministrativeOperationKinds[4]),
      z.literal(forbiddenAdministrativeOperationKinds[5]),
      z.literal(forbiddenAdministrativeOperationKinds[6]),
    ]),
    livePatchOperations: z.tuple([z.literal("live-patch.apply")]),
    observationalOperations: z.tuple([z.literal("production.observe")]),
    schemaVersion: z.literal(1),
  })
  .strict();
export type AdministrativePolicyDefinition = z.infer<
  typeof administrativePolicyDefinitionSchema
>;

export const administrativePolicyRevisionSchema = z
  .object({
    activatedAt: timestampSchema,
    activatedBy: z.literal("fresh-passkey-action"),
    definition: administrativePolicyDefinitionSchema,
    revision: z.number().int().positive(),
  })
  .strict();
export type AdministrativePolicyRevision = z.infer<
  typeof administrativePolicyRevisionSchema
>;

export const administrativePolicyStatusSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      activeRevision: z.null(),
      stateVersion: z.number().int().nonnegative(),
      status: z.literal("inactive"),
    }),
    z.object({
      activatedAt: timestampSchema,
      activatedBy: z.literal("fresh-passkey-action"),
      revision: z.number().int().positive(),
      stateVersion: z.number().int().positive(),
      status: z.literal("active"),
    }),
    z.object({
      revision: z.number().int().positive(),
      stateVersion: z.number().int().positive(),
      status: z.literal("suspended"),
      suspendedAt: timestampSchema,
    }),
  ],
);
export type AdministrativePolicyStatus = z.infer<
  typeof administrativePolicyStatusSchema
>;

export const activateAdministrativePolicyRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    expectedActiveRevision: z.number().int().positive().nullable(),
  })
  .strict();

export const administrativeTaskOutcomeSchema = z.enum([
  "fix",
  "repair",
  "restore",
  "propose",
  "open-pull-request",
  "investigate",
]);
export type AdministrativeTaskOutcome = z.infer<
  typeof administrativeTaskOutcomeSchema
>;

export const administrativeTaskTargetSchema = z
  .object({
    environment: z.literal("production"),
    registeredCodebaseId: identifierSchema,
  })
  .strict();
export type AdministrativeTaskTarget = z.infer<
  typeof administrativeTaskTargetSchema
>;

export const administrativeProviderPlanSchema = z
  .array(
    z
      .object({
        kind: administrativeOperationKindSchema,
      })
      .strict(),
  )
  .min(1)
  .max(12);
export type AdministrativeProviderPlan = z.infer<
  typeof administrativeProviderPlanSchema
>;

export const administrativeOperationRequestSchema = z
  .object({
    kind: administrativeOperationKindSchema,
    operationId: identifierSchema,
    policyRevision: z.number().int().positive(),
    policyStateVersion: z.number().int().positive(),
    target: administrativeTaskTargetSchema,
    taskId: identifierSchema,
  })
  .strict();
export type AdministrativeOperationRequest = z.infer<
  typeof administrativeOperationRequestSchema
>;

export const administrativeOperationResultSchema = z
  .object({
    completedAt: timestampSchema,
    summary: z.string().min(1).max(240),
  })
  .strict();
export type AdministrativeOperationResult = z.infer<
  typeof administrativeOperationResultSchema
>;

export const administrativeTaskSchema = z
  .object({
    conclusion: z.string().min(1).max(240),
    createdAt: timestampSchema,
    id: identifierSchema,
    kind: z.literal("administrative.work"),
    outcome: administrativeTaskOutcomeSchema,
    policyRevision: z.number().int().positive(),
    policyStateVersion: z.number().int().positive(),
    question: z.string().min(1).max(240),
    status: z.enum([
      "awaiting-confirmation",
      "planning",
      "running",
      "completed",
      "denied",
    ]),
    target: administrativeTaskTargetSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type AdministrativeTask = z.infer<typeof administrativeTaskSchema>;

const eventFields = {
  id: identifierSchema,
  occurredAt: timestampSchema,
  sequence: z.number().int().positive(),
  summary: z.string().min(1).max(240),
};

export const administrativeEvidenceEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...eventFields,
    details: z.object({
      outcome: administrativeTaskOutcomeSchema,
      policyRevision: z.number().int().positive(),
      requestId: identifierSchema,
      stateVersion: z.number().int().positive(),
    }),
    kind: z.literal("administrative.confirmation.prepared"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ policyRevision: z.number().int().positive() }),
    kind: z.literal("administrative.confirmation.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      operations: z.array(administrativeOperationKindSchema).min(1).max(12),
      policyRevision: z.number().int().positive(),
      stateVersion: z.number().int().positive(),
    }),
    kind: z.literal("administrative.plan.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      kind: administrativeOperationKindSchema,
      operationId: identifierSchema,
      policyRevision: z.number().int().positive(),
      stateVersion: z.number().int().positive(),
    }),
    kind: z.literal("administrative.operation.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      kind: administrativeOperationKindSchema,
      operationId: identifierSchema,
      summary: z.string().min(1).max(240),
    }),
    kind: z.literal("administrative.operation.completed"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ policyRevision: z.number().int().positive() }),
    kind: z.literal("administrative.task.completed"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ reason: z.string().min(1).max(240) }),
    kind: z.literal("administrative.task.denied"),
  }),
]);
export type AdministrativeEvidenceEvent = z.infer<
  typeof administrativeEvidenceEventSchema
>;

export const administrativeEvidenceRecordSchema = z
  .object({
    evidence: z.array(administrativeEvidenceEventSchema).max(100),
    task: administrativeTaskSchema,
  })
  .strict();
export type AdministrativeEvidenceRecord = z.infer<
  typeof administrativeEvidenceRecordSchema
>;
