import { createHash } from "node:crypto";

import {
  administrativeActiveExecutionMilliseconds,
  administrativeOperationRequestSchema,
  administrativeOperationResultSchema,
  administrativeProviderPlanSchema,
  administrativeIntendedStateSchema,
  administrativeRequestedOutcomeSchema,
  administrativeTaskTargetSchema,
  type AdministrativeEvidenceRecord,
  type AdministrativeAutonomyStatus,
  type AdministrativeOperationRequest,
  type AdministrativeOperationResult,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativeRequestedOutcome,
  type AdministrativeTask,
  type AdministrativeTaskOutcome,
  type AdministrativeTaskTarget,
} from "@voice-agent/contracts";
import type { AdministrativeAutonomyStore } from "@voice-agent/durable-store";
import {
  administrativeAutonomyPolicyDefinition,
  authorizeAdministrativePlan,
  authorizeAdministrativePolicyActivation,
  authorizeAdministrativeTaskConfirmation,
  canonicalAdministrativeOutcome,
} from "@voice-agent/policy";

export interface AdministrativePlanProvider {
  /**
   * taskId is the durable planning idempotency key. A provider may receive the
   * same accepted task again after a transient failure or process restart.
   */
  choosePlan(input: {
    readonly outcome: AdministrativeTaskOutcome;
    readonly intendedState: string;
    readonly target: AdministrativeTaskTarget;
    readonly taskId: string;
  }): Promise<unknown>;
}

export interface AdministrativeOperationExecutor {
  /**
   * The adapter must use request.operationId as its idempotency key and return
   * the prior bounded result when the same Operation is recovered or retried.
   */
  execute(
    request: AdministrativeOperationRequest,
  ): Promise<AdministrativeOperationResult>;
}

export interface AdministrativeIdentifiers {
  nextCapability(): string;
  nextClaimId(): string;
  nextEventId(): string;
  nextOperationId(): string;
  nextTaskId(): string;
}

export type AdministrativePolicyActivationResult =
  | {
      readonly decision: "activated";
      readonly policy: AdministrativePolicyStatus;
    }
  | { readonly decision: "denied"; readonly reason: string };

export type AdministrativeTaskPreparationResult =
  | {
      readonly confirmationCapability: string;
      readonly decision: "prepared";
      readonly policyRevision: number;
      readonly stateVersion: number;
      readonly task: AdministrativeTask;
      readonly taskId: string;
    }
  | { readonly decision: "denied"; readonly reason: string };

export type AdministrativeTaskAdmissionResult =
  | {
      readonly decision: "admitted";
      readonly policyRevision: number;
      readonly taskId: string;
    }
  | { readonly decision: "denied"; readonly reason: string };

export interface AdministrativeAutonomyRuntime {
  applyEvidenceRetention(input: { readonly cutoff: string }): Promise<void>;
  activatePolicy(input: {
    readonly expectedActiveRevision: number | null;
    readonly expectedStateVersion: number;
    readonly source: AdministrativePolicyActivationSource;
  }): Promise<AdministrativePolicyActivationResult>;
  answerTaskConfirmation(input: {
    readonly confirmation: "ambiguous" | "confirmed" | "declined";
    readonly confirmationCapability: string;
    readonly ownerId: string;
    readonly taskId: string;
  }): Promise<AdministrativeTaskAdmissionResult>;
  close(): Promise<void>;
  getPolicyStatus(): Promise<AdministrativePolicyStatus>;
  getStatus(): Promise<AdministrativeAutonomyStatus>;
  getTask(taskId: string): Promise<AdministrativeEvidenceRecord | undefined>;
  getTaskByOperationId(
    operationId: string,
  ): Promise<AdministrativeEvidenceRecord | undefined>;
  listTasks(): ReturnType<AdministrativeAutonomyStore["listTasks"]>;
  reconcileOperations(): Promise<void>;
  prepareTaskConfirmation(input: {
    readonly intendedState: string;
    readonly outcome: AdministrativeRequestedOutcome;
    readonly ownerId: string;
    readonly requestId: string;
    readonly target: AdministrativeTaskTarget;
  }): Promise<AdministrativeTaskPreparationResult>;
}

