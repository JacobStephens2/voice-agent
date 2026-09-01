import {
  type AdministrativeEvidenceRecord,
  type AdministrativeOperationRequest,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativeProviderPlan,
  type AdministrativeRequestedOutcome,
  type AdministrativeTaskTarget,
} from "@voice-agent/contracts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import {
  createAdministrativeAutonomyRuntime,
  type AdministrativeTaskAdmissionResult,
} from "@voice-agent/runtime";
import { createSqliteAdministrativeAutonomyStore } from "@voice-agent/sqlite-store";

const scenarioOrigin = "https://voice.stephens.page";
const scenarioSession = "scenario-trusted-session";
const scenarioCsrf = "scenario-csrf-token-0001";

export interface AdministrativeAutonomyScenario {
  readonly executedOperations: AdministrativeOperationRequest[];
  readonly operationAttempts: AdministrativeOperationRequest[];
  activatePolicy(input: {
    readonly expectedActiveRevision: number | null;
    readonly freshPasskey: boolean;
  }): Promise<{ readonly body: unknown; readonly statusCode: number }>;
  attemptPolicyActivation(input: {
    readonly expectedActiveRevision: number | null;
    readonly source: AdministrativePolicyActivationSource;
  }): ReturnType<
    ReturnType<typeof createAdministrativeAutonomyRuntime>["activatePolicy"]
  >;
  close(): Promise<void>;
  confirmAndRunTask(input: {
    readonly confirmation: "ambiguous" | "confirmed" | "declined";
    readonly intendedState: string;
    readonly outcome: AdministrativeRequestedOutcome;
    readonly ownerId: string;
    readonly requestId: string;
    readonly target: AdministrativeTaskTarget;
  }): Promise<AdministrativeTaskAdmissionResult>;
  interleavePolicyRevisionBeforePlanAdmission(): void;
  interleavePolicyRevisionAfterFirstOperation(): void;
  answerTask: ReturnType<
    typeof createAdministrativeAutonomyRuntime
  >["answerTaskConfirmation"];
  prepareTask: ReturnType<
    typeof createAdministrativeAutonomyRuntime
  >["prepareTaskConfirmation"];
  readTask(taskId: string): Promise<AdministrativeEvidenceRecord | undefined>;
  readPolicyStatus(): Promise<AdministrativePolicyStatus>;
  readAutonomyStatus(): Promise<{
    readonly body: unknown;
    readonly statusCode: number;
  }>;
  reconcileOperations(): Promise<void>;
  suspendPolicyState(): Promise<AdministrativePolicyStatus>;
}

