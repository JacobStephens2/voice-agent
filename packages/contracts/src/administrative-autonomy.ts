import { z } from "zod";

import { grokRunnerPinSchema } from "./grok-delegation.ts";
import { grokEnrollmentCampaignIdSchema } from "./grok-enrollment.ts";

const identifierSchema = z.string().min(1).max(120);
const administrativeIdentitySchema = (kind: "claim" | "operation" | "task") =>
  z
    .string()
    .min(1)
    .max(120)
    .regex(
      new RegExp(
        `^(?:[A-Za-z0-9._:-]+-)?administrative-${kind}-[A-Za-z0-9._:-]+$`,
        "u",
      ),
      `Expected an Administrative ${kind} identity`,
    );

export const administrativeTaskIdSchema = administrativeIdentitySchema(
  "task",
).brand<"AdministrativeTaskId">();
export type AdministrativeTaskId = z.infer<typeof administrativeTaskIdSchema>;

export const administrativeOperationIdSchema = administrativeIdentitySchema(
  "operation",
).brand<"AdministrativeOperationId">();
export type AdministrativeOperationId = z.infer<
  typeof administrativeOperationIdSchema
>;

export const administrativeOperationClaimIdSchema =
  administrativeIdentitySchema("claim").brand<"AdministrativeOperationClaimId">();
export type AdministrativeOperationClaimId = z.infer<
  typeof administrativeOperationClaimIdSchema
>;

export const administrativeTimestampSchema = z.iso
  .datetime({ local: false, offset: false, precision: 3 })
  .brand<"AdministrativeTimestamp">();
export type AdministrativeTimestamp = z.infer<
  typeof administrativeTimestampSchema
>;
const timestampSchema = administrativeTimestampSchema;

export const administrativeActiveExecutionMilliseconds =
  6 * 60 * 60 * 1_000;
export const livePatchRollbackWindowMilliseconds = 30 * 60 * 1_000;

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

export const administrativeImplementationDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);

const administrativeUnavailableProviderSchema = z
  .object({ kind: z.literal("unavailable") })
  .strict();
const administrativeScenarioProviderSchema = z
  .object({
    implementationDigest: administrativeImplementationDigestSchema,
    kind: z.literal("scenario-fake"),
  })
  .strict();
const administrativeGrokProviderSchema = z
  .object({
    enrollmentCampaignId: grokEnrollmentCampaignIdSchema,
    kind: z.literal("grok-build"),
    runnerPin: grokRunnerPinSchema,
  })
  .strict();

export const administrativeExecutionProviderSchema = z.discriminatedUnion(
  "kind",
  [
    administrativeUnavailableProviderSchema,
    administrativeScenarioProviderSchema,
    administrativeGrokProviderSchema,
  ],
);

export const administrativePlanProviderIdentitySchema = z.discriminatedUnion(
  "kind",
  [administrativeScenarioProviderSchema, administrativeGrokProviderSchema],
);
export type AdministrativePlanProviderIdentity = z.infer<
  typeof administrativePlanProviderIdentitySchema
>;

const administrativeObserveImplementationSchema = z
  .object({
    implementationDigest: administrativeImplementationDigestSchema,
    kind: z.literal("production.observe"),
  })
  .strict();
const administrativeWorktreeImplementationSchema = z
  .object({
    implementationDigest: administrativeImplementationDigestSchema,
    kind: z.literal("delegated-worktree.change"),
  })
  .strict();
const administrativeLivePatchExecutorImplementationSchema = z
  .object({
    implementationDigest: administrativeImplementationDigestSchema,
    kind: z.literal("live-patch.apply"),
  })
  .strict();
const administrativeLivePatchManifestImplementationSchema =
  administrativeLivePatchExecutorImplementationSchema.extend({
    rollbackActivationImplementationDigest:
      administrativeImplementationDigestSchema,
  });