export function createAdministrativeAutonomyRuntime(options: {
  readonly executor?: AdministrativeOperationExecutor;
  readonly identifiers: AdministrativeIdentifiers;
  readonly now: () => string;
  readonly provider?: AdministrativePlanProvider;
  readonly store: AdministrativeAutonomyStore;
}): AdministrativeAutonomyRuntime {
  const operationLeaseMilliseconds = 30_000;
  let closed = false;
  let reconciliationPromise: Promise<void> | undefined;
  let reconciliationRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAt: string | undefined;

  async function denyPlannedTask(taskId: string, reason: string) {
    const deniedAt = options.now();
    await options.store.denyTask({
      deniedAt,
      deniedEvent: {
        details: { reason },
        id: options.identifiers.nextEventId(),
        kind: "administrative.task.denied",
        occurredAt: deniedAt,
        summary: "The Administrative Task failed closed before execution.",
      },
      taskId,
    });
    return { decision: "denied" as const, reason };
  }

  function scheduleReconciliation(at: string): void {
    if (closed || (retryAt !== undefined && retryAt <= at)) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryAt = at;
    const delay = Math.max(
      0,
      new Date(at).getTime() - new Date(options.now()).getTime(),
    );
    retryTimer = setTimeout(() => {
      retryAt = undefined;
      retryTimer = undefined;
      void reconcileOperations();
    }, delay);
    retryTimer.unref?.();
  }

  async function completeAdministrativeTask(taskId: string): Promise<void> {
    const record = await options.store.findTask(taskId);
    if (record === undefined || record.task.status !== "running") return;
    const completedAt = options.now();
    await options.store.completeTask({
      completedAt,
      completedEvent: {
        details: { policyRevision: record.task.policyRevision },
        id: options.identifiers.nextEventId(),
        kind: "administrative.task.completed",
        occurredAt: completedAt,
        summary: "The confirmed administrative plan completed.",
      },
      taskId,
    });
  }

  function maintainOperationClaim(input: {
    readonly activeExecutionDeadline: string;
    readonly claimId: string;
    readonly operationId: string;
  }): () => void {
    const renewal = setInterval(() => {
      const renewedAt = options.now();
      if (renewedAt >= input.activeExecutionDeadline) return;
      void options.store
        .renewOperationClaim({
          claimId: input.claimId,
          leaseExpiresAt: boundedLeaseExpiry(
            renewedAt,
            input.activeExecutionDeadline,
            operationLeaseMilliseconds,
          ),
          operationId: input.operationId,
          renewedAt,
        })
        .catch(() => undefined);
    }, operationLeaseMilliseconds / 3);
    renewal.unref?.();
    return () => clearInterval(renewal);
  }

  async function planAdministrativeTask(
    task: AdministrativeTask,
  ): Promise<AdministrativeTaskAdmissionResult> {
    if (
      task.activeExecutionDeadline === null ||
      options.now() >= task.activeExecutionDeadline
    ) {
      return denyPlannedTask(
        task.id,
        "Administrative Task active-execution deadline elapsed",
      );
    }
    const policy = await options.store.findActivePolicy();
    if (policy === undefined || policy.revision !== task.policyRevision) {
      return denyPlannedTask(
        task.id,
        "Administrative Autonomy policy state is stale",
      );
    }
    if (options.provider === undefined || options.executor === undefined) {
      return denyPlannedTask(task.id, "Administrative execution is unavailable");
    }
    let untrustedPlan: unknown;
    try {
      untrustedPlan = await options.provider.choosePlan({
        intendedState: task.intendedState,
        outcome: task.outcome,
        target: task.target,
        taskId: task.id,
      });
    } catch {
      scheduleReconciliation(
        boundedLeaseExpiry(
          options.now(),
          task.activeExecutionDeadline,
          operationLeaseMilliseconds,
        ),
      );
      return {
        decision: "admitted",
        policyRevision: task.policyRevision,
        taskId: task.id,
      };
    }
    const parsedPlan = administrativeProviderPlanSchema.safeParse(untrustedPlan);
    if (!parsedPlan.success) {
      return denyPlannedTask(
        task.id,
        "Provider instructions did not describe a permitted typed Operation plan",
      );
    }
    const planAuthorization = authorizeAdministrativePlan({
      definition: policy.definition,
      outcome: task.outcome,
      plan: parsedPlan.data,
    });
    if (planAuthorization.decision === "deny") {
      return denyPlannedTask(task.id, planAuthorization.reason);
    }
    const plannedAt = options.now();
    const operations = parsedPlan.data.map((operation) => {
      const request = operationRequest({
        kind: operation.kind,
        operationId: options.identifiers.nextOperationId(),
        plannedAt,
        policyRevision: policy.revision,
        policyStateVersion: task.policyStateVersion,
        target: task.target,
        taskId: task.id,
      });
      return {
        acceptedEvent: {
          details: {
            kind: request.kind,
            operationId: request.operationId,
            policyRevision: request.policyRevision,
            stateVersion: request.policyStateVersion,
          },
          id: options.identifiers.nextEventId(),
          kind: "administrative.operation.accepted" as const,
          occurredAt: plannedAt,
          summary: `The ${request.kind} Operation was accepted by policy.`,
        },
        request,
      };
    });
    const savedPlan = await options.store.savePlan({
      operations,
      planEvent: {
        details: {
          operations: parsedPlan.data.map((operation) => operation.kind),
          policyRevision: policy.revision,
          stateVersion: task.policyStateVersion,
        },
        id: options.identifiers.nextEventId(),
        kind: "administrative.plan.accepted",
        occurredAt: plannedAt,
        summary: "The confirmed outcome admitted a bounded Operation plan.",
      },
      taskId: task.id,
    });
    if (savedPlan === undefined) {
      return denyPlannedTask(
        task.id,
        "Administrative Autonomy policy state is stale",
      );
    }
    return {
      decision: "admitted",
      policyRevision: task.policyRevision,
      taskId: task.id,
    };
  }

  async function reconcileTask(taskId: string): Promise<boolean> {
    if (options.executor === undefined) return false;
    const record = await options.store.findTask(taskId);
    if (record?.task.status === "planning") {
      const admission = await planAdministrativeTask(record.task);
      if (admission.decision === "denied") return true;
      return (await options.store.findTask(taskId))?.task.status !== "planning";
    }
    const claimedAt = options.now();
    const activeExecutionDeadline = record?.task.activeExecutionDeadline;
    const claim = await options.store.claimNextOperation({
      claimId: options.identifiers.nextClaimId(),
      claimedAt,
      leaseExpiresAt:
        activeExecutionDeadline === null || activeExecutionDeadline === undefined
          ? claimedAt
          : boundedLeaseExpiry(
              claimedAt,
              activeExecutionDeadline,
              operationLeaseMilliseconds,
            ),
      taskId,
    });
    if (claim.decision === "deferred") {
      scheduleReconciliation(claim.retryAt);
      return false;
    }
    if (claim.decision === "denied") {
      await denyPlannedTask(
        taskId,
        claim.reason === "stale-policy"
          ? "Administrative Autonomy policy state is stale"
          : claim.reason === "active-execution-deadline"
            ? "Administrative Task active-execution deadline elapsed"
            : "Live Patch rollback deadline elapsed before mutation",
      );
      return true;
    }
    if (claim.decision === "empty") {
      await completeAdministrativeTask(taskId);
      return true;
    }
    const stopMaintainingClaim = maintainOperationClaim({
      activeExecutionDeadline: claim.activeExecutionDeadline,
      claimId: claim.claimId,
      operationId: claim.request.operationId,
    });
    try {
      let untrustedResult: unknown;
      try {
        untrustedResult = await options.executor.execute(claim.request);
      } catch {
        scheduleReconciliation(
          boundedLeaseExpiry(
            claimedAt,
            claim.activeExecutionDeadline,
            operationLeaseMilliseconds,
          ),
        );
        return false;
      }
      let result: AdministrativeOperationResult;
      try {
        result = operationResult(claim.request, untrustedResult);
      } catch {
        await denyPlannedTask(
          taskId,
          "Administrative executor returned incomplete or mismatched bounded proof",
        );
        return true;
      }
      try {
        await options.store.completeOperation({
          claimId: claim.claimId,
          completedEvent: {
            details: {
              kind: claim.request.kind,
              operationId: claim.request.operationId,
              result,
            },
            id: options.identifiers.nextEventId(),
            kind: "administrative.operation.completed",
            occurredAt: result.completedAt,
            summary: `The ${claim.request.kind} Operation completed.`,
          },
          operationId: claim.request.operationId,
          result,
          taskId,
        });
        return true;
      } catch {
        scheduleReconciliation(
          boundedLeaseExpiry(
            claimedAt,
            claim.activeExecutionDeadline,
            operationLeaseMilliseconds,
          ),
        );
        return false;
      }
    } finally {
      stopMaintainingClaim();
    }
  }

  async function reconcileOperations(): Promise<void> {
    if (closed || options.executor === undefined) return;
    reconciliationRequested = true;
    if (reconciliationPromise !== undefined) return reconciliationPromise;
    reconciliationPromise = (async () => {
      let progressed: boolean;
      do {
        reconciliationRequested = false;
        const taskIds = await options.store.listRecoverableTaskIds();
        const results = await Promise.all(
          taskIds.map((taskId) => reconcileTask(taskId)),
        );
        progressed = results.some(Boolean);
      } while (reconciliationRequested || progressed);
    })();
    try {
      await reconciliationPromise;
    } finally {
      reconciliationPromise = undefined;
    }
    if (reconciliationRequested) await reconcileOperations();
  }

  return {
    applyEvidenceRetention: (input) => options.store.applyEvidenceRetention(input),
    async activatePolicy(input) {
      const current = await options.store.readPolicyStatus();
      const authorization = authorizeAdministrativePolicyActivation({
        current,
        expectedActiveRevision: input.expectedActiveRevision,
        expectedStateVersion: input.expectedStateVersion,
        source: input.source,
      });
      if (authorization.decision === "deny") {
        return { decision: "denied", reason: authorization.reason };
      }
      const revision =
        current.status === "inactive" ? 1 : current.revision + 1;
      const activatedAt = options.now();
      const activated = await options.store.activatePolicy({
        expectedActiveRevision: input.expectedActiveRevision,
        expectedStateVersion: input.expectedStateVersion,
        revision: {
          activatedAt,
          activatedBy: "fresh-passkey-action",
          definition: administrativeAutonomyPolicyDefinition,
          revision,
        },
        stateVersion: current.stateVersion + 1,
      });
      return activated === undefined
        ? {
            decision: "denied",
            reason: "Administrative Autonomy policy state is stale",
          }
        : { decision: "activated", policy: activated };
    },
    async answerTaskConfirmation(input) {
      if (input.confirmation === "declined") {
        const declinedAt = options.now();
        const declined = await options.store.declineConfirmation({
          capabilityHash: hashCapability(input.confirmationCapability),
          declinedAt,
          declinedEvent: {
            details: { reason: "Task Confirmation was declined" },
            id: options.identifiers.nextEventId(),
            kind: "administrative.confirmation.declined",
            occurredAt: declinedAt,
            summary: "The owner declined the intended administrative state.",
          },
          ownerId: input.ownerId,
          taskId: input.taskId,
        });
        return declined.decision === "denied"
          ? { decision: "denied", reason: describeClaimDenial(declined.reason) }
          : { decision: "denied", reason: "Task Confirmation was declined" };
      }
      const confirmation = authorizeAdministrativeTaskConfirmation({
        confirmation: input.confirmation,
      });
      if (confirmation.decision === "deny") {
        return { decision: "denied", reason: confirmation.reason };
      }
      const acceptedAt = options.now();
      const activeExecutionDeadline = new Date(
        new Date(acceptedAt).getTime() +
          administrativeActiveExecutionMilliseconds,
      ).toISOString();
      const claim = await options.store.claimConfirmation({
        acceptedAt,
        acceptedEvent: {
          details: {
            activeExecutionDeadline,
            policyRevision:
              (await options.store.findTask(input.taskId))?.task
                .policyRevision ?? 1,
          },
          id: options.identifiers.nextEventId(),
          kind: "administrative.confirmation.accepted",
          occurredAt: acceptedAt,
          summary: "The owner confirmed the Administrative Task outcome.",
        },
        capabilityHash: hashCapability(input.confirmationCapability),
        ownerId: input.ownerId,
        taskId: input.taskId,
      });
      if (claim.decision === "denied") {
        return { decision: "denied", reason: describeClaimDenial(claim.reason) };
      }
      const task = claim.record.task;
      const admission = await planAdministrativeTask(task);
      if (admission.decision === "denied") return admission;
      if ((await options.store.findTask(task.id))?.task.status === "planning") {
        return admission;
      }
      await reconcileOperations();
      const reconciled = await options.store.findTask(task.id);
      if (reconciled?.task.status === "denied") {
        return {
          decision: "denied",
          reason: reconciled.task.conclusion,
        };
      }
      return {
        decision: "admitted",
        policyRevision: task.policyRevision,
        taskId: task.id,
      };
    },
    async close() {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      await options.store.close();
    },
    getPolicyStatus: () => options.store.readPolicyStatus(),
    async getStatus() {
      return {
        policy: await options.store.readPolicyStatus(),
        taskExecution:
          options.provider !== undefined && options.executor !== undefined
            ? { status: "adapters-configured" }
            : {
                reason:
                  "Typed administrative task execution adapters are not configured.",
                status: "unavailable",
              },
      };
    },
    getTask: (taskId) => options.store.findTask(taskId),
    getTaskByOperationId: (operationId) =>
      options.store.findTaskByOperationId(operationId),
    listTasks: () => options.store.listTasks(),
    reconcileOperations,
    async prepareTaskConfirmation(input) {
      if (options.provider === undefined || options.executor === undefined) {
        return {
          decision: "denied",
          reason:
            "Typed administrative task execution adapters are not configured.",
        };
      }
      const requestedOutcome = administrativeRequestedOutcomeSchema.parse(
        input.outcome,
      );
      const outcome = canonicalAdministrativeOutcome(requestedOutcome);
      const intendedState = administrativeIntendedStateSchema.parse(
        input.intendedState,
      );
      const target = administrativeTaskTargetSchema.parse(input.target);
      const policy = await options.store.readPolicyStatus();
      if (policy.status !== "active") {
        return {
          decision: "denied",
          reason: "Administrative Autonomy is not active",
        };
      }
      const taskId = options.identifiers.nextTaskId();
      const confirmationCapability = options.identifiers.nextCapability();
      const preparedAt = options.now();
      const saved = await options.store.savePreparedTask({
        capabilityHash: hashCapability(confirmationCapability),
        event: {
          details: {
            intendedState,
            outcome,
            policyRevision: policy.revision,
            requestId: input.requestId,
            stateVersion: policy.stateVersion,
          },
          id: options.identifiers.nextEventId(),
          kind: "administrative.confirmation.prepared",
          occurredAt: preparedAt,
          summary: "A Task Confirmation was prepared for administrative work.",
        },
        ownerId: input.ownerId,
        requestId: input.requestId,
        stateVersion: policy.stateVersion,
        task: {
          activeExecutionDeadline: null,
          conclusion: "Administrative Task confirmation is pending.",
          createdAt: preparedAt,
          id: taskId,
          intendedState,
          kind: "administrative.work",
          outcome,
          policyRevision: policy.revision,
          policyStateVersion: policy.stateVersion,
          question: confirmationQuestion(intendedState, outcome, target),
          status: "awaiting-confirmation",
          target,
          updatedAt: preparedAt,
        },
      });
      return saved === undefined
        ? {
            decision: "denied",
            reason: "Administrative confirmation is stale or replayed",
          }
        : {
            confirmationCapability,
            decision: "prepared",
            policyRevision: policy.revision,
            stateVersion: policy.stateVersion,
            task: saved.task,
            taskId,
          };
    },
  };
}

