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
  recover(requestId: string): Promise<EvidenceRecordProjection>;
  registerBountywell(): ReturnType<
    ReturnType<typeof createDurableTaskRuntime>["registerBountywell"]
  >;
  advanceMs(milliseconds: number): Promise<void>;
  restoreService(): Promise<void>;
  setAfterStart(
    next:
      | {
          readonly authenticationBoundary: number;
          readonly publicHealth: number;
        }
      | undefined,
  ): void;
  setStartFailure(fails: boolean): void;
}

export async function createBountywellOutageScenario(options: {
  readonly databasePath: string;
  readonly ids: readonly string[];
  readonly now: string;
}): Promise<BountywellOutageScenario> {
  const ids = [...options.ids];
  let nowMs = Date.parse(options.now);
  const now = () => new Date(nowMs).toISOString();
  const host = createDeterministicBountywellHost({
    advanceMs(milliseconds) {
      nowMs += milliseconds;
    },
    now,
  });
  const brokerStore = createSqliteBrokerOperationStore(
    `${options.databasePath}.broker`,
  );
  const broker = createBountywellOperationsBroker({
    now,
    probes: host.probes,
    store: brokerStore,
  });
  const store = createSqliteDurableTaskStore(options.databasePath);
  const runtime = createDurableTaskRuntime({
    advanceMs(milliseconds) {
      nowMs += milliseconds;
    },
    applicationRegistry: store,
    healthObserver: broker,
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The scenario exhausted its deterministic identifiers");
      }
      return id;
    },
    now,
    serviceController: host.controller,
    store,
  });

  return {
    get hostCommands() {
      return host.commands;
    },
    get timer() {
      return host.timer;
    },
    armRecoveryTimer: () => runtime.armBountywellRecoveryTimer(),
    captureBaseline: () => runtime.captureBountywellBaseline(),
    async close() {
      await runtime.close();
      await brokerStore.close();
    },
    grantRestart: ({ source }) => runtime.grantBountywellRestart(source),
    injectFault: (input) => runtime.injectBountywellOutage(input),
    proveRecoveryTimer: () => runtime.proveBountywellRecoveryTimer(),
    recover: (requestId) => runtime.submitBountywellOutageRecovery(requestId),
    registerBountywell: () => runtime.registerBountywell(),
    async advanceMs(milliseconds) {
      nowMs += milliseconds;
      await host.controller.fireDueTimers();
    },
    async restoreService() {
      await host.controller.startRegisteredUnit();
    },
    setAfterStart: (next) => host.setAfterStart(next),
    setStartFailure: (fails) => host.setStartFailure(fails),
  };
}
