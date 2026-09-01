import { createHash } from "node:crypto";

import {
  administrativeActiveExecutionMilliseconds,
  administrativeExecutionManifestFingerprint,
  administrativeExecutionManifestSchema,
  administrativeOperationRequestSchema,
  administrativeOperationResultSchema,
  administrativeProviderPlanSchema,
  administrativeIntendedStateSchema,
  administrativeRequestedOutcomeSchema,
  administrativeTaskTargetSchema,
  livePatchRollbackWindowMilliseconds,
  sameAdministrativeExecutionManifest,
  type AdministrativeEvidenceRecord,
  type AdministrativeAutonomyStatus,
  type AdministrativeExecutionManifest,
  type AdministrativeOperationRequest,
  type AdministrativeOperationResult,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativePublicationIntent,
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
  canonicalAdministrativeIntent,
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
   * The adapter must use request.operationId as its idempotency key, carry the
   * claim ID and deadline into its typed broker fence, and stop and settle
   * before performing any further effect when signal aborts. The real broker
   * adapter remains downstream; production exposes no executor until one can
   * honor this contract.
   */
  execute(
    execution: AdministrativeOperationExecution,
  ): Promise<AdministrativeOperationResult>;
}

export interface AdministrativeOperationExecution {
  readonly fence: {
    readonly activeExecutionDeadline: string;
    readonly attemptStartedAt: string;
    readonly claimId: string;
    readonly initialExecutionStartedAt: string;
    readonly recovered: boolean;
    readonly signal: AbortSignal;
  };
  readonly request: AdministrativeOperationRequest;
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

export type AdministrativePolicySuspensionResult =
  | {
      readonly decision: "suspended";
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
    readonly expectedExecutionManifestFingerprint: string;
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
  suspendPolicy(input: {
    readonly expectedRevision: number;
    readonly expectedStateVersion: number;
  }): Promise<AdministrativePolicySuspensionResult>;
}

export function createAdministrativeAutonomyRuntime(options: {
  readonly executionManifest: AdministrativeExecutionManifest;
  readonly executor?: AdministrativeOperationExecutor;
  readonly identifiers: AdministrativeIdentifiers;
  readonly now: () => string;
  readonly operationLeaseMilliseconds?: number;
  readonly provider?: AdministrativePlanProvider;
  readonly store: AdministrativeAutonomyStore;
}): AdministrativeAutonomyRuntime {
  const executionManifest = administrativeExecutionManifestSchema.parse(
    options.executionManifest,
  );
  const adaptersConfigured =
    options.provider !== undefined && options.executor !== undefined;
  if ((options.provider === undefined) !== (options.executor === undefined)) {
    throw new Error(
      "Administrative planning and execution adapters must be configured together",
    );
  }
  if (
    adaptersConfigured ===
    (executionManifest.provider.kind === "unavailable")
  ) {
    throw new Error(
      "Administrative execution adapters do not match their capability manifest",
    );
  }
  const requestedOperationLeaseMilliseconds =
    options.operationLeaseMilliseconds ?? 30_000;
  if (
    !Number.isSafeInteger(requestedOperationLeaseMilliseconds) ||
    requestedOperationLeaseMilliseconds <= 0
  ) {
    throw new Error("Administrative Operation lease duration is invalid");
  }
  const operationLeaseMilliseconds = Math.min(
    requestedOperationLeaseMilliseconds,
    administrativeActiveExecutionMilliseconds,
  );
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
  }): {
    readonly lossReason: () => string | undefined;
    readonly signal: AbortSignal;
    readonly stop: () => void;
  } {
    const controller = new AbortController();
    let reason: string | undefined;
    let renewalInFlight = false;
    const abort = (lossReason: string) => {
      if (controller.signal.aborted) return;
      reason = lossReason;
      controller.abort(new Error(lossReason));
    };
    const deadlineDelay = Math.max(
      0,
      new Date(input.activeExecutionDeadline).getTime() -
        new Date(options.now()).getTime(),
    );
    const deadline = setTimeout(() => {
      abort("Administrative Task active-execution deadline elapsed");
    }, deadlineDelay);
    deadline.unref?.();
    const renewal = setInterval(() => {
      if (renewalInFlight || controller.signal.aborted) return;
      renewalInFlight = true;
      const renewedAt = options.now();
      if (renewedAt >= input.activeExecutionDeadline) {
        abort("Administrative Task active-execution deadline elapsed");
        renewalInFlight = false;
        return;
      }
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
        .then((renewed) => {
          if (!renewed) abort("Administrative Operation claim was lost");
        })
        .catch(() => {
          abort("Administrative Operation claim was lost");
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, operationLeaseMilliseconds / 3);
    renewal.unref?.();
    return {
      lossReason: () => reason,
      signal: controller.signal,
      stop() {
        clearTimeout(deadline);
        clearInterval(renewal);
      },
    };
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
    if (
      !sameAdministrativeExecutionManifest(
        policy.executionManifest,
        task.executionManifest,
      ) ||
      !sameAdministrativeExecutionManifest(
        policy.executionManifest,
        executionManifest,
      )
    ) {
      return denyPlannedTask(
        task.id,
        "The active policy revision does not authorize the configured execution manifest.",
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
    const unavailableKind = parsedPlan.data.find(
      (operation) =>
        !executionManifest.operationAdapters.some(
          (adapter) => adapter.kind === operation.kind,
        ),
    );
    if (unavailableKind !== undefined) {
      return denyPlannedTask(
        task.id,
        `${unavailableKind.kind} is not present in the activated execution manifest`,
      );
    }
    const plannedAt = options.now();
    const operations = parsedPlan.data.map((operation) => {
      const request = operationRequest({
        executionManifest,
        intendedState: task.intendedState,
        kind: operation.kind,
        operationId: options.identifiers.nextOperationId(),
        policyRevision: policy.revision,
        policyStateVersion: task.policyStateVersion,
        publicationIntent: task.publicationIntent,
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
      executionManifest,
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
          : claim.reason === "execution-manifest"
            ? "The active policy revision does not authorize the configured execution manifest."
            : "Administrative Task active-execution deadline elapsed",
      );
      return true;
    }
    if (claim.decision === "empty") {
      await completeAdministrativeTask(taskId);
      return true;
    }
    if (
      !sameAdministrativeExecutionManifest(
        claim.request.executionManifest,
        executionManifest,
      )
    ) {
      await denyPlannedTask(
        taskId,
        "The active policy revision does not authorize the configured execution manifest.",
      );
      return true;
    }
    const claimMaintenance = maintainOperationClaim({
      activeExecutionDeadline: claim.activeExecutionDeadline,
      claimId: claim.claimId,
      operationId: claim.request.operationId,
    });
    try {
      let untrustedResult: unknown;
      const attemptStartedAt = options.now();
      try {
        untrustedResult = await options.executor.execute({
          fence: {
            activeExecutionDeadline: claim.activeExecutionDeadline,
            attemptStartedAt,
            claimId: claim.claimId,
            initialExecutionStartedAt: claim.initialExecutionStartedAt,
            recovered: claim.recovered,
            signal: claimMaintenance.signal,
          },
          request: claim.request,
        });
      } catch {
        const lossReason = claimMaintenance.lossReason();
        if (lossReason !== undefined) {
          await denyPlannedTask(taskId, lossReason);
          return true;
        }
        if (options.now() >= claim.activeExecutionDeadline) {
          await denyPlannedTask(
            taskId,
            "Administrative Task active-execution deadline elapsed",
          );
          return true;
        }
        scheduleReconciliation(
          boundedLeaseExpiry(
            claimedAt,
            claim.activeExecutionDeadline,
            operationLeaseMilliseconds,
          ),
        );
        return false;
      }
      const lossReason = claimMaintenance.lossReason();
      if (lossReason !== undefined) {
        await denyPlannedTask(taskId, lossReason);
        return true;
      }
      const completedAt = options.now();
      if (completedAt >= claim.activeExecutionDeadline) {
        await denyPlannedTask(
          taskId,
          "Administrative Task active-execution deadline elapsed",
        );
        return true;
      }
      let result: AdministrativeOperationResult;
      try {
        result = operationResult(
          claim.request,
          untrustedResult,
          {
            attemptStartedAt,
            initialExecutionStartedAt: claim.initialExecutionStartedAt,
            recovered: claim.recovered,
          },
          completedAt,
        );
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
      claimMaintenance.stop();
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
        expectedExecutionManifestFingerprint:
          input.expectedExecutionManifestFingerprint,
        expectedStateVersion: input.expectedStateVersion,
        runtimeExecutionManifestFingerprint:
          administrativeExecutionManifestFingerprint(executionManifest),
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
        expectedExecutionManifestFingerprint:
          input.expectedExecutionManifestFingerprint,
        expectedStateVersion: input.expectedStateVersion,
        revision: {
          activatedAt,
          activatedBy: "fresh-passkey-action",
          definition: administrativeAutonomyPolicyDefinition,
          executionManifest,
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
      const policy = await options.store.readPolicyStatus();
      const manifestMismatch =
        policy.status !== "inactive" &&
        !sameAdministrativeExecutionManifest(
          policy.executionManifest,
          executionManifest,
        );
      return {
        policy,
        taskExecution: manifestMismatch
          ? {
              activeExecutionManifest: policy.executionManifest,
              reason:
                "The active policy revision does not authorize the configured execution manifest.",
              runtimeExecutionManifest: executionManifest,
              status: "activation-required",
            }
          : adaptersConfigured
            ? { executionManifest, status: "adapters-configured" }
            : {
                executionManifest,
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
      const { outcome, publicationIntent } =
        canonicalAdministrativeIntent(requestedOutcome);
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
      if (
        !sameAdministrativeExecutionManifest(
          policy.executionManifest,
          executionManifest,
        )
      ) {
        return {
          decision: "denied",
          reason:
            "The active policy revision does not authorize the configured execution manifest.",
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
            publicationIntent,
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
          executionManifest,
          policyRevision: policy.revision,
          policyStateVersion: policy.stateVersion,
          publicationIntent,
          question: confirmationQuestion(
            intendedState,
            outcome,
            publicationIntent,
            target,
          ),
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
    async suspendPolicy(input) {
      const suspended = await options.store.suspendPolicy({
        expectedRevision: input.expectedRevision,
        expectedStateVersion: input.expectedStateVersion,
        suspendedAt: options.now(),
      });
      return suspended === undefined
        ? {
            decision: "denied",
            reason: "Administrative Autonomy policy state is stale",
          }
        : { decision: "suspended", policy: suspended };
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
  publicationIntent: AdministrativePublicationIntent,
  target: AdministrativeTaskTarget,
): string {
  const subject = `${target.registeredCodebaseId} in ${target.environment}`;
  if (outcome === "investigation") {
    return `Confirm observing ${subject} to establish this intended state: ${intendedState}`;
  }
  if (outcome === "proposal") {
    return publicationIntent === "open-pull-request"
      ? `Confirm isolated branch work and opening a pull request for ${subject} toward this intended state: ${intendedState}`
      : `Confirm branch-only work for ${subject} toward this intended state: ${intendedState}`;
  }
  return `Confirm changing ${subject} to this intended state: ${intendedState}`;
}

function operationRequest(input: {
  readonly executionManifest: AdministrativeExecutionManifest;
  readonly intendedState: string;
  readonly kind: AdministrativeOperationRequest["kind"];
  readonly operationId: string;
  readonly policyRevision: number;
  readonly policyStateVersion: number;
  readonly publicationIntent: AdministrativePublicationIntent;
  readonly target: AdministrativeTaskTarget;
  readonly taskId: string;
}): AdministrativeOperationRequest {
  const common = {
    executionManifest: input.executionManifest,
    operationId: input.operationId,
    policyRevision: input.policyRevision,
    policyStateVersion: input.policyStateVersion,
    target: input.target,
    taskId: input.taskId,
  };
  const intendedState = {
    intendedState: input.intendedState,
    kind: "achieve-confirmed-intended-state" as const,
    targetSource: "confirmed-durable-task" as const,
  };
  if (input.kind === "production.observe") {
    return administrativeOperationRequestSchema.parse({
      ...common,
      kind: input.kind,
      observation: {
        intendedState: input.intendedState,
        kind: "registered-application-health",
        targetSource: "confirmed-durable-task",
      },
    });
  }
  if (input.kind === "delegated-worktree.change") {
    return administrativeOperationRequestSchema.parse({
      ...common,
      change: intendedState,
      kind: input.kind,
      publication:
        input.publicationIntent === "open-pull-request"
          ? {
              baseBranch: "registered-production-branch",
              kind: "open-pull-request",
              productionMutation: false,
            }
          : { kind: "branch-only", productionMutation: false },
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
        rollbackWindowMilliseconds: livePatchRollbackWindowMilliseconds,
      },
      reconciliation: {
        acceptedOutcomes: [
          "captured-as-isolated-pull-request",
          "removed-from-production",
        ],
        kind: "live-patch-reconciliation",
        requiredBeforeTaskCompletion: true,
      },
      verification: {
        kind: "independent-application-health-proof",
        requiredAfterMutation: true,
      },
    },
    patch: intendedState,
  });
}

function operationResult(
  request: AdministrativeOperationRequest,
  untrustedResult: unknown,
  execution: {
    readonly attemptStartedAt: string;
    readonly initialExecutionStartedAt: string;
    readonly recovered: boolean;
  },
  completedAt: string,
): AdministrativeOperationResult {
  const untrusted = administrativeOperationResultSchema.parse(untrustedResult);
  const result = administrativeOperationResultSchema.parse({
    ...untrusted,
    completedAt,
  });
  if (result.kind !== request.kind || result.operationId !== request.operationId) {
    throw new Error(
      "Administrative Operation result identity does not match its request",
    );
  }
  const attemptStarted = new Date(execution.attemptStartedAt).getTime();
  const initialExecutionStarted = new Date(
    execution.initialExecutionStartedAt,
  ).getTime();
  const completed = new Date(result.completedAt).getTime();
  const effectStarted =
    result.effect.kind === "effect-performed"
      ? new Date(result.effect.startedAt).getTime()
      : new Date(result.effect.originallyStartedAt).getTime();
  if (
    effectStarted < initialExecutionStarted ||
    effectStarted > completed ||
    (result.effect.kind === "effect-performed" &&
      effectStarted < attemptStarted) ||
    (result.effect.kind === "idempotent-effect-replay" &&
      (!execution.recovered ||
        effectStarted > attemptStarted ||
        new Date(result.effect.replayedAt).getTime() < attemptStarted ||
        new Date(result.effect.replayedAt).getTime() > completed))
  ) {
    throw new Error("Administrative idempotency proof is not valid");
  }
  if (
    request.kind === "delegated-worktree.change" &&
    result.kind === request.kind
  ) {
    const matchingPublication =
      (request.publication.kind === "branch-only" &&
        result.publication.kind === "isolated-branch-prepared") ||
      (request.publication.kind === "open-pull-request" &&
        result.publication.kind === "isolated-pull-request-opened" &&
        result.publication.registeredCodebaseId ===
          request.target.registeredCodebaseId);
    if (!matchingPublication) {
      throw new Error(
        "Administrative publication proof does not match its request",
      );
    }
  }
  if (request.kind === "live-patch.apply" && result.kind === "live-patch.apply") {
    const proof = result.mutationProof;
    const healthObserved = new Date(proof.healthCheck.observedAt).getTime();
    const rollbackArmed = new Date(proof.independentRollback.armedAt).getTime();
    const rollbackDeadline = new Date(
      proof.independentRollback.rollbackDeadline,
    ).getTime();
    const mutationStarted = new Date(proof.mutationStartedAt).getTime();
    const verificationObserved = new Date(
      proof.verification.observedAt,
    ).getTime();
    const reconciliationObserved = new Date(
      proof.reconciliation.observedAt,
    ).getTime();
    if (
      healthObserved < initialExecutionStarted ||
      healthObserved > rollbackArmed ||
      rollbackDeadline - rollbackArmed !==
        request.mutationBoundary.independentRollback.rollbackWindowMilliseconds ||
      rollbackArmed > mutationStarted ||
      rollbackDeadline - mutationStarted !==
        request.mutationBoundary.independentRollback.rollbackWindowMilliseconds ||
      mutationStarted !== effectStarted ||
      mutationStarted >= rollbackDeadline ||
      mutationStarted > verificationObserved ||
      verificationObserved > reconciliationObserved ||
      reconciliationObserved > completed ||
      completed >= rollbackDeadline ||
      proof.reconciliation.registeredCodebaseId !==
        request.target.registeredCodebaseId
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