function hashCapability(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

function boundedLeaseExpiry(
  claimedAt: string,
  activeExecutionDeadline: string,
  leaseMilliseconds: number,
): string {
  const requested = new Date(claimedAt).getTime() + leaseMilliseconds;
  return new Date(
    Math.min(requested, new Date(activeExecutionDeadline).getTime()),
  ).toISOString();
}

function confirmationQuestion(
  intendedState: string,
  outcome: AdministrativeTaskOutcome,
  target: AdministrativeTaskTarget,
): string {
  const subject = `${target.registeredCodebaseId} in ${target.environment}`;
  if (outcome === "investigation") {
    return `Confirm observing ${subject} to establish this intended state: ${intendedState}`;
  }
  if (outcome === "proposal") {
    return `Confirm branch-only work for ${subject} toward this intended state: ${intendedState}`;
  }
  return `Confirm changing ${subject} to this intended state: ${intendedState}`;
}

function operationRequest(input: {
  readonly kind: AdministrativeOperationRequest["kind"];
  readonly operationId: string;
  readonly plannedAt: string;
  readonly policyRevision: number;
  readonly policyStateVersion: number;
  readonly target: AdministrativeTaskTarget;
  readonly taskId: string;
}): AdministrativeOperationRequest {
  const common = {
    operationId: input.operationId,
    policyRevision: input.policyRevision,
    policyStateVersion: input.policyStateVersion,
    target: input.target,
    taskId: input.taskId,
  };
  if (input.kind !== "live-patch.apply") {
    return administrativeOperationRequestSchema.parse({
      ...common,
      kind: input.kind,
    });
  }
  return administrativeOperationRequestSchema.parse({
    ...common,
    kind: input.kind,
    mutationBoundary: {
      healthCheck: {
        kind: "registered-application-health",
        requiredBeforeMutation: true,
      },
      independentRollback: {
        armedBeforeMutation: true,
        kind: "independent-live-patch-rollback",
        rollbackDeadline: new Date(
          new Date(input.plannedAt).getTime() + 30 * 60 * 1_000,
        ).toISOString(),
      },
      verification: {
        kind: "independent-application-health-proof",
        requiredAfterMutation: true,
      },
    },
  });
}

function operationResult(
  request: AdministrativeOperationRequest,
  untrustedResult: unknown,
): AdministrativeOperationResult {
  const result = administrativeOperationResultSchema.parse(untrustedResult);
  if (result.kind !== request.kind || result.operationId !== request.operationId) {
    throw new Error(
      "Administrative Operation result identity does not match its request",
    );
  }
  if (
    request.kind === "live-patch.apply" &&
    result.kind === "live-patch.apply" &&
    result.mutationProof.independentRollback.rollbackDeadline !==
      request.mutationBoundary.independentRollback.rollbackDeadline
  ) {
    throw new Error("Live Patch rollback proof does not match its request");
  }
  if (request.kind === "live-patch.apply" && result.kind === "live-patch.apply") {
    const proof = result.mutationProof;
    if (
      proof.healthCheck.observedAt > proof.independentRollback.armedAt ||
      proof.independentRollback.armedAt > proof.verification.observedAt ||
      proof.verification.observedAt > result.completedAt ||
      result.completedAt > proof.independentRollback.rollbackDeadline
    ) {
      throw new Error("Live Patch safety proof is not in a valid time order");
    }
  }
  return result;
}

function describeClaimDenial(
  reason:
    | "confirmation-replayed"
    | "identity-mismatch"
    | "invalid-capability"
    | "stale-policy"
    | "task-unavailable",
): string {
  switch (reason) {
    case "confirmation-replayed":
      return "Task Confirmation capability was already used";
    case "identity-mismatch":
      return "Task Confirmation belongs to another owner identity";
    case "invalid-capability":
      return "Task Confirmation capability is invalid";
    case "stale-policy":
      return "Administrative Autonomy policy state is stale";
    case "task-unavailable":
      return "Administrative Task is unavailable";
  }
}