export async function createAdministrativeAutonomyScenario(options: {
  readonly beforeOperationEffect?: (
    request: AdministrativeOperationRequest,
  ) => Promise<void>;
  readonly crashAfterFirstEffect?: boolean;
  readonly databasePath: string;
  readonly effectLedger?: Set<string>;
  readonly executionAdapters?: "available" | "unavailable";
  readonly identifierNamespace?: string;
  readonly now: string;
  readonly operationAttempts?: string[];
  readonly providerPlan: AdministrativeProviderPlan | unknown;
}): Promise<AdministrativeAutonomyScenario> {
  let capabilitySequence = 0;
  let claimSequence = 0;
  let eventSequence = 0;
  let operationSequence = 0;
  let taskSequence = 0;
  let freshPasskey = false;
  let crashedAfterEffect = false;
  let revisePolicyAfterFirstOperation = false;
  let revisePolicyBeforePlanAdmission = false;
  const executedOperations: AdministrativeOperationRequest[] = [];
  const operationAttempts: AdministrativeOperationRequest[] = [];
  const effectLedger = options.effectLedger ?? new Set<string>();
  const identifierNamespace = options.identifierNamespace ?? "";
  const store = createSqliteAdministrativeAutonomyStore(options.databasePath);
  let runtime: ReturnType<typeof createAdministrativeAutonomyRuntime>;
  const executor = {
    async execute(request: AdministrativeOperationRequest) {
      operationAttempts.push(request);
      options.operationAttempts?.push(request.operationId);
      if (!effectLedger.has(request.operationId)) {
        await options.beforeOperationEffect?.(request);
        effectLedger.add(request.operationId);
        executedOperations.push(request);
        if (revisePolicyAfterFirstOperation) {
          revisePolicyAfterFirstOperation = false;
          const policy = await runtime.getPolicyStatus();
          if (policy.status !== "active") {
            throw new Error("The interleaved policy revision has no active base");
          }
          await runtime.activatePolicy({
            expectedActiveRevision: policy.revision,
            source: "fresh-passkey-action",
          });
        }
        if (options.crashAfterFirstEffect && !crashedAfterEffect) {
          crashedAfterEffect = true;
          throw new Error("Simulated process loss after the Operation effect");
        }
      }
      const common = {
        completedAt: options.now,
        operationId: request.operationId,
        summary: `The ${request.kind} Operation completed through the fake executor.`,
      };
      if (request.kind === "live-patch.apply") {
        return {
          ...common,
          kind: request.kind,
          mutationProof: {
            healthCheck: {
              kind: "registered-application-health" as const,
              observedAt: options.now,
              status: "healthy" as const,
            },
            independentRollback: {
              armedAt: options.now,
              kind: "independent-live-patch-rollback" as const,
              rollbackDeadline:
                request.mutationBoundary.independentRollback.rollbackDeadline,
            },
            verification: {
              kind: "independent-application-health-proof" as const,
              observedAt: options.now,
              status: "healthy" as const,
            },
          },
        };
      }
      if (request.kind === "production.observe") {
        return { ...common, kind: request.kind };
      }
      return { ...common, kind: request.kind };
    },
  };
  const provider = {
    async choosePlan() {
      if (revisePolicyBeforePlanAdmission) {
        revisePolicyBeforePlanAdmission = false;
        const policy = await runtime.getPolicyStatus();
        if (policy.status !== "active") {
          throw new Error("The interleaved policy revision has no active base");
        }
        await runtime.activatePolicy({
          expectedActiveRevision: policy.revision,
          source: "fresh-passkey-action",
        });
      }
      return options.providerPlan;
    },
  };
  runtime = createAdministrativeAutonomyRuntime({
    ...(options.executionAdapters === "unavailable"
      ? {}
      : { executor, provider }),
    identifiers: {
      nextCapability: () =>
        `${identifierNamespace}administrative-confirmation-capability-${(capabilitySequence += 1)}`,
      nextClaimId: () =>
        `${identifierNamespace}administrative-claim-${(claimSequence += 1)}`,
      nextEventId: () =>
        `${identifierNamespace}administrative-event-${(eventSequence += 1)}`,
      nextOperationId: () =>
        `${identifierNamespace}administrative-operation-${(operationSequence += 1)}`,
      nextTaskId: () =>
        `${identifierNamespace}administrative-task-${(taskSequence += 1)}`,
    },
    now: () => options.now,
    store,
  });
  await runtime.reconcileOperations();
  const api = createTaskApi({
    administrativeControls: runtime,
    authentication: {
      async canChangeState({ csrfToken, sessionToken }) {
        return csrfToken === scenarioCsrf && sessionToken === scenarioSession;
      },
      async canViewEvidence(sessionToken) {
        return sessionToken === scenarioSession;
      },
      async hasFreshPasskeyAction(sessionToken) {
        return sessionToken === scenarioSession && freshPasskey;
      },
    },
    origin: scenarioOrigin,
    records: {
      getEvidenceRecord: (taskId) => runtime.getTask(taskId),
      listEvidenceRecords: () => runtime.listTasks(),
      async recordPolicyDenial() {},
    },
  });

  return {
    async activatePolicy(input) {
      freshPasskey = input.freshPasskey;
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=${scenarioSession}`,
          origin: scenarioOrigin,
        },
        method: "POST",
        payload: {
          csrfToken: scenarioCsrf,
          expectedActiveRevision: input.expectedActiveRevision,
        },
        url: "/api/administrative-autonomy/activate",
      });
      freshPasskey = false;
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
    async close() {
      await api.close();
      await runtime.close();
    },
    attemptPolicyActivation: (input) => runtime.activatePolicy(input),
    async confirmAndRunTask(input) {
      const prepared = await runtime.prepareTaskConfirmation({
        intendedState: input.intendedState,
        outcome: input.outcome,
        ownerId: input.ownerId,
        requestId: input.requestId,
        target: input.target,
      });
      if (prepared.decision === "denied") return prepared;
      return runtime.answerTaskConfirmation({
        confirmation: input.confirmation,
        confirmationCapability: prepared.confirmationCapability,
        ownerId: input.ownerId,
        taskId: prepared.taskId,
      });
    },
    answerTask: (input) => runtime.answerTaskConfirmation(input),
    executedOperations,
    operationAttempts,
    interleavePolicyRevisionAfterFirstOperation() {
      revisePolicyAfterFirstOperation = true;
    },
    interleavePolicyRevisionBeforePlanAdmission() {
      revisePolicyBeforePlanAdmission = true;
    },
    prepareTask: (input) => runtime.prepareTaskConfirmation(input),
    readPolicyStatus: () => runtime.getPolicyStatus(),
    async readAutonomyStatus() {
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=${scenarioSession}`,
        },
        method: "GET",
        url: "/api/administrative-autonomy",
      });
      return {
        body: response.json<unknown>(),
        statusCode: response.statusCode,
      };
    },
    readTask: (taskId) => runtime.getTask(taskId),
    reconcileOperations: () => runtime.reconcileOperations(),
    async suspendPolicyState() {
      const policy = await store.readPolicyStatus();
      if (policy.status !== "active") {
        throw new Error("Administrative Autonomy is not active");
      }
      const suspended = await store.suspendPolicy({
        expectedRevision: policy.revision,
        expectedStateVersion: policy.stateVersion,
        suspendedAt: options.now,
      });
      if (suspended === undefined) {
        throw new Error("Administrative Suspension state changed concurrently");
      }
      return suspended;
    },
  };
}
