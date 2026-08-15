import type {
  BountywellHealthObservation,
  BountywellHealthInquiryRequest,
  BountywellHealthObservationRequest,
  EvidenceRecordProjection,
} from "@voice-agent/contracts";
import { bountywellHealthObservationSchema } from "@voice-agent/contracts";
import { createTaskApi } from "@voice-agent/api";
import { renderTaskPage } from "@voice-agent/pwa/server";
import { createDurableTaskRuntime } from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";

export interface BountywellHealthScenario {
  readonly brokerRequests: readonly unknown[];
  submit(request: BountywellHealthInquiryRequest): Promise<EvidenceRecordProjection>;
  readTaskPage(taskId: string): Promise<{
    readonly statusCode: number;
    readonly body: EvidenceRecordProjection;
    readonly html: string;
  }>;
  replayOperation(
    operationId: string,
  ): Promise<EvidenceRecordProjection | undefined>;
  close(): Promise<void>;
}

export interface BountywellHealthScenarioOptions {
  readonly databasePath: string;
  readonly now: string;
  readonly ids: readonly string[];
  readonly observation: BountywellHealthObservation;
  readonly rejectedBrokerMaterial?: readonly string[];
}

export async function createBountywellHealthScenario(
  options: BountywellHealthScenarioOptions,
): Promise<BountywellHealthScenario> {
  const ids = [...options.ids];
  const broker = new DeterministicBountywellHealthBroker(
    options.observation,
    options.rejectedBrokerMaterial,
  );
  const runtime = createDurableTaskRuntime({
    healthObserver: broker,
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The scenario exhausted its deterministic identifiers");
      }
      return id;
    },
    now: () => options.now,
    store: createSqliteDurableTaskStore(options.databasePath),
  });
  const api = createTaskApi(runtime);

  return {
    brokerRequests: broker.requests,
    async close() {
      await api.close();
      await runtime.close();
    },
    async readTaskPage(taskId) {
      const response = await api.inject({
        method: "GET",
        url: `/api/tasks/${encodeURIComponent(taskId)}`,
      });
      const body = response.json<EvidenceRecordProjection>();
      return {
        body,
        html: renderTaskPage(body),
        statusCode: response.statusCode,
      };
    },
    replayOperation: (operationId) =>
      runtime.replayBountywellHealthOperation(operationId),
    submit: (request) => runtime.submitBountywellHealthInquiry(request),
  };
}

class DeterministicBountywellHealthBroker {
  readonly requests: BountywellHealthObservationRequest[] = [];
  readonly #observation: BountywellHealthObservation;

  constructor(
    observation: BountywellHealthObservation,
    rejectedBrokerMaterial: readonly string[] = [],
  ) {
    if (rejectedBrokerMaterial.length > observation.rejectedEvidenceCount) {
      throw new Error("Rejected broker material count exceeds the bounded summary");
    }

    // The fixture deliberately drops rejected raw material at the adapter boundary.
    // Only the typed, size-bounded observation can enter orchestration.
    this.#observation = bountywellHealthObservationSchema.parse(observation);
  }

  async observe(
    request: BountywellHealthObservationRequest,
  ): Promise<BountywellHealthObservation> {
    this.requests.push(request);
    return this.#observation;
  }
}