const administrativeOperationExecutorImplementationSchema =
  z.discriminatedUnion("kind", [
    administrativeObserveImplementationSchema,
    administrativeWorktreeImplementationSchema,
    administrativeLivePatchExecutorImplementationSchema,
  ]);

export const administrativeOperationExecutorIdentitySchema = z
  .object({
    operationAdapters: z
      .array(administrativeOperationExecutorImplementationSchema)
      .max(3),
  })
  .strict()
  .superRefine((identity, context) => {
    const kinds = identity.operationAdapters.map((adapter) => adapter.kind);
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({
        code: "custom",
        message: "Operation executor implementation identities must be unique",
        path: ["operationAdapters"],
      });
    }
  });
export type AdministrativeOperationExecutorIdentity = z.infer<
  typeof administrativeOperationExecutorIdentitySchema
>;

export const administrativeLivePatchRollbackActivatorIdentitySchema = z
  .object({
    implementationDigest: administrativeImplementationDigestSchema,
    kind: z.literal("live-patch.apply"),
  })
  .strict();
export type AdministrativeLivePatchRollbackActivatorIdentity = z.infer<
  typeof administrativeLivePatchRollbackActivatorIdentitySchema
>;

export const administrativeExecutionManifestSchema = z
  .object({
    operationAdapters: z
      .array(
        z.discriminatedUnion("kind", [
          administrativeObserveImplementationSchema,
          administrativeWorktreeImplementationSchema,
          administrativeLivePatchManifestImplementationSchema,
        ]),
      )
      .max(3),
    provider: administrativeExecutionProviderSchema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const kinds = manifest.operationAdapters.map((adapter) => adapter.kind);
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({
        code: "custom",
        message: "Execution manifest Operation adapters must be unique",
        path: ["operationAdapters"],
      });
    }
    if (
      manifest.provider.kind === "unavailable" &&
      manifest.operationAdapters.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "An unavailable provider cannot authorize Operation adapters",
        path: ["operationAdapters"],
      });
    }
  });
export type AdministrativeExecutionManifest = z.infer<
  typeof administrativeExecutionManifestSchema
>;

export const administrativeAuthoritySnapshotSchema = z
  .object({
    executionManifest: administrativeExecutionManifestSchema,
    policyRevision: z.number().int().positive(),
    policyStateVersion: z.number().int().positive(),
  })
  .strict();
export type AdministrativeAuthoritySnapshot = z.infer<
  typeof administrativeAuthoritySnapshotSchema
>;

export const administrativeUnavailableExecutionManifest: AdministrativeExecutionManifest =
  administrativeExecutionManifestSchema.parse({
    operationAdapters: [],
    provider: { kind: "unavailable" },
    schemaVersion: 1,
  });

export const administrativeExecutionManifestFingerprintSchema = z
  .string()
  .min(1)
  .max(2_000);

/** Canonical identity shared by browser CAS, runtime admission, and storage. */
export function administrativeExecutionManifestFingerprint(
  manifest: AdministrativeExecutionManifest,
): string {
  return JSON.stringify(administrativeExecutionManifestSchema.parse(manifest));
}

export function sameAdministrativeExecutionManifest(
  left: AdministrativeExecutionManifest,
  right: AdministrativeExecutionManifest,
): boolean {
  return (
    administrativeExecutionManifestFingerprint(left) ===
    administrativeExecutionManifestFingerprint(right)
  );
}

export function sameAdministrativeAuthoritySnapshot(
  left: AdministrativeAuthoritySnapshot,
  right: AdministrativeAuthoritySnapshot,
): boolean {
  const parsedLeft = administrativeAuthoritySnapshotSchema.parse(left);
  const parsedRight = administrativeAuthoritySnapshotSchema.parse(right);
  return (
    parsedLeft.policyRevision === parsedRight.policyRevision &&
    parsedLeft.policyStateVersion === parsedRight.policyStateVersion &&
    sameAdministrativeExecutionManifest(
      parsedLeft.executionManifest,
      parsedRight.executionManifest,
    )
  );
}

