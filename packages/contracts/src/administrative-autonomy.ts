import { z } from "zod";

import { grokRunnerPinSchema } from "./grok-delegation.ts";
import { grokEnrollmentCampaignIdSchema } from "./grok-enrollment.ts";
import {
  delegationCommitSchema,
  delegationIdSchema,
  delegationResultCoreSchema,
  delegationWorktreeSchema,
} from "./delegation.ts";
import {
  registeredCodebaseIdSchema,
  registeredCodebaseSchema,
} from "./promotion.ts";

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
export const livePatchRollbackActivationAttemptMilliseconds = 30 * 1_000;

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

export const livePatchRollbackActivationFailureReasonSchema = z.enum([
  "implementation-mismatch",
  "transient-failure",
]);
export type LivePatchRollbackActivationFailureReason = z.infer<
  typeof livePatchRollbackActivationFailureReasonSchema
>;

const pendingLivePatchRollbackActivationProjectionSchema = z
  .object({
    attemptCount: z.number().int().nonnegative(),
    lastFailureReason:
      livePatchRollbackActivationFailureReasonSchema.nullable(),
    nextAttemptAt: timestampSchema,
    operationId: administrativeOperationIdSchema,
  })
  .strict();

export const administrativeRollbackActivationsSchema = z
  .object({
    activatedOperationCount: z.number().int().nonnegative(),
    activatedOperationIds: z.array(administrativeOperationIdSchema).max(100),
    activatedOperationIdsTruncated: z.boolean(),
    pendingOperationCount: z.number().int().nonnegative(),
    pendingOperationIds: z.array(administrativeOperationIdSchema).max(100),
    pendingOperationIdsTruncated: z.boolean(),
    pendingActivations: z
      .array(pendingLivePatchRollbackActivationProjectionSchema)
      .max(100),
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
    if (
      projection.pendingActivations.length !==
        projection.pendingOperationIds.length ||
      projection.pendingActivations.some(
        (activation, index) =>
          activation.operationId !== projection.pendingOperationIds[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "pending rollback activation details are inconsistent",
        path: ["pendingActivations"],
      });
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

export const administrativePolicyEvidencePageRequestSchema = z
  .object({
    beforeSequence: z.coerce.number().int().positive().nullable().default(null),
    limit: z.coerce.number().int().positive().max(100).default(100),
  })
  .strict();
export type AdministrativePolicyEvidencePageRequest = z.infer<
  typeof administrativePolicyEvidencePageRequestSchema
>;

export const administrativePolicyEvidencePageSchema = z
  .object({
    events: z.array(administrativePolicyEvidenceEventSchema).max(100),
    hasMore: z.boolean(),
    nextBeforeSequence: z.number().int().positive().nullable(),
    totalCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((page, context) => {
    const expectedCursor = page.hasMore ? page.events[0]?.sequence : null;
    if (
      page.totalCount < page.events.length ||
      page.nextBeforeSequence !== expectedCursor
    ) {
      context.addIssue({
        code: "custom",
        message: "Administrative policy evidence page is inconsistent",
      });
    }
  });
export type AdministrativePolicyEvidencePage = z.infer<
  typeof administrativePolicyEvidencePageSchema
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

export const administrativePolicySuspensionExpectationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    expectedStateVersion: z.number().int().positive(),
  })
  .strict();
export type AdministrativePolicySuspensionExpectation = z.infer<
  typeof administrativePolicySuspensionExpectationSchema
>;

export const suspendAdministrativePolicyRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    expectation: administrativePolicySuspensionExpectationSchema,
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

export const administrativeTaskTargetRequestSchema = z
  .object({
    environment: z.literal("production"),
    registeredCodebaseId: registeredCodebaseIdSchema,
  })
  .strict();
export type AdministrativeTaskTargetRequest = z.infer<
  typeof administrativeTaskTargetRequestSchema
>;
export type AdministrativeTaskTargetRequestInput = z.input<
  typeof administrativeTaskTargetRequestSchema
>;

export const administrativeConfirmationCapabilitySchema = z
  .string()
  .min(16)
  .max(500);

export const prepareAdministrativeTaskConfirmationRequestSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    intendedState: administrativeIntendedStateSchema,
    outcome: administrativeRequestedOutcomeSchema,
    requestId: identifierSchema,
    target: administrativeTaskTargetRequestSchema,
  })
  .strict();

export const answerAdministrativeTaskConfirmationRequestSchema = z
  .object({
    confirmation: z.enum(["ambiguous", "confirmed", "declined"]),
    confirmationCapability: administrativeConfirmationCapabilitySchema,
    csrfToken: z.string().min(16).max(200),
  })
  .strict();

const administrativeRegisteredCodebasePathSchema = z
  .string()
  .min(1)
  .max(500)
  .startsWith("/")
  .refine(
    (candidate) =>
      candidate !== "/" &&
      !candidate.endsWith("/") &&
      candidate
        .split("/")
        .slice(1)
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "Registered Codebase paths must be canonical absolute paths below filesystem root",
  );

export const administrativeRegisteredCodebaseSchema =
  registeredCodebaseSchema.extend({
    expiresAt: timestampSchema,
    liveCheckoutPath: administrativeRegisteredCodebasePathSchema,
    revision: z.number().int().positive(),
    sourceCheckoutRoot: administrativeRegisteredCodebasePathSchema,
    verificationCommands: z.array(z.string().min(1).max(200)).min(1).max(10),
    worktreeRoot: administrativeRegisteredCodebasePathSchema,
  });
export type AdministrativeRegisteredCodebase = z.infer<
  typeof administrativeRegisteredCodebaseSchema
>;

export const administrativeTaskTargetSchema =
  administrativeTaskTargetRequestSchema.extend({
    registeredCodebase: administrativeRegisteredCodebaseSchema,
  })
  .superRefine((target, context) => {
    if (
      target.registeredCodebase.registeredCodebaseId !==
      target.registeredCodebaseId
    ) {
      context.addIssue({
        code: "custom",
        message: "Registered Codebase snapshot does not match its identity",
        path: ["registeredCodebase"],
      });
    }
  });
export type AdministrativeTaskTarget = z.infer<
  typeof administrativeTaskTargetSchema
>;

export const administrativeTaskTargetFingerprintSchema = z
  .string()
  .min(1)
  .max(8_000)
  .brand<"AdministrativeTaskTargetFingerprint">();
export type AdministrativeTaskTargetFingerprint = z.infer<
  typeof administrativeTaskTargetFingerprintSchema
>;

export interface AdministrativeTaskTargetBinding {
  readonly target: AdministrativeTaskTarget;
  readonly targetFingerprint: AdministrativeTaskTargetFingerprint;
}

/** Exact identity of the complete Task target and trusted registration snapshot. */
export function administrativeTaskTargetFingerprint(
  target: AdministrativeTaskTarget,
): AdministrativeTaskTargetFingerprint {
  return administrativeTaskTargetFingerprintSchema.parse(
    JSON.stringify(administrativeTaskTargetSchema.parse(target)),
  );
}

export function administrativeTaskTargetBinding(
  target: AdministrativeTaskTarget,
): AdministrativeTaskTargetBinding {
  const trustedTarget = administrativeTaskTargetSchema.parse(target);
  return {
    target: trustedTarget,
    targetFingerprint: administrativeTaskTargetFingerprint(trustedTarget),
  };
}

export function isAdministrativeTaskTargetBinding(
  binding: AdministrativeTaskTargetBinding,
): boolean {
  return (
    binding.targetFingerprint ===
    administrativeTaskTargetFingerprint(binding.target)
  );
}

export function sameAdministrativeTaskTargetBinding(
  left: AdministrativeTaskTargetBinding,
  right: AdministrativeTaskTargetBinding,
): boolean {
  return (
    isAdministrativeTaskTargetBinding(left) &&
    isAdministrativeTaskTargetBinding(right) &&
    left.targetFingerprint === right.targetFingerprint
  );
}

export function sameAdministrativeTaskTarget(
  left: AdministrativeTaskTarget,
  right: AdministrativeTaskTarget,
): boolean {
  return (
    sameAdministrativeTaskTargetBinding(
      administrativeTaskTargetBinding(left),
      administrativeTaskTargetBinding(right),
    )
  );
}

export function sameAdministrativeRegisteredCodebase(
  left: AdministrativeRegisteredCodebase,
  right: AdministrativeRegisteredCodebase,
): boolean {
  return (
    JSON.stringify(administrativeRegisteredCodebaseSchema.parse(left)) ===
    JSON.stringify(administrativeRegisteredCodebaseSchema.parse(right))
  );
}

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
    targetFingerprint: administrativeTaskTargetFingerprintSchema,
    taskId: administrativeTaskIdSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (!isAdministrativeTaskTargetBinding(request)) {
      context.addIssue({
        code: "custom",
        message: "Live Patch rollback request target fingerprint is invalid",
        path: ["targetFingerprint"],
      });
    }
  });
