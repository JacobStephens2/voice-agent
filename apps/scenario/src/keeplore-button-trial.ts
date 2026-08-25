import {
  defaultRecognizedSpeechModel,
  type KeeploreDelegationRecord,
  type KeeploreRegistration,
  type TelephoneSessionActionResult,
} from "@voice-agent/contracts";
import {
  createKeeploreDelegationRuntime,
  createTelephoneSessionCoordinator,
  type KeeploreSubagentRunner,
} from "@voice-agent/runtime";
import {
  createSqliteDurableTaskStore,
  createSqliteKeeploreDelegationStore,
} from "@voice-agent/sqlite-store";

export interface KeeploreButtonTrialScenarioOptions {
  readonly databasePath: string;
  readonly ids: readonly string[];
  readonly now: string;
  readonly registration: KeeploreRegistration;
  readonly runner: KeeploreSubagentRunner;
  readonly sourceCommit: string;
}

export interface KeeploreButtonTrialScenario {
  authenticateTelephoneSession(telephoneSessionId: string): Promise<void>;
  close(): Promise<void>;
  getDelegation(taskId: string): Promise<KeeploreDelegationRecord | undefined>;
  listDelegations(): Promise<readonly KeeploreDelegationRecord[]>;
  processNextDelegation(): Promise<KeeploreDelegationRecord | undefined>;
  receiveTelephoneTurn(input: {
    readonly telephoneSessionId: string;
    readonly transcript: string;
    readonly turnId: string;
  }): Promise<TelephoneSessionActionResult>;
  requestStop(taskId: string): Promise<KeeploreDelegationRecord | undefined>;
}

export async function createKeeploreButtonTrialScenario(
  options: KeeploreButtonTrialScenarioOptions,
): Promise<KeeploreButtonTrialScenario> {
  const ids = [...options.ids];
  const authenticatedSessions = new Set<string>();
  const store = createSqliteKeeploreDelegationStore(options.databasePath);
  // Accepting a Delegation registers its Durable Task, so telephone evidence
  // recorded under that identity reaches the same authoritative task store the
  // worker uses.
  const taskStore = createSqliteDurableTaskStore(options.databasePath);
  const runtime = createKeeploreDelegationRuntime({
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The scenario exhausted its deterministic identifiers");
      }
      return id;
    },
    now: () => options.now,
    registration: options.registration,
    runner: options.runner,
    sourceCommit: options.sourceCommit,
    store,
  });
  const coordinator = createTelephoneSessionCoordinator({
    recognitionModel: defaultRecognizedSpeechModel,
    interpreter: {
      async interpret(input) {
        return {
          durationMs: 1,
          // The live classifier identifies generic state changes; the runtime
          // under test owns the task-specific Keeplore routing decision.
          intent: /^stop[.!]?$/iu.test(input.text.trim())
            ? "stop"
            : "state-changing",
          provider: "deterministic-keeplore-scenario-coordinator",
        };
      },
    },
    keeploreDelegations: runtime,
    stateChangingTasks: {
      async claim() {
        return { decision: "accepted", resource: "state-changing-task" };
      },
      async release() {
        return {};
      },
    },
    tasks: {
      appendTelephoneEvidence: (input) =>
        taskStore.appendEvidence({
          ...input,
          updatedAt: input.event.occurredAt,
        }),
      async submitTelephoneBountywellHealthInquiry() {
        throw new Error("Bountywell inquiry is outside this scenario");
      },
    },
  });
  return {
    async authenticateTelephoneSession(telephoneSessionId) {
      authenticatedSessions.add(telephoneSessionId);
    },
    async close() {
      store.close();
      taskStore.close();
    },
    getDelegation: (taskId) => runtime.get(taskId),
    listDelegations: () => runtime.list(),
    processNextDelegation: () => runtime.processNext(),
    async receiveTelephoneTurn(input) {
      if (!authenticatedSessions.has(input.telephoneSessionId)) {
        throw new Error("Telephone Session is not authenticated");
      }
      return coordinator.receiveProviderEvent({
        deliveryId: `delivery:${input.turnId}`,
        kind: "turn-finalized",
        occurredAt: options.now,
        stt: {
          durationMs: 1,
          provider: "deterministic-keeplore-scenario-stt",
        },
        telephoneSessionId: input.telephoneSessionId,
        transcript: input.transcript,
        turnId: input.turnId,
      });
    },
    requestStop: (taskId) => runtime.requestStop(taskId),
  };
}