export const administrativeMutationOperationKinds = [
  "delegated-worktree.change",
  "live-patch.apply",
] as const satisfies readonly AdministrativeOperationKind[];

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
    executionManifest: administrativeExecutionManifestSchema.default(
      administrativeUnavailableExecutionManifest,
    ),
    revision: z.number().int().positive(),
  })
  .strict();
export type AdministrativePolicyRevision = z.infer<
  typeof administrativePolicyRevisionSchema
>;

export const administrativeRollbackActivationsSchema = z
  .object({
    activatedOperationCount: z.number().int().nonnegative(),
    activatedOperationIds: z.array(administrativeOperationIdSchema).max(100),
    activatedOperationIdsTruncated: z.boolean(),
    pendingOperationCount: z.number().int().nonnegative(),
    pendingOperationIds: z.array(administrativeOperationIdSchema).max(100),
    pendingOperationIdsTruncated: z.boolean(),
  })
  .strict()
  .superRefine((projection, context) => {
    for (const state of ["activated", "pending"] as const) {
      const count = projection[`${state}OperationCount`];
      const ids = projection[`${state}OperationIds`];
      const truncated = projection[`${state}OperationIdsTruncated`];
      if (count < ids.length || truncated !== (count > ids.length)) {
        context.addIssue({
          code: "custom",
          message: `${state} rollback activation projection is inconsistent`,
          path: [`${state}OperationCount`],
        });
      }
    }
  });

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
      executionManifest: administrativeExecutionManifestSchema,
      revision: z.number().int().positive(),
      stateVersion: z.number().int().positive(),
      status: z.literal("active"),
    }),
    z.object({
      executionManifest: administrativeExecutionManifestSchema,
      rollbackActivations: administrativeRollbackActivationsSchema,
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

const administrativePolicySuspensionDetailsSchema = z
  .object({
    policyRevision: z.number().int().positive(),
    resultingStateVersion: z.number().int().positive(),
  })
  .strict();

export const administrativePolicyEvidenceEventInputSchema = z
  .object({
    details: administrativePolicySuspensionDetailsSchema,
    id: identifierSchema,
    kind: z.literal("administrative.policy.suspended"),
    occurredAt: timestampSchema,
    summary: z.literal("Administrative Autonomy was suspended."),
  })
  .strict();
export type AdministrativePolicyEvidenceEventInput = z.infer<
  typeof administrativePolicyEvidenceEventInputSchema
>;

export const administrativePolicyEvidenceEventSchema =
  administrativePolicyEvidenceEventInputSchema.extend({
    sequence: z.number().int().positive(),
  });
export type AdministrativePolicyEvidenceEvent = z.infer<
  typeof administrativePolicyEvidenceEventSchema
>;

export const administrativePolicyEvidenceProjectionSchema = z
  .object({
    events: z.array(administrativePolicyEvidenceEventSchema).max(100),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((projection, context) => {
    if (
      projection.totalCount < projection.events.length ||
      projection.truncated !==
        (projection.totalCount > projection.events.length)
    ) {
      context.addIssue({
        code: "custom",
        message: "Administrative policy evidence projection is inconsistent",
      });
    }
  });
export type AdministrativePolicyEvidenceProjection = z.infer<
  typeof administrativePolicyEvidenceProjectionSchema
>;

export const administrativeTaskExecutionStatusSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        executionManifest: administrativeExecutionManifestSchema,
        status: z.literal("execution-manifest-present"),
      })
      .strict(),
    z
      .object({
        executionManifest: administrativeExecutionManifestSchema,
        reason: z.literal(
          "An executable Administrative Execution Manifest is not present.",
        ),
        status: z.literal("unavailable"),
      })
      .strict(),
    z
      .object({
        activeExecutionManifest: administrativeExecutionManifestSchema,
        reason: z.literal(
          "The active policy revision does not authorize the configured execution manifest.",
        ),
        runtimeExecutionManifest: administrativeExecutionManifestSchema,
        status: z.literal("activation-required"),
      })
      .strict(),
  ],
);
export type AdministrativeTaskExecutionStatus = z.infer<
  typeof administrativeTaskExecutionStatusSchema