export type LivePatchRollbackActivationRequest = z.infer<
  typeof livePatchRollbackActivationRequestSchema
>;

export const pendingLivePatchRollbackActivationSchema = z
  .object({
    attemptCount: z.number().int().nonnegative(),
    lastFailureReason:
      livePatchRollbackActivationFailureReasonSchema.nullable(),
    nextAttemptAt: timestampSchema,
    request: livePatchRollbackActivationRequestSchema,
  })
  .strict();
export type PendingLivePatchRollbackActivation = z.infer<
  typeof pendingLivePatchRollbackActivationSchema
>;

export const livePatchRollbackActivationResultSchema = z
  .object({
    activatedAt: timestampSchema,
    kind: z.literal("live-patch-rollback-activated"),
    operationId: administrativeOperationIdSchema,
    outcome: z.enum(["activated", "already-activated"]),
    productionMutationRetained: z.literal(false),
    target: administrativeTaskTargetSchema,
    targetFingerprint: administrativeTaskTargetFingerprintSchema,
    taskId: administrativeTaskIdSchema,
    verifiedBy: z.literal("independent-live-patch-rollback-controller"),
  })
  .strict()
  .superRefine((result, context) => {
    if (!isAdministrativeTaskTargetBinding(result)) {
      context.addIssue({
        code: "custom",
        message: "Live Patch rollback result target fingerprint is invalid",
        path: ["targetFingerprint"],
      });
    }
  });
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

