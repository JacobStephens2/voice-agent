import {
  type AdministrativeEvidenceRecord,
  type AdministrativeOperationRequest,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyStatus,
  type AdministrativeProviderPlan,
  type AdministrativeTaskOutcome,
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
    readonly outcome: AdministrativeTaskOutcome;
    readonly ownerId: string;
    readonly requestId: string;
    readonly target: AdministrativeTaskTarget;
  }): Promise<AdministrativeTaskAdmissionResult>;
  interleavePolicyRevisionBeforePlanAdmission(): void;
  answerTask: ReturnType<
    typeof createAdministrativeAutonomyRuntime
  >["answerTaskConfirmation"];
  prepareTask: ReturnType<
    typeof createAdministrativeAutonomyRuntime
  >["prepareTaskConfirmation"];
  readTask(taskId: string): Promise<AdministrativeEvidenceRecord | undefined>;
  readPolicyStatus(): Promise<AdministrativePolicyStatus>;
}

export async function createAdministrativeAutonomyScenario(options: {
  readonly databasePath: string;
  readonly now: string;
  readonly providerPlan: AdministrativeProviderPlan | unknown;
}): Promise<AdministrativeAutonomyScenario> {
  let capabilitySequence = 0;
  let eventSequence = 0;
  let operationSequence = 0;
  let taskSequence = 0;
  let freshPasskey = false;
  let revisePolicyBeforePlanAdmission = false;
  const executedOperations: AdministrativeOperationRequest[] = [];
  const store = createSqliteAdministrativeAutonomyStore(options.databasePath);
  let runtime: ReturnType<typeof createAdministrativeAutonomyRuntime>;
  runtime = createAdministrativeAutonomyRuntime({
    executor: {
      async execute(request) {
        executedOperations.push(request);
        return {
          completedAt: options.now,
          summary: `The ${request.kind} Operation completed through the fake executor.`,
        };
      },
    },
    identifiers: {
      nextCapability: () =>
        `administrative-confirmation-capability-${(capabilitySequence += 1)}`,
      nextEventId: () => `administrative-event-${(eventSequence += 1)}`,
      nextOperationId: () =>
        `administrative-operation-${(operationSequence += 1)}`,
      nextTaskId: () => `administrative-task-${(taskSequence += 1)}`,
    },
    now: () => options.now,
    provider: {
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
    },
    store,
  });
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
    interleavePolicyRevisionBeforePlanAdmission() {
      revisePolicyBeforePlanAdmission = true;
    },
    prepareTask: (input) => runtime.prepareTaskConfirmation(input),
    readPolicyStatus: () => runtime.getPolicyStatus(),
    readTask: (taskId) => runtime.getTask(taskId),
  };
}