>;

export const administrativeAutonomyStatusSchema = z
  .object({
    policy: administrativePolicyStatusSchema,
    policyEvidence: administrativePolicyEvidenceProjectionSchema,
    taskExecution: administrativeTaskExecutionStatusSchema,
  })
  .strict();
export type AdministrativeAutonomyStatus = z.infer<
  typeof administrativeAutonomyStatusSchema
>;

export const administrativePolicyActivationExpectationSchema = z
  .object({
    expectedActiveRevision: z.number().int().positive().nullable(),
    expectedExecutionManifestFingerprint:
      administrativeExecutionManifestFingerprintSchema,
    expectedStateVersion: z.number().int().nonnegative(),
  })
  .strict();
export type AdministrativePolicyActivationExpectation = z.infer<
  typeof administrativePolicyActivationExpectationSchema
>;

export const activateAdministrativePolicyRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    expectation: administrativePolicyActivationExpectationSchema,
  })
  .strict();

export const suspendAdministrativePolicyRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    expectedRevision: z.number().int().positive(),
    expectedStateVersion: z.number().int().positive(),
  })
  .strict();

export const administrativeRequestedOutcomeSchema = z.enum([
  "fix",
  "repair",
  "restore",
  "propose",
  "open-pull-request",
  "investigate",
]);
export type AdministrativeRequestedOutcome = z.infer<
  typeof administrativeRequestedOutcomeSchema
>;

export const administrativeTaskOutcomeSchema = z.enum([
  "intervention",
  "proposal",
  "investigation",
]);
export type AdministrativeTaskOutcome = z.infer<
  typeof administrativeTaskOutcomeSchema
>;

export const administrativePublicationIntentSchema = z.enum([
  "branch-only",
  "open-pull-request",
]);
export type AdministrativePublicationIntent = z.infer<
  typeof administrativePublicationIntentSchema
>;

export const administrativeIntendedStateSchema = z.string().min(1).max(240);

export const administrativeTaskTargetSchema = z
  .object({
    environment: z.literal("production"),
    registeredCodebaseId: identifierSchema,
  })
  .strict();
export type AdministrativeTaskTarget = z.infer<
  typeof administrativeTaskTargetSchema
>;

export const livePatchRollbackActivationRequestSchema = z
  .object({
    authority: administrativeAuthoritySnapshotSchema,
    armedAt: timestampSchema,
    armedRollbackDeadline: timestampSchema,
    kind: z.literal("activate-armed-live-patch-rollback"),
    mutationAuthorizedAt: timestampSchema.nullable(),
    operationId: administrativeOperationIdSchema,
    rollbackDeadline: timestampSchema,
    target: administrativeTaskTargetSchema,
    taskId: administrativeTaskIdSchema,
  })
  .strict();
export type LivePatchRollbackActivationRequest = z.infer<
  typeof livePatchRollbackActivationRequestSchema
>;

export const livePatchRollbackActivationResultSchema = z
  .object({
    activatedAt: timestampSchema,
    kind: z.literal("live-patch-rollback-activated"),
    operationId: administrativeOperationIdSchema,
    outcome: z.enum(["activated", "already-activated"]),
    productionMutationRetained: z.literal(false),
    target: administrativeTaskTargetSchema,
    taskId: administrativeTaskIdSchema,
    verifiedBy: z.literal("independent-live-patch-rollback-controller"),
  })
  .strict();
export type LivePatchRollbackActivationResult = z.infer<
  typeof livePatchRollbackActivationResultSchema
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

const administrativeOperationRequestFields = {
  authority: administrativeAuthoritySnapshotSchema,
  operationId: administrativeOperationIdSchema,
  target: administrativeTaskTargetSchema,
  taskId: administrativeTaskIdSchema,
};