export const administrativeDelegationBriefSchema = z
  .object({
    acceptanceCriteria: z
      .object({
        automaticVerification: z
          .object({
            commands: z.array(z.string().min(1).max(200)).min(1).max(10),
            kind: z.literal("registered-codebase-verification"),
          })
          .strict(),
        intendedState: z
          .object({
            intendedState: administrativeIntendedStateSchema,
            kind: z.literal("confirmed-intended-state"),
            targetSource: z.literal("confirmed-durable-task"),
          })
          .strict(),
      })
      .strict(),
    authorizedCapabilities: z.union([
      z.tuple([
        z.literal("registered-source.read"),
        z.literal("delegated-worktree.write"),
        z.literal("verification.run"),
        z.literal("verified-candidate.prepare"),
      ]),
      z.tuple([
        z.literal("registered-source.read"),
        z.literal("delegated-worktree.write"),
        z.literal("verification.run"),
        z.literal("verified-candidate.prepare"),
        z.literal("verified-candidate.publish"),
      ]),
    ]),
    boundedContext: z
      .object({
        editableScope: z.literal("registered-codebase"),
        rawVoiceTranscriptIncluded: z.literal(false),
        repositoryContentTrust: z.literal("untrusted-data-only"),
        source: z.literal("confirmed-durable-task-and-registration"),
      })
      .strict(),
    constraints: z.tuple([
      z.literal("delegated-worktree-only"),
      z.literal("production-mutation-forbidden"),
      z.literal("production-ref-mutation-forbidden"),
      z.literal("human-merge-required"),
    ]),
    delegationId: administrativeOperationIdSchema,
    goal: z
      .object({
        intendedState: administrativeIntendedStateSchema,
        kind: z.literal("achieve-confirmed-intended-state"),
        targetSource: z.literal("confirmed-durable-task"),
      })
      .strict(),
    registeredCodebase: administrativeRegisteredCodebaseSchema,
  })
  .strict();
export type AdministrativeDelegationBrief = z.infer<
  typeof administrativeDelegationBriefSchema
