import type {
  CompletionCallbackRequestResult,
  CompletionCallbackProviderEvent,
  CompletionProviderActionResult,
  CompletionReportOperation,
  EvidenceRecordProjection,
} from "@voice-agent/contracts";
import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import {
  createDurableTaskRuntime,
  createTaskContinuityRuntime,
} from "@voice-agent/runtime";
import {
  createSqliteDurableTaskStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";

export interface TaskContinuityScenario {
  applyEvidenceLifecyclePolicy(input: {
    readonly freshPasskey: boolean;
  }): Promise<{ readonly body: unknown; readonly statusCode: number }>;
  acceptTask(requestId: string): Promise<EvidenceRecordProjection>;
  close(): Promise<void>;
  completeCompletionResumptionWithoutEvidence(
    operationId: string,
  ): Promise<void>;
  claimImmediateCompletionResumption(input: {
    readonly operationId: string;
    readonly taskId: string;
  }): Promise<boolean>;
  claimCompletionCallbackPlacement(
    effectId: string,
    taskId: string,
  ): Promise<boolean>;
  processNextReport(): Promise<CompletionReportOperation | undefined>;
  processNextTask(): Promise<EvidenceRecordProjection | undefined>;
  receiveCompletionCallbackEvent(
    event: CompletionCallbackProviderEvent,
  ): Promise<CompletionProviderActionResult>;
  recordNotificationDelivery(input: {
    readonly deliveryId: string;
    readonly operationId: string;
    readonly providerMessageId: string;
  }): Promise<void>;
  recordCompletionResumption(input: {
    readonly operationId: string;
  }): Promise<void>;
  readMetrics(): Promise<string>;
  readTask(taskId: string): Promise<EvidenceRecordProjection | undefined>;
  requestCompletionCallback(input: {
    readonly requestId: string;
    readonly taskId: string;
    readonly telephoneSessionId: string;
  }): Promise<CompletionCallbackRequestResult>;
  requestSessionFailureNotification(input: {
    readonly callbackOperationId: string;
    readonly failureEventId: string;
  }): Promise<void>;
  requestStop(input: {
    readonly requestId: string;
    readonly taskId: string;
  }): Promise<EvidenceRecordProjection>;
  runEvidenceLifecyclePolicy(): Promise<
    { readonly cutoff: string } | undefined
  >;
  updateNotificationPreference(input: {
    readonly email: string;
    readonly freshPasskey: boolean;
    readonly from: string;
    readonly notificationSubdomain: string;
  }): Promise<{ readonly body: unknown; readonly statusCode: number }>;
}

export async function createTaskContinuityScenario(options: {
  readonly databasePath: string;
  readonly ids: readonly string[];
  readonly now: string;
}): Promise<TaskContinuityScenario> {
  const ids = [...options.ids];
  const nextId = () => {
    const id = ids.shift();
    if (id === undefined) {
      throw new Error("The scenario exhausted its deterministic identifiers");
    }
    return id;
  };
  const taskStore = createSqliteDurableTaskStore(options.databasePath);
  await taskStore.registerBountywell(options.now);
  const tasks = createDurableTaskRuntime({
    applicationRegistry: taskStore,
    healthObserver: {
      async observe() {
        return {
          checks: [
            {
              facts: { statusCode: 200 },
              outcome: "pass",
              source: "public-health",
              summary: "The public health endpoint responded successfully.",
            },
          ],
          observedAt: options.now,
          rejectedEvidenceCount: 0,
        };
      },
    },
    nextId,
    now: () => options.now,
    store: taskStore,
  });
  const continuityStore = createSqliteTaskContinuityStore(options.databasePath);
  const continuity = createTaskContinuityRuntime({
    nextId,
    now: () => options.now,
    store: continuityStore,
    tasks: taskStore,
  });
  await continuity.configureNotification({
    email: "owner@example.com",
    from: "Voice Agent <tasks@notify.stephens.page>",
    notificationSubdomain: "notify.stephens.page",
  });
  let freshPasskey = false;
  const api = createTaskApi({
    authentication: {
      async canChangeState({ csrfToken, sessionToken }) {
        return (
          csrfToken === "scenario-csrf-token-0001" &&
          sessionToken === "scenario-trusted-session"
        );
      },
      async canViewEvidence(sessionToken) {
        return sessionToken === "scenario-trusted-session";
      },
      async hasFreshPasskeyAction(sessionToken) {
        return sessionToken === "scenario-trusted-session" && freshPasskey;
      },
    },
    completionControls: continuity,
    origin: "https://voice.stephens.page",
    records: tasks,
  });

  return {
    async applyEvidenceLifecyclePolicy(input) {
      freshPasskey = input.freshPasskey;
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=scenario-trusted-session`,
          origin: "https://voice.stephens.page",
        },
        method: "POST",
        payload: { csrfToken: "scenario-csrf-token-0001" },
        url: "/api/evidence/retention",
      });
      return { body: response.json<unknown>(), statusCode: response.statusCode };
    },
    acceptTask: (requestId) =>
      tasks.acceptBountywellHealthInquiry({
        question: "Is Bountywell healthy?",
        requestId,
      }),
    async close() {
      await api.close();
      await continuity.close();
      await tasks.close();
    },
    async completeCompletionResumptionWithoutEvidence(operationId) {
      await continuityStore.completeCompletionResumption(
        operationId,
        options.now,
      );
    },
    claimImmediateCompletionResumption: (input) =>
      continuity.claimImmediateCompletionResumption(input),
    claimCompletionCallbackPlacement: (effectId, taskId) =>
      continuityStore.claimCompletionCallbackPlacement(effectId, taskId),
    processNextReport: () => continuity.processNextReport(),
    processNextTask: () => tasks.processNextBountywellHealthInquiry(),
    receiveCompletionCallbackEvent: (event) =>
      continuity.receiveCompletionCallbackEvent(event),
    recordNotificationDelivery: (input) =>
      continuity.recordNotificationDelivery(input),
    recordCompletionResumption: (input) =>
      continuity.recordCompletionResumption(input),
    async readMetrics() {
      const response = await api.inject({ method: "GET", url: "/metrics" });
      if (response.statusCode !== 200) {
        throw new Error("Task continuity metrics endpoint was unavailable");
      }
      return response.body;
    },
    readTask: (taskId) => tasks.getEvidenceRecord(taskId),
    requestCompletionCallback: (input) =>
      continuity.requestCompletionCallback({
        ...input,
        telephone: {
          livekitInboundTrunkId: "livekit-inbound",
          livekitOutboundTrunkId: "livekit-outbound",
          registeredAt: options.now,
          revision: 1,
          telephoneNumber: "+12025550123",
          telnyxNumber: "+12025550124",
        },
      }),
    requestSessionFailureNotification: (input) =>
      continuity.requestSessionFailureNotification({
        ...input,
        occurredAt: options.now,
      }),
    requestStop: (input) => tasks.requestStop(input),
    runEvidenceLifecyclePolicy: () =>
      continuity.runEvidenceLifecyclePolicy(),
    async updateNotificationPreference(input) {
      freshPasskey = input.freshPasskey;
      const response = await api.inject({
        headers: {
          cookie: `${trustedSessionCookieName}=scenario-trusted-session`,
          origin: "https://voice.stephens.page",
        },
        method: "POST",
        payload: {
          csrfToken: "scenario-csrf-token-0001",
          email: input.email,
          from: input.from,
          notificationSubdomain: input.notificationSubdomain,
        },
        url: "/api/notifications/preference",
      });
      return { body: response.json<unknown>(), statusCode: response.statusCode };
    },
  };
}
