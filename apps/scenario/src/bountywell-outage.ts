import {
  type BountywellBaselineEvidence,
  type BountywellRecoveryTimer,
  type BountywellRecoveryTimerProof,
  type CompletionReportOperation,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import {
  createBountywellOperationsBroker,
  createDeterministicBountywellHost,
  createSqliteBrokerOperationStore,
  type BountywellHostCommand,
} from "@voice-agent/operations-broker";
import {
  createDurableTaskRuntime,
  createTaskContinuityRuntime,
} from "@voice-agent/runtime";
import {
  createSqliteDurableTaskStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";

export interface BountywellOutageScenario {
  readonly hostCommands: readonly BountywellHostCommand[];
  readonly timer: BountywellRecoveryTimer;
  armRecoveryTimer(): Promise<BountywellRecoveryTimer>;
  captureBaseline(): Promise<BountywellBaselineEvidence>;
  close(): Promise<void>;
  grantRestart(
    input: {
      readonly source: "fresh-passkey" | "repository" | "trusted-session" | "voice";
    },
  ): ReturnType<
    ReturnType<typeof createDurableTaskRuntime>["grantBountywellRestart"]
  >;
  injectFault(input: { readonly ownerAvailable: boolean }): ReturnType<
    ReturnType<typeof createDurableTaskRuntime>["injectBountywellOutage"]
  >;
  /** The drill controller handing the Voice Agent its one sentence. */
  present(): ReturnType<
    ReturnType<typeof createDurableTaskRuntime>["presentBountywellOutage"]
  >;
  /** The worker poll that recovers a presented drill without a request id. */
  pollRecovery(): Promise<EvidenceRecordProjection | undefined>;
  /** The next completion report the owner would receive. */
  processNextCompletionReport(): Promise<CompletionReportOperation | undefined>;
  proveRecoveryTimer(): Promise<BountywellRecoveryTimerProof>;
  /** The open drill's Evidence Record, for asserting a partially applied drill. */
  readOpenDrill(): Promise<EvidenceRecordProjection | undefined>;
  recover(requestId: string): Promise<EvidenceRecordProjection>;
  registerBountywell(): ReturnType<
    ReturnType<typeof createDurableTaskRuntime>["registerBountywell"]
  >;
  advanceMs(milliseconds: number): Promise<void>;
  /**
   * Restart the Voice Agent process against the same durable store and the same
   * Agent Host, so a Durable Task resumes from its Evidence Events alone.
   */
  restart(input?: { readonly ids?: readonly string[] }): Promise<void>;
  restoreService(): Promise<void>;
  setAfterStart(
    next:
      | {
          readonly authenticationBoundary: number;
          readonly publicHealth: number;
        }
      | undefined,
  ): void;
  setCrashAfter(action: BountywellHostCommand["action"] | undefined): void;
  /** Whether a live Telephone Session is carrying the owner right now. */
  setOwnerAvailable(available: boolean): void;
  setStartFailure(fails: boolean): void;
}

export async function createBountywellOutageScenario(options: {
  readonly databasePath: string;
  readonly ids: readonly string[];
  readonly now: string;
}): Promise<BountywellOutageScenario> {
  let ids = [...options.ids];
  let nowMs = Date.parse(options.now);
  const now = () => new Date(nowMs).toISOString();
  const nextId = () => {
    const id = ids.shift();
    if (id === undefined) {
      throw new Error("The scenario exhausted its deterministic identifiers");
    }
    return id;
  };
  let liveTelephoneSessionIds: readonly string[] = ["telephone-session-drill"];
  const host = createDeterministicBountywellHost({
    advanceMs(milliseconds) {
      nowMs += milliseconds;
    },
    now,
  });

  function startProcess() {
    const brokerStore = createSqliteBrokerOperationStore(
      `${options.databasePath}.broker`,
    );
    const store = createSqliteDurableTaskStore(options.databasePath);
    const continuity = createTaskContinuityRuntime({
      nextId,
      now,
      store: createSqliteTaskContinuityStore(options.databasePath),
      tasks: store,
    });
    return {
      brokerStore,
      continuity,
      store,
      runtime: createDurableTaskRuntime({
        applicationRegistry: store,
        completionReports: {
          async requestBountywellCompletionReport(input) {
            await continuity.requestCompletionCallback({
              ...input,
              telephone: registeredTelephone,
              telephoneSessionId: `completion:${input.taskId}`,
            });
          },
        },
        healthObserver: createBountywellOperationsBroker({
          now,
          probes: host.probes,
          store: brokerStore,
        }),
        nextId,
        now,
        ownerAvailability: {
          async countLiveTelephoneSessions() {
            return liveTelephoneSessionIds.length;
          },
        },
        serviceController: host.controller,
        store,
      }),
    };
  }

  let agentProcess = startProcess();
  await agentProcess.continuity.configureNotification({
    email: "owner@example.com",
    from: "Voice Agent <tasks@notify.stephens.page>",
    notificationSubdomain: "notify.stephens.page",
  });

  return {
    get hostCommands() {
      return host.commands;
    },
    get timer() {
      return host.timer;
    },
    armRecoveryTimer: () => agentProcess.runtime.armBountywellRecoveryTimer(),
    captureBaseline: () => agentProcess.runtime.captureBountywellBaseline(),
    async close() {
      await agentProcess.runtime.close();
      await agentProcess.continuity.close();
      await agentProcess.brokerStore.close();
    },
    grantRestart: ({ source }) => agentProcess.runtime.grantBountywellRestart(source),
    injectFault: (input) => agentProcess.runtime.injectBountywellOutage(input),
    present: () => agentProcess.runtime.presentBountywellOutage(),
    pollRecovery: () =>
      agentProcess.runtime.processNextBountywellOutageRecovery(),
    processNextCompletionReport: () => agentProcess.continuity.processNextReport(),
    proveRecoveryTimer: () => agentProcess.runtime.proveBountywellRecoveryTimer(),
    async readOpenDrill() {
      const open = (await agentProcess.store.listTasks()).find(
        (task) =>
          task.kind === "bountywell.outage.recovery" && task.status === "pending",
      );
      return open === undefined
        ? undefined
        : agentProcess.store.findByTaskId(open.id);
    },
    recover: (requestId) =>
      agentProcess.runtime.submitBountywellOutageRecovery(requestId),
    registerBountywell: () => agentProcess.runtime.registerBountywell(),
    async advanceMs(milliseconds) {
      nowMs += milliseconds;
      await host.controller.fireDueTimers();
    },
    async restart(input = {}) {
      await agentProcess.runtime.close();
      await agentProcess.continuity.close();
      await agentProcess.brokerStore.close();
      if (input.ids !== undefined) ids = [...input.ids];
      agentProcess = startProcess();
    },
    async restoreService() {
      await host.controller.startRegisteredUnit();
    },
    setAfterStart: (next) => host.setAfterStart(next),
    setCrashAfter: (action) => host.setCrashAfter(action),
    setOwnerAvailable(available) {
      liveTelephoneSessionIds = available ? ["telephone-session-drill"] : [];
    },
    setStartFailure: (fails) => host.setStartFailure(fails),
  };
}

const registeredTelephone = {
  livekitInboundTrunkId: "livekit-inbound",
  livekitOutboundTrunkId: "livekit-outbound",
  registeredAt: "2026-08-18T00:00:00.000Z",
  revision: 1,
  telephoneNumber: "+12025550123",
  telnyxNumber: "+12025550124",
} as const;
