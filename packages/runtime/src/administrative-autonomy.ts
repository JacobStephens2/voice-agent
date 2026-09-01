import { createHash } from "node:crypto";

import {
  administrativeOperationResultSchema,
  administrativeProviderPlanSchema,
  administrativeTaskOutcomeSchema,
  administrativeTaskTargetSchema,
  type AdministrativeEvidenceRecord,
  type AdministrativeOperationRequest,
  type AdministrativeOperationResult,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativeTaskOutcome,
  type AdministrativeTaskTarget,
} from "@voice-agent/contracts";
import type { AdministrativeAutonomyStore } from "@voice-agent/durable-store";
import {
  administrativeAutonomyPolicyDefinition,
  authorizeAdministrativePlan,
  authorizeAdministrativePolicyActivation,
  authorizeAdministrativeTaskConfirmation,
} from "@voice-agent/policy";

export interface AdministrativePlanProvider {
  choosePlan(input: {
    readonly outcome: AdministrativeTaskOutcome;
    readonly target: AdministrativeTaskTarget;
    readonly taskId: string;
  }): Promise<unknown>;
}

export interface AdministrativeOperationExecutor {
  execute(
    request: AdministrativeOperationRequest,
  ): Promise<AdministrativeOperationResult>;
}

export interface AdministrativeIdentifiers {
  nextCapability(): string;
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
  activatePolicy(input: {
    readonly expectedActiveRevision: number | null;
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
  getTask(taskId: string): Promise<AdministrativeEvidenceRecord | undefined>;
  listTasks(): ReturnType<AdministrativeAutonomyStore["listTasks"]>;
  prepareTaskConfirmation(input: {
    readonly outcome: AdministrativeTaskOutcome;
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

  return {
    async activatePolicy(input) {
      const current = await options.store.readPolicyStatus();
      const authorization = authorizeAdministrativePolicyActivation({
        current,
        expectedActiveRevision: input.expectedActiveRevision,
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
      const confirmation = authorizeAdministrativeTaskConfirmation({
        confirmation: input.confirmation,
      });
      if (confirmation.decision === "deny") {
        return { decision: "denied", reason: confirmation.reason };
      }
      const acceptedAt = options.now();
      const claim = await options.store.claimConfirmation({
        acceptedAt,
        acceptedEvent: {
          details: {
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
      const policy = await options.store.findActivePolicy();
      if (policy === undefined || policy.revision !== task.policyRevision) {
        return denyPlannedTask(
          task.id,
          "Administrative Autonomy policy state is stale",
        );
      }
      if (options.provider === undefined || options.executor === undefined) {
        return denyPlannedTask(
          task.id,
          "Administrative execution is unavailable",
        );
      }
      const untrustedPlan = await options.provider.choosePlan({
        outcome: task.outcome,
        target: task.target,
        taskId: task.id,
      });
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
        const request: AdministrativeOperationRequest = {
          kind: operation.kind,
          operationId: options.identifiers.nextOperationId(),
          policyRevision: policy.revision,
          policyStateVersion: task.policyStateVersion,
          target: task.target,
          taskId: task.id,
        };
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
      for (const operation of operations) {
        const result = administrativeOperationResultSchema.parse(
          await options.executor.execute(operation.request),
        );
        await options.store.completeOperation({
          completedEvent: {
            details: {
              kind: operation.request.kind,
              operationId: operation.request.operationId,
              summary: result.summary,
            },
            id: options.identifiers.nextEventId(),
            kind: "administrative.operation.completed",
            occurredAt: result.completedAt,
            summary: `The ${operation.request.kind} Operation completed.`,
          },
          operationId: operation.request.operationId,
          result,
          taskId: task.id,
        });
      }
      const completedAt = options.now();
      await options.store.completeTask({
        completedAt,
        completedEvent: {
          details: { policyRevision: policy.revision },
          id: options.identifiers.nextEventId(),
          kind: "administrative.task.completed",
          occurredAt: completedAt,
          summary: "The confirmed administrative plan completed.",
        },
        taskId: task.id,
      });
      return {
        decision: "admitted",
        policyRevision: policy.revision,
        taskId: task.id,
      };
    },
    close: () => options.store.close(),
    getPolicyStatus: () => options.store.readPolicyStatus(),
    getTask: (taskId) => options.store.findTask(taskId),
    listTasks: () => options.store.listTasks(),
    async prepareTaskConfirmation(input) {
      const outcome = administrativeTaskOutcomeSchema.parse(input.outcome);
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
          conclusion: "Administrative Task confirmation is pending.",
          createdAt: preparedAt,
          id: taskId,
          kind: "administrative.work",
          outcome,
          policyRevision: policy.revision,
          policyStateVersion: policy.stateVersion,
          question: confirmationQuestion(outcome, target),
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
            taskId,
          };
    },
  };
}

function hashCapability(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

function confirmationQuestion(
  outcome: AdministrativeTaskOutcome,
  target: AdministrativeTaskTarget,
): string {
  const subject = `${target.registeredCodebaseId} in ${target.environment}`;
  if (outcome === "open-pull-request") {
    return `Open a pull request for ${subject}.`;
  }
  if (outcome === "propose") return `Propose a change to ${subject}.`;
  if (outcome === "investigate") return `Investigate ${subject}.`;
  return `${outcome[0]?.toUpperCase()}${outcome.slice(1)} ${subject}.`;
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