export const livePatchMutationBoundarySchema = z
  .object({
    healthCheck: z
      .object({
        kind: z.literal("registered-application-health"),
        requiredBeforeMutation: z.literal(true),
      })
      .strict(),
    independentRollback: z
      .object({
        armedBeforeMutation: z.literal(true),
        kind: z.literal("independent-live-patch-rollback"),
        rollbackWindowMilliseconds: z.literal(
          livePatchRollbackWindowMilliseconds,
        ),
      })
      .strict(),
    reconciliation: z
      .object({
        acceptedOutcomes: z.tuple([
          z.literal("captured-as-isolated-pull-request"),
          z.literal("removed-from-production"),
        ]),
        kind: z.literal("live-patch-reconciliation"),
        requiredBeforeTaskCompletion: z.literal(true),
      })
      .strict(),
    verification: z
      .object({
        kind: z.literal("independent-application-health-proof"),
        requiredAfterMutation: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type LivePatchMutationBoundary = z.infer<
  typeof livePatchMutationBoundarySchema
>;

export const administrativeOperationRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        ...administrativeOperationRequestFields,
        kind: z.literal("production.observe"),
        observation: z
          .object({
            intendedState: administrativeIntendedStateSchema,
            kind: z.literal("registered-application-health"),
            targetSource: z.literal("confirmed-durable-task"),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...administrativeOperationRequestFields,
        change: z
          .object({
            intendedState: administrativeIntendedStateSchema,
            kind: z.literal("achieve-confirmed-intended-state"),
            targetSource: z.literal("confirmed-durable-task"),
          })
          .strict(),
        kind: z.literal("delegated-worktree.change"),
        publication: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("branch-only"),
              productionMutation: z.literal(false),
            })
            .strict(),
          z
            .object({
              baseBranch: z.literal("registered-production-branch"),
              kind: z.literal("open-pull-request"),
              productionMutation: z.literal(false),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...administrativeOperationRequestFields,
        kind: z.literal("live-patch.apply"),
        mutationBoundary: livePatchMutationBoundarySchema,
        patch: z
          .object({
            intendedState: administrativeIntendedStateSchema,
            kind: z.literal("achieve-confirmed-intended-state"),
            targetSource: z.literal("confirmed-durable-task"),
          })
          .strict(),
      })
      .strict(),
  ],
);
export type AdministrativeOperationRequest = z.infer<
  typeof administrativeOperationRequestSchema
>;

const administrativeOperationResultFields = {
  completedAt: timestampSchema,
  effect: z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("effect-performed"),
        startedAt: timestampSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("idempotent-effect-replay"),
        originallyStartedAt: timestampSchema,
        replayedAt: timestampSchema,
      })
      .strict(),
  ]),
  operationId: administrativeOperationIdSchema,
  summary: z.string().min(1).max(240),
};

export const livePatchMutationProofSchema = z
  .object({
    healthCheck: z
      .object({
        kind: z.literal("registered-application-health"),
        observedAt: timestampSchema,
        status: z.literal("healthy"),
      })
      .strict(),
    independentRollback: z
      .object({
        armedBeforeMutation: z.literal(true),
        armedAt: timestampSchema,
        kind: z.literal("independent-live-patch-rollback"),
        rollbackDeadline: timestampSchema,
      })
      .strict(),
    mutationStartedAt: timestampSchema,
    reconciliation: z.discriminatedUnion("kind", [
      z
        .object({
          baseBranch: z.literal("registered-production-branch"),
          kind: z.literal("captured-as-isolated-pull-request"),
          observedAt: timestampSchema,
          productionMutationRetained: z.literal(true),
          reconciledPatch: z.literal("accepted-live-patch-diff"),
          registeredCodebaseId: identifierSchema,
          state: z.literal("open"),
          verifiedBy: z.literal("independent-reconciliation-observer"),
        })
        .strict(),
      z
        .object({
          kind: z.literal("removed-from-production"),
          observedAt: timestampSchema,
          productionMutationRetained: z.literal(false),
          registeredCodebaseId: identifierSchema,
          verifiedBy: z.literal("independent-reconciliation-observer"),
        })
        .strict(),
    ]),
    verification: z
      .object({
        kind: z.literal("independent-application-health-proof"),
        observedAt: timestampSchema,
        status: z.literal("healthy"),
      })
      .strict(),
  })
  .strict();
