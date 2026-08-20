import {
  type BountywellBaselineEvidence,
  type BountywellRecoveryTimer,
  type BountywellRecoveryTimerProof,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import {
  createBountywellOperationsBroker,
  createDeterministicBountywellHost,
  createSqliteBrokerOperationStore,
  type BountywellHostCommand,
} from "@voice-agent/operations-broker";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

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
    return {
      brokerStore,
      store,
      runtime: createDurableTaskRuntime({
        applicationRegistry: store,
        healthObserver: createBountywellOperationsBroker({
          now,
          probes: host.probes,
          store: brokerStore,
        }),
        nextId,
        now,
        serviceController: host.controller,
        store,
      }),
    };
  }

  let agentProcess = startProcess();

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
      await agentProcess.brokerStore.close();
    },
    grantRestart: ({ source }) => agentProcess.runtime.grantBountywellRestart(source),
    injectFault: (input) => agentProcess.runtime.injectBountywellOutage(input),
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
      await agentProcess.brokerStore.close();
      if (input.ids !== undefined) ids = [...input.ids];
      agentProcess = startProcess();
    },
    async restoreService() {
      await host.controller.startRegisteredUnit();
    },
    setAfterStart: (next) => host.setAfterStart(next),
    setCrashAfter: (action) => host.setCrashAfter(action),
    setStartFailure: (fails) => host.setStartFailure(fails),
  };
}