>;

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

export const administrativeOperationRequestSchema = z
  .discriminatedUnion("kind", [
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
        delegation: z
          .object({
            brief: administrativeDelegationBriefSchema,
            worktree: delegationWorktreeSchema,
          })
          .strict(),
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
  ])
  .superRefine((request, context) => {
    if (request.kind !== "delegated-worktree.change") return;
    const { brief, worktree } = request.delegation;
    const publishes = request.publication.kind === "open-pull-request";
    const valid =
      brief.delegationId === request.operationId &&
      brief.goal.intendedState === request.change.intendedState &&
      brief.acceptanceCriteria.intendedState.intendedState ===
        request.change.intendedState &&
      JSON.stringify(
        brief.acceptanceCriteria.automaticVerification.commands,
      ) === JSON.stringify(brief.registeredCodebase.verificationCommands) &&
      sameAdministrativeRegisteredCodebase(
        brief.registeredCodebase,
        request.target.registeredCodebase,
      ) &&
      (brief.authorizedCapabilities.length === 5) === publishes &&
      worktree.id === request.operationId &&
      worktree.baseCommit ===
        request.target.registeredCodebase.initialProductionCommit &&
      worktree.branch === `administrative/${request.operationId}` &&
      worktree.path ===
        `${request.target.registeredCodebase.worktreeRoot}/${request.operationId}`;
    if (!valid) {
      context.addIssue({
        code: "custom",
        message:
          "The Delegation Brief and worktree must derive from the confirmed task and Registered Codebase",
        path: ["delegation"],
      });
    }
  });
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

const livePatchTargetProofFields = {
  registeredCodebaseId: registeredCodebaseIdSchema,
  targetFingerprint: administrativeTaskTargetFingerprintSchema,
};

const livePatchIdentitySchema = z
  .object({
    intendedState: administrativeIntendedStateSchema,
    operationId: administrativeOperationIdSchema,
    ...livePatchTargetProofFields,
  })
  .strict();

const livePatchCandidateSchema = z
  .object({
    branch: z.string().min(1).max(200),
    commit: delegationCommitSchema,
    kind: z.literal("isolated-live-patch-candidate"),
    patch: livePatchIdentitySchema,
    repository: administrativeRegisteredCodebaseSchema.shape.repository,
  })
  .strict();

const isolatedLivePatchCaptureSchema = z
  .object({
    baseBranch: z.string().min(1).max(200),
    baseCommit: delegationCommitSchema,
    candidate: livePatchCandidateSchema,
    kind: z.literal("isolated-live-patch-capture"),
    pullRequestNumber: z.number().int().positive(),
    pullRequestUrl: z
      .url()
      .startsWith("https://github.com/")
      .max(500),
    repository: administrativeRegisteredCodebaseSchema.shape.repository,
    state: z.literal("open"),
  })
  .strict();