export type LivePatchMutationProof = z.infer<
  typeof livePatchMutationProofSchema
>;

export const administrativeOperationResultSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        ...administrativeOperationResultFields,
        kind: z.literal("production.observe"),
        observation: z
          .object({
            kind: z.literal("registered-application-health"),
            status: z.enum(["healthy", "unhealthy"]),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...administrativeOperationResultFields,
        kind: z.literal("delegated-worktree.change"),
        publication: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("isolated-branch-prepared"),
              productionMutation: z.literal(false),
            })
            .strict(),
          z
            .object({
              baseBranch: z.literal("registered-production-branch"),
              kind: z.literal("isolated-pull-request-opened"),
              productionMutation: z.literal(false),
              registeredCodebaseId: identifierSchema,
              state: z.literal("open"),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...administrativeOperationResultFields,
        kind: z.literal("live-patch.apply"),
        mutationProof: livePatchMutationProofSchema,
      })
      .strict(),
  ],
);
export type AdministrativeOperationResult = z.infer<
  typeof administrativeOperationResultSchema
>;

export const administrativeTaskSchema = z
  .object({
    activeExecutionDeadline: timestampSchema.nullable(),
    conclusion: z.string().min(1).max(240),
    createdAt: timestampSchema,
    id: administrativeTaskIdSchema,
    intendedState: administrativeIntendedStateSchema,
    kind: z.literal("administrative.work"),
    outcome: administrativeTaskOutcomeSchema,
    executionManifest: administrativeExecutionManifestSchema,
    policyRevision: z.number().int().positive(),
    policyStateVersion: z.number().int().positive(),
    publicationIntent: administrativePublicationIntentSchema,
    question: z.string().min(1).max(500),
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

/** The single authority value persisted with and recovered from a Task. */
export function administrativeTaskAuthoritySnapshot(
  task: Pick<
    AdministrativeTask,
    "executionManifest" | "policyRevision" | "policyStateVersion"
  >,
): AdministrativeAuthoritySnapshot {
  return administrativeAuthoritySnapshotSchema.parse({
    executionManifest: task.executionManifest,
    policyRevision: task.policyRevision,
    policyStateVersion: task.policyStateVersion,
  });
}

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
      intendedState: administrativeIntendedStateSchema,
      outcome: administrativeTaskOutcomeSchema,
      publicationIntent: administrativePublicationIntentSchema,
      policyRevision: z.number().int().positive(),
      requestId: identifierSchema,
      stateVersion: z.number().int().positive(),
    }),
    kind: z.literal("administrative.confirmation.prepared"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      activeExecutionDeadline: timestampSchema,
      policyRevision: z.number().int().positive(),
    }),
    kind: z.literal("administrative.confirmation.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({ reason: z.literal("Task Confirmation was declined") }),
    kind: z.literal("administrative.confirmation.declined"),
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
      operationId: administrativeOperationIdSchema,
      policyRevision: z.number().int().positive(),
      stateVersion: z.number().int().positive(),
    }),
    kind: z.literal("administrative.operation.accepted"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      kind: administrativeOperationKindSchema,
      operationId: administrativeOperationIdSchema,
      result: administrativeOperationResultSchema,
    }),
    kind: z.literal("administrative.operation.completed"),
  }),
  z.object({
    ...eventFields,
    details: z
      .object({
        operationId: administrativeOperationIdSchema,
        result: livePatchRollbackActivationResultSchema,
      })
      .strict(),
    kind: z.literal("administrative.live-patch.rollback-activated"),
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