export const livePatchMutationProofSchema = z
  .object({
    candidate: livePatchCandidateSchema,
    healthCheck: z
      .object({
        kind: z.literal("registered-application-health"),
        observedAt: timestampSchema,
        ...livePatchTargetProofFields,
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
          capture: isolatedLivePatchCaptureSchema,
          kind: z.literal("captured-as-isolated-pull-request"),
          observedAt: timestampSchema,
          productionMutationRetained: z.literal(true),
          verifiedBy: z.literal("independent-reconciliation-observer"),
        })
        .strict(),
      z
        .object({
          candidate: livePatchCandidateSchema,
          kind: z.literal("removed-from-production"),
          observedAt: timestampSchema,
          productionBranch:
            administrativeRegisteredCodebaseSchema.shape.productionBranch,
          productionCommit: delegationCommitSchema,
          productionMutationRetained: z.literal(false),
          verifiedBy: z.literal("independent-reconciliation-observer"),
        })
        .strict(),
    ]),
    verification: z
      .object({
        kind: z.literal("independent-application-health-proof"),
        observedAt: timestampSchema,
        ...livePatchTargetProofFields,
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
        delegation: delegationResultCoreSchema,
        kind: z.literal("delegated-worktree.change"),
        publication: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("not-published"),
              productionMutation: z.literal(false),
              reason: z.enum(["delegation-failed", "delegation-stopped"]),
            })
            .strict(),
          z
            .object({
              branch: z.string().min(1).max(200),
              headCommit: delegationCommitSchema,
              kind: z.literal("isolated-branch-prepared"),
              productionMutation: z.literal(false),
            })
            .strict(),
          z
            .object({
              baseBranch: z.literal("registered-production-branch"),
              headBranch: z.string().min(1).max(200),
              headCommit: delegationCommitSchema,
              kind: z.literal("isolated-pull-request-opened"),
              productionMutation: z.literal(false),
              registeredCodebaseId: registeredCodebaseIdSchema,
              state: z.literal("open"),
              url: z.url().startsWith("https://github.com/"),
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

export const administrativeOperationRecoveryResultSchema =
  z.discriminatedUnion("decision", [
    z.object({ decision: z.literal("not-completed") }).strict(),
    z
      .object({
        decision: z.literal("completed"),
        result: administrativeOperationResultSchema,
      })
      .strict(),
  ]);
export type AdministrativeOperationRecoveryResult = z.infer<
  typeof administrativeOperationRecoveryResultSchema
>;

export interface AdministrativeDelegatedWorktreeResultValidation {
  readonly completed: number;
  readonly effectStarted: number;
  readonly reportedCompletedAt: AdministrativeTimestamp;
}

/**
 * Correlates the canonical Delegation Result with the exact Administrative
 * Delegation request that owns it. Runtime code supplies only trusted timing;
 * structural traversal remains encapsulated beside the contracts themselves.
 */
export function validateAdministrativeDelegatedWorktreeResultBinding(
  request: Extract<
    AdministrativeOperationRequest,
    { readonly kind: "delegated-worktree.change" }
  >,
  result: Extract<
    AdministrativeOperationResult,
    { readonly kind: "delegated-worktree.change" }
  >,
  timing: AdministrativeDelegatedWorktreeResultValidation,
): void {
  const delegation = result.delegation;
  const candidate = delegation.verification.candidate;
  const reportedCompleted = new Date(timing.reportedCompletedAt).getTime();
  const expectedWorktree = request.delegation.worktree;
  const expectedDelegationId = delegationIdSchema.parse(
    request.delegation.brief.delegationId,
  );
  const expectedCommands =
    request.delegation.brief.acceptanceCriteria.automaticVerification.commands;
  const headCommit = delegation.commits.at(-1);
  const verificationPassed =
    expectedCommands.every((command) =>
      delegation.verification.automated.some(
        (verification) =>
          verification.command === command &&
          verification.outcome === "passed",
      ),
    ) &&
    delegation.verification.automated.every(
      (verification) => verification.outcome === "passed",
    );
  const commonProofMismatch =
    delegation.delegationId !== expectedDelegationId ||
    delegation.completedAt !== timing.reportedCompletedAt ||
    reportedCompleted < timing.effectStarted ||
    reportedCompleted > timing.completed ||
    delegation.branch !== expectedWorktree.branch ||
    delegation.worktree.id !== expectedWorktree.id ||
    delegation.worktree.baseCommit !== expectedWorktree.baseCommit ||
    delegation.worktree.branch !== expectedWorktree.branch ||
    delegation.worktree.path !== expectedWorktree.path;
  if (commonProofMismatch) {
    throw new Error(
      "Administrative Delegation Result is incomplete, mismatched, or unverified",
    );
  }
  if (delegation.status !== "completed") {
    const expectedPublicationReason =
      delegation.status === "failed"
        ? "delegation-failed"
        : "delegation-stopped";
    const verificationIsBounded = delegation.verification.automated.every(
      (verification) => expectedCommands.includes(verification.command),
    );
    const candidateMatches =
      candidate === null ||
      (headCommit !== undefined &&
        candidate.branch === delegation.branch &&
        candidate.commit === headCommit &&
        candidate.worktreeId === delegation.worktree.id);
    const terminalEvidenceMatches =
      delegation.status === "failed"
        ? delegation.failure !== null && delegation.termination === null
        : delegation.failure === null && delegation.termination !== null;
    if (
      delegation.worktree.state !== delegation.status ||
      result.publication.kind !== "not-published" ||
      result.publication.reason !== expectedPublicationReason ||
      !terminalEvidenceMatches ||
      !verificationIsBounded ||
      !candidateMatches
    ) {
      throw new Error(
        "Administrative terminal Delegation Result is incomplete or mismatched",
      );
    }
    return;
  }
  if (
    delegation.failure !== null ||
    delegation.termination !== null ||
    delegation.changedFiles.length === 0 ||
    delegation.commits.length === 0 ||
    delegation.worktree.state !== "completed" ||
    delegation.worktree.dirty ||
    candidate === null ||
    candidate.branch !== delegation.branch ||
    candidate.commit !== headCommit ||
    candidate.worktreeId !== delegation.worktree.id ||
    !verificationPassed
  ) {
    throw new Error(
      "Administrative Delegation Result is incomplete, mismatched, or unverified",
    );
  }
  const matchingPublication =
    (request.publication.kind === "branch-only" &&
      result.publication.kind === "isolated-branch-prepared" &&
      result.publication.branch === delegation.branch &&
      result.publication.headCommit === headCommit) ||
    (request.publication.kind === "open-pull-request" &&
      result.publication.kind === "isolated-pull-request-opened" &&
      result.publication.registeredCodebaseId ===
        request.target.registeredCodebaseId &&
      result.publication.headBranch === delegation.branch &&
      result.publication.headCommit === headCommit &&
      result.publication.url.startsWith(
        `https://github.com/${request.target.registeredCodebase.repository}/pull/`,
      ));
  if (!matchingPublication) {
    throw new Error("Administrative publication proof does not match its request");
  }
}

export function livePatchCaptureBranch(
  operationId: AdministrativeOperationId,
): string {
  return `administrative/live-patch-${operationId}`;
}

/** Match every independently observed proof identity to one immutable request. */
export function isLivePatchMutationProofBoundToRequest(
  request: Extract<AdministrativeOperationRequest, { kind: "live-patch.apply" }>,
  result: Extract<AdministrativeOperationResult, { kind: "live-patch.apply" }>,
): boolean {
  const { registeredCodebase } = request.target;
  const targetFingerprint = administrativeTaskTargetFingerprint(request.target);
  const { candidate, healthCheck, reconciliation, verification } =
    result.mutationProof;
  const targetProofMatches = (
    proof: Pick<
      typeof healthCheck,
      "registeredCodebaseId" | "targetFingerprint"
    >,
  ) =>
    proof.registeredCodebaseId === request.target.registeredCodebaseId &&
    proof.targetFingerprint === targetFingerprint;
  const reconciledCandidate =
    reconciliation.kind === "captured-as-isolated-pull-request"
      ? reconciliation.capture.candidate
      : reconciliation.candidate;
  const candidateMatchesRequest = (value: typeof candidate) =>
    value.branch === livePatchCaptureBranch(request.operationId) &&
    value.repository === registeredCodebase.repository &&
    value.patch.intendedState === request.patch.intendedState &&
    value.patch.operationId === request.operationId &&
    targetProofMatches(value.patch);
  const candidateMatches =
    candidateMatchesRequest(candidate) &&
    candidateMatchesRequest(reconciledCandidate) &&
    candidate.branch === reconciledCandidate.branch &&
    candidate.commit === reconciledCandidate.commit &&
    candidate.repository === reconciledCandidate.repository;
  if (
    result.operationId !== request.operationId ||
    !targetProofMatches(healthCheck) ||
    !targetProofMatches(verification) ||
    !candidateMatches
  ) {
    return false;
  }
  if (reconciliation.kind === "removed-from-production") {
    return (
      reconciliation.productionBranch ===
        registeredCodebase.productionBranch &&
      reconciliation.productionCommit ===
        registeredCodebase.initialProductionCommit
    );
  }
  const pullRequestPrefix = `https://github.com/${registeredCodebase.repository}/pull/`;
  const expectedHeadBranch = livePatchCaptureBranch(request.operationId);
  const { capture } = reconciliation;
  return (
    capture.baseBranch === registeredCodebase.productionBranch &&
    capture.baseCommit === registeredCodebase.initialProductionCommit &&
    capture.candidate.branch === expectedHeadBranch &&
    capture.candidate.repository === registeredCodebase.repository &&
    capture.repository === registeredCodebase.repository &&
    capture.pullRequestUrl === `${pullRequestPrefix}${capture.pullRequestNumber}`
  );
}

export const administrativeTaskSchema = z
  .object({
    activeExecutionDeadline: timestampSchema.nullable(),
    authority: administrativeAuthoritySnapshotSchema,
    conclusion: z.string().min(1).max(240),
    createdAt: timestampSchema,
    id: administrativeTaskIdSchema,
    intendedState: administrativeIntendedStateSchema,
    kind: z.literal("administrative.work"),
    outcome: administrativeTaskOutcomeSchema,
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

export const administrativeTaskPreparationResponseSchema = z.discriminatedUnion(
  "decision",
  [
    z
      .object({
        confirmationCapability: administrativeConfirmationCapabilitySchema,
        decision: z.literal("prepared"),
        policyRevision: z.number().int().positive(),
        stateVersion: z.number().int().positive(),
        task: administrativeTaskSchema,
        taskId: administrativeTaskIdSchema,
      })
      .strict(),
    z
      .object({
        decision: z.literal("denied"),
        reason: z.string().min(1).max(240),
      })
      .strict(),
  ],
);
export type AdministrativeTaskPreparationResponse = z.infer<
  typeof administrativeTaskPreparationResponseSchema
>;

export const administrativeTaskAdmissionResponseSchema = z.discriminatedUnion(
  "decision",
  [
    z
      .object({
        decision: z.literal("admitted"),
        policyRevision: z.number().int().positive(),
        taskId: administrativeTaskIdSchema,
      })
      .strict(),
    z
      .object({
        decision: z.literal("denied"),
        reason: z.string().min(1).max(240),
      })
      .strict(),
  ],
);
export type AdministrativeTaskAdmissionResponse = z.infer<
  typeof administrativeTaskAdmissionResponseSchema
>;

/** The single authority value persisted with and recovered from a Task. */
export function administrativeTaskAuthoritySnapshot(
  task: Pick<AdministrativeTask, "authority">,
): AdministrativeAuthoritySnapshot {
  return administrativeAuthoritySnapshotSchema.parse(task.authority);
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
    details: z.object({
      kind: z.literal("delegated-worktree.change"),
      operationId: administrativeOperationIdSchema,
      result: administrativeOperationResultSchema.refine(
        (result) =>
          result.kind === "delegated-worktree.change" &&
          result.delegation.status !== "completed",
        "A terminal Delegation Evidence Event requires a failed or stopped Delegation Result",
      ),
      terminalStatus: z.enum(["failed", "stopped"]),
    }),
    kind: z.literal("administrative.operation.terminated"),
  }),
  z.object({
    ...eventFields,
    details: z.object({
      kind: administrativeOperationKindSchema,
      operationId: administrativeOperationIdSchema,
      reason: z.string().min(1).max(240),
    }),
    kind: z.literal("administrative.operation.failed"),
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
    details: z
      .object({
        attemptCount: z.number().int().positive(),
        nextAttemptAt: timestampSchema,
        operationId: administrativeOperationIdSchema,
        reason: livePatchRollbackActivationFailureReasonSchema,
      })
      .strict(),
    kind: z.literal("administrative.live-patch.rollback-activation-failed"),
  }),
  z.object({
    ...eventFields,
    details: z
      .object({
        operationId: administrativeOperationIdSchema,
        reconciledAt: timestampSchema,
        rollbackDeadline: timestampSchema,
      })
      .strict(),
    kind: z.literal("administrative.live-patch.rollback-window-expired"),
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
    evidenceTotalCount: z.number().int().nonnegative(),
    evidenceTruncated: z.boolean(),
    task: administrativeTaskSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.evidenceTotalCount < record.evidence.length ||
      record.evidenceTruncated !==
        (record.evidenceTotalCount > record.evidence.length)
    ) {
      context.addIssue({
        code: "custom",
        message: "Administrative Evidence Record projection is inconsistent",
      });
    }
  });
export type AdministrativeEvidenceRecord = z.infer<
  typeof administrativeEvidenceRecordSchema
>;
