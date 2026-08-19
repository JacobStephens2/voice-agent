import {
  bountywellHealthObservationSchema,
  bountywellOutageReport,
  type BountywellBaselineEvidence,
  type BountywellHealthObservation,
  type BountywellHealthObserver,
  type BountywellRegistration,
  type BountywellRecoveryTimer,
  type BountywellRecoveryTimerProof,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import type {
  ApplicationRegistry,
  DurableTaskStore,
} from "@voice-agent/durable-store";
import {
  authorizeBountywellOutageReport,
  authorizeBountywellRestart,
  denyBountywellAuthorityExpansion,
  deriveBountywellOutageConclusion,
  diagnoseBountywellOutage,
  publicEndpointsRecovered,
} from "@voice-agent/policy";

export interface BountywellServiceController {
  armRecoveryTimer(): Promise<BountywellRecoveryTimer>;
  fireDueTimers(): Promise<readonly { readonly unit: "bountywell-api.service" }[]>;
  inspectRecoveryTimer(): Promise<BountywellRecoveryTimerProof>;
  readRecoveryTimer(): Promise<BountywellRecoveryTimer>;
  removeRecoveryTimer(): Promise<{ readonly removed: boolean }>;
  startRegisteredUnit(): Promise<{
    readonly previousActive: boolean;
    readonly started: boolean;
  }>;
  stopRegisteredUnit(): Promise<{ readonly stopped: boolean }>;
}

export type BountywellAuthoritySource =
  | "fresh-passkey"
  | "repository"
  | "trusted-session"
  | "voice";

export type BountywellRestartGrant =
  | {
      readonly decision: "denied";
      readonly reason: string;
    }
  | {
      readonly decision: "granted";
      readonly registration: BountywellRegistration;
    };

export interface BountywellOutageInjection {
  readonly report: typeof bountywellOutageReport;
  readonly requestId: string;
  readonly taskId: string;
}

export interface BountywellOutageControls {
  armBountywellRecoveryTimer(): Promise<BountywellRecoveryTimer>;
  captureBountywellBaseline(): Promise<BountywellBaselineEvidence>;
  grantBountywellRestart(
    source: BountywellAuthoritySource,
  ): Promise<BountywellRestartGrant>;
  injectBountywellOutage(input: {
    readonly ownerAvailable: boolean;
  }): Promise<BountywellOutageInjection>;
  processNextBountywellOutageRecovery(): Promise<EvidenceRecordProjection | undefined>;
  proveBountywellRecoveryTimer(): Promise<BountywellRecoveryTimerProof>;
  submitBountywellOutageRecovery(requestId: string): Promise<EvidenceRecordProjection>;
}

export function createBountywellOutageControls(options: {
  readonly advanceMs?: (milliseconds: number) => void;
  readonly applicationRegistry?: ApplicationRegistry;
  readonly healthObserver?: BountywellHealthObserver;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly recordPolicyDenial: () => Promise<void>;
  readonly serviceController?: BountywellServiceController;
  readonly store: DurableTaskStore;
}): BountywellOutageControls {
  let baseline: BountywellBaselineEvidence | undefined;
  let timerProven = false;

  async function requireController(): Promise<BountywellServiceController> {
    if (options.serviceController === undefined) {
      throw new Error("Bountywell service controller is unavailable");
    }
    return options.serviceController;
  }

  async function requireObserver(): Promise<BountywellHealthObserver> {
    if (options.healthObserver === undefined) {
      throw new Error("Bountywell health observer is unavailable");
    }
    return options.healthObserver;
  }

  async function requireRegistry(): Promise<ApplicationRegistry> {
    if (options.applicationRegistry === undefined) {
      throw new Error("Application registry is unavailable");
    }
    return options.applicationRegistry;
  }

  return {
    async grantBountywellRestart(source) {
      if (source !== "fresh-passkey") {
        await options.recordPolicyDenial();
        return {
          decision: "denied",
          reason: denyBountywellAuthorityExpansion(source),
        };
      }
      const registry = await requireRegistry();
      const registration = await registry.grantBountywellRestart(options.now());
      return { decision: "granted", registration };
    },

    async armBountywellRecoveryTimer() {
      return (await requireController()).armRecoveryTimer();
    },

    async proveBountywellRecoveryTimer() {
      const controller = await requireController();
      const timer = await controller.readRecoveryTimer();
      if (!timer.armed) {
        throw new Error("Recovery timer is not armed");
      }
      if (options.advanceMs !== undefined) {
        options.advanceMs(600_000);
        const fired = await controller.fireDueTimers();
        if (fired[0]?.unit !== "bountywell-api.service") {
          throw new Error("Recovery timer did not start bountywell-api.service");
        }
        timerProven = true;
        return {
          capable: true,
          delaySeconds: 600,
          unit: "bountywell-api.service",
        };
      }
      const proof = await controller.inspectRecoveryTimer();
      timerProven = true;
      return proof;
    },

    async captureBountywellBaseline() {
      const observer = await requireObserver();
      const observation = bountywellHealthObservationSchema.parse(
        await observer.observe({
          operationId: `baseline:${options.nextId()}`,
          taskId: `baseline:${options.nextId()}`,
        }),
      );
      const captured = {
        authenticationBoundary: 401 as const,
        publicHealth: 200 as const,
        serviceActive: true as const,
      };
      if (!publicEndpointsRecovered(observation)) {
        throw new Error("Bountywell baseline health could not be confirmed");
      }
      baseline = captured;
      return captured;
    },

    async injectBountywellOutage(input) {
      if (!input.ownerAvailable) {
        throw new Error(
          "The live drill occurs only while the owner is available",
        );
      }
      const controller = await requireController();
      const timer = await controller.readRecoveryTimer();
      if (!timer.armed) {
        throw new Error("Recovery timer is not armed");
      }
      if (baseline === undefined) {
        await this.captureBountywellBaseline();
      }
      if (baseline === undefined) {
        throw new Error("Bountywell baseline evidence was not captured");
      }
      await controller.stopRegisteredUnit();
      const acceptedAt = options.now();
      const requestId = options.nextId();
      const taskId = options.nextId();
      const operationId = options.nextId();
      const evidence = createInjectionEvidence({
        acceptedAt,
        baseline,
        nextId: options.nextId,
        operationId,
        requestId,
        timerProven,
      });
      await options.store.persistAcceptedInquiry({
        operationId,
        record: {
          evidence,
          task: {
            conclusion: "Bountywell outage recovery is pending.",
            createdAt: acceptedAt,
            id: taskId,
            kind: "bountywell.outage.recovery",
            question: bountywellOutageReport,
            status: "pending",
            updatedAt: acceptedAt,
          },
        },
        requestId,
      });
      return {
        report: authorizeBountywellOutageReport(bountywellOutageReport),
        requestId,
        taskId,
      };
    },

    async submitBountywellOutageRecovery(requestId) {
      const existing = await options.store.findByRequestId(requestId);
      if (existing === undefined) {
        throw new Error("Bountywell outage recovery was not presented");
      }
      if ("expired" in existing) {
        throw new Error("Evidence Record retention expired");
      }
      if (existing.task.status !== "pending") return existing;
      return completeOutageRecovery({
        nextId: options.nextId,
        now: options.now,
        observer: await requireObserver(),
        record: existing,
        registration: await (await requireRegistry()).findBountywellRegistration(),
        serviceController: await requireController(),
        store: options.store,
      });
    },

    async processNextBountywellOutageRecovery() {
      const pending = (await options.store.listTasks()).find(
        (task) =>
          task.kind === "bountywell.outage.recovery" && task.status === "pending",
      );
      if (pending === undefined) return undefined;
      const record = await options.store.findByTaskId(pending.id);
      if (record === undefined || record.task.status !== "pending") {
        return record;
      }
      return completeOutageRecovery({
        nextId: options.nextId,
        now: options.now,
        observer: await requireObserver(),
        record,
        registration: await (await requireRegistry()).findBountywellRegistration(),
        serviceController: await requireController(),
        store: options.store,
      });
    },
  };
}

function createInjectionEvidence(input: {
  readonly acceptedAt: string;
  readonly baseline: BountywellBaselineEvidence;
  readonly nextId: () => string;
  readonly operationId: string;
  readonly requestId: string;
  readonly timerProven: boolean;
}): EvidenceEventProjection[] {
  const events: EvidenceEventProjection[] = [
    {
      details: {
        delaySeconds: 600,
        phase: "armed",
        unit: "bountywell-api.service",
      },
      id: input.nextId(),
      kind: "timer.lifecycle",
      occurredAt: input.acceptedAt,
      sequence: 1,
      summary: "The independent recovery timer is armed for bountywell-api.service.",
    },
  ];
  if (input.timerProven) {
    events.push({
      details: {
        delaySeconds: 600,
        phase: "proven",
        unit: "bountywell-api.service",
      },
      id: input.nextId(),
      kind: "timer.lifecycle",
      occurredAt: input.acceptedAt,
      sequence: events.length + 1,
      summary:
        "The recovery timer was proven capable of starting bountywell-api.service after ten minutes.",
    });
  }
  events.push(
    {
      details: {
        checks: [
          {
            facts: { statusCode: input.baseline.publicHealth },
            outcome: "pass",
            source: "public-health",
            summary: "Baseline public /api/health returned 200.",
          },
          {
            facts: { statusCode: input.baseline.authenticationBoundary },
            outcome: "pass",
            source: "authentication-boundary",
            summary: "Baseline public /api/data returned 401.",
          },
          {
            facts: { active: input.baseline.serviceActive },
            outcome: "pass",
            source: "service-state",
            summary: "Baseline registered unit was active.",
          },
        ],
        rejectedEvidenceCount: 0,
      },
      id: input.nextId(),
      kind: "evidence.observed",
      occurredAt: input.acceptedAt,
      sequence: events.length + 1,
      summary: "Baseline Bountywell public endpoint and service evidence was recorded.",
    },
    {
      details: { report: bountywellOutageReport },
      id: input.nextId(),
      kind: "fault.reported",
      occurredAt: input.acceptedAt,
      sequence: events.length + 2,
      summary: bountywellOutageReport,
    },
    {
      details: { requestId: input.requestId },
      id: input.nextId(),
      kind: "task.accepted",
      occurredAt: input.acceptedAt,
      sequence: events.length + 3,
      summary: "Bountywell outage recovery accepted.",
    },
    {
      details: { operationId: input.operationId },
      id: input.nextId(),
      kind: "operation.accepted",
      occurredAt: input.acceptedAt,
      sequence: events.length + 4,
      summary: "Bounded Bountywell diagnosis observation accepted.",
    },
  );
  return events;
}

async function completeOutageRecovery(options: {
  readonly nextId: () => string;
  readonly now: () => string;
  readonly observer: BountywellHealthObserver;
  readonly record: EvidenceRecordProjection;
  readonly registration: BountywellRegistration | undefined;
  readonly serviceController: BountywellServiceController;
  readonly store: DurableTaskStore;
}): Promise<EvidenceRecordProjection> {
  if (options.record.task.kind !== "bountywell.outage.recovery") {
    throw new Error("Durable Task is not a Bountywell outage recovery");
  }
  const operations = await options.store.listOperations(options.record.task.id);
  const observe = operations.find(
    (operation) => operation.kind === "bountywell.health.observe",
  );
  if (observe === undefined) {
    throw new Error("Bountywell diagnosis Operation is unavailable");
  }

  const observedAt = options.now();
  const observation = bountywellHealthObservationSchema.parse(
    await options.observer.observe({
      operationId: observe.id,
      taskId: options.record.task.id,
    }),
  );
  const diagnosis = diagnoseBountywellOutage(observation);
  const policy = authorizeBountywellRestart(options.registration);
  let sequence = lastSequence(options.record) + 1;
  const diagnosisEvidence: EvidenceEventProjection[] = [
    observedEvidence(options.nextId(), observedAt, sequence, observation),
    {
      details: {
        alreadyRecovered: diagnosis.alreadyRecovered,
        basis: diagnosis.basis,
        hypothesis: diagnosis.alreadyRecovered
          ? "The API already matches recovered public and service checks."
          : diagnosis.inactiveUnit === undefined
            ? "Public unavailability does not by itself identify the registered unit."
            : "The registered bountywell-api.service unit is inactive and may explain the unavailable API.",
        ...(diagnosis.inactiveUnit === undefined
          ? {}
          : { inactiveUnit: diagnosis.inactiveUnit }),
      },
      id: options.nextId(),
      kind: "diagnosis.recorded",
      occurredAt: observedAt,
      sequence: sequence + 1,
      summary: diagnosis.alreadyRecovered
        ? "The diagnosis is observation: Bountywell already matches the recovered public and service checks."
        : diagnosis.inactiveUnit === undefined
          ? "The inactive registered unit could not be identified from observation; remaining statements are inference."
          : "The diagnosis is observation: the registered bountywell-api.service unit is inactive.",
    },
    {
      details: policy,
      id: options.nextId(),
      kind: "policy.decided",
      occurredAt: observedAt,
      sequence: sequence + 2,
      summary:
        policy.decision === "allow"
          ? "Policy allowed the registered Bountywell restart."
          : policy.reason,
    },
    {
      details: { operationId: observe.id },
      id: options.nextId(),
      kind: "operation.completed",
      occurredAt: observedAt,
      sequence: sequence + 3,
      summary: "Bounded Bountywell diagnosis observation completed.",
    },
  ];
  let record = await options.store.completeBountywellOperation({
    evidence: diagnosisEvidence,
    observedAt,
    operationId: observe.id,
    taskId: options.record.task.id,
  });
  sequence = lastSequence(record);

  if (diagnosis.alreadyRecovered) {
    return finishRecovered(options, record, observedAt, sequence, true);
  }

  const canRestart =
    diagnosis.basis === "observation" &&
    diagnosis.inactiveUnit === "bountywell-api.service" &&
    policy.decision === "allow";
  if (!canRestart) {
    return retainTimerAndFail(options, record, observedAt, sequence);
  }

  const restartAt = options.now();
  const existingRestart = operations.find(
    (operation) => operation.kind === "bountywell.service.restart",
  );
  const restartOperationId = existingRestart?.id ?? options.nextId();
  if (existingRestart === undefined) {
    record = await options.store.persistAcceptedOperation({
      acceptedAt: restartAt,
      evidence: [
        {
          details: { operationId: restartOperationId },
          id: options.nextId(),
          kind: "operation.accepted",
          occurredAt: restartAt,
          sequence: sequence + 1,
          summary: "Policy-authorized Bountywell restart accepted.",
        },
      ],
      idempotencyKey: `${options.record.task.id}:bountywell.service.restart`,
      kind: "bountywell.service.restart",
      operationId: restartOperationId,
      taskId: options.record.task.id,
    });
  }
  const restart =
    existingRestart?.status === "completed"
      ? { previousActive: false, started: true }
      : await options.serviceController.startRegisteredUnit();
  const verification = bountywellHealthObservationSchema.parse(
    await options.observer.observe({
      operationId: `${restartOperationId}:verify`,
      taskId: options.record.task.id,
    }),
  );
  const recovered = restart.started && publicEndpointsRecovered(verification);
  sequence = lastSequence(record);
  record = await options.store.completeBountywellOperation({
    evidence: [
      {
        details: { operationId: restartOperationId },
        id: options.nextId(),
        kind: "operation.completed",
        occurredAt: restartAt,
        sequence: sequence + 1,
        summary: restart.started
          ? "The registered bountywell-api.service unit was started."
          : "The registered bountywell-api.service unit did not start.",
      },
      observedEvidence(
        options.nextId(),
        restartAt,
        sequence + 2,
        verification,
        "Recovery verification evidence was observed.",
      ),
    ],
    observedAt: restartAt,
    operationId: restartOperationId,
    taskId: options.record.task.id,
  });
  sequence = lastSequence(record);
  if (!recovered) {
    return retainTimerAndFail(options, record, restartAt, sequence);
  }
  return finishRecovered(options, record, restartAt, sequence, false);
}

async function finishRecovered(
  options: {
    readonly nextId: () => string;
    readonly now: () => string;
    readonly serviceController: BountywellServiceController;
    readonly store: DurableTaskStore;
  },
  record: EvidenceRecordProjection,
  occurredAt: string,
  sequence: number,
  alreadyRecovered: boolean,
): Promise<EvidenceRecordProjection> {
  const existingTimer = (await options.store.listOperations(record.task.id)).find(
    (operation) => operation.kind === "bountywell.recovery-timer.remove",
  );
  const timerOperationId = existingTimer?.id ?? options.nextId();
  const accepted =
    existingTimer === undefined
      ? await options.store.persistAcceptedOperation({
          acceptedAt: occurredAt,
          evidence: [
            {
              details: { operationId: timerOperationId },
              id: options.nextId(),
              kind: "operation.accepted",
              occurredAt,
              sequence: sequence + 1,
              summary: "Recovery-timer removal accepted after verified health.",
            },
          ],
          idempotencyKey: `${record.task.id}:bountywell.recovery-timer.remove`,
          kind: "bountywell.recovery-timer.remove",
          operationId: timerOperationId,
          taskId: record.task.id,
        })
      : record;
  if (existingTimer?.status !== "completed") {
    await options.serviceController.removeRecoveryTimer();
  }
  const nextSequence = lastSequence(accepted);
  return options.store.completeBountywellOperation({
    evidence: [
      {
        details: { operationId: timerOperationId },
        id: options.nextId(),
        kind: "operation.completed",
        occurredAt,
        sequence: nextSequence + 1,
        summary: "The independent recovery timer was removed.",
      },
      {
        details: {
          delaySeconds: 600,
          phase: "removed",
          unit: "bountywell-api.service",
        },
        id: options.nextId(),
        kind: "timer.lifecycle",
        occurredAt,
        sequence: nextSequence + 2,
        summary: "The recovery timer is no longer armed.",
      },
      {
        details: {},
        id: options.nextId(),
        kind: "task.completed",
        occurredAt,
        sequence: nextSequence + 3,
        summary: alreadyRecovered
          ? "Bountywell API was already recovered."
          : "Bountywell API was recovered.",
      },
    ],
    observedAt: occurredAt,
    operationId: timerOperationId,
    task: {
      conclusion: deriveBountywellOutageConclusion({
        alreadyRecovered,
        recovered: true,
      }),
      status: "completed",
    },
    taskId: record.task.id,
  });
}

async function retainTimerAndFail(
  options: {
    readonly nextId: () => string;
    readonly store: DurableTaskStore;
  },
  record: EvidenceRecordProjection,
  occurredAt: string,
  sequence: number,
): Promise<EvidenceRecordProjection> {
  return options.store.completeBountywellTask({
    conclusion: "Bountywell API recovery could not be confirmed.",
    evidence: [
      {
        details: {
          delaySeconds: 600,
          phase: "retained",
          unit: "bountywell-api.service",
        },
        id: options.nextId(),
        kind: "timer.lifecycle",
        occurredAt,
        sequence: sequence + 1,
        summary: "The recovery timer remains armed after unsuccessful recovery.",
      },
      {
        details: {},
        id: options.nextId(),
        kind: "task.completed",
        occurredAt,
        sequence: sequence + 2,
        summary: "Bountywell API recovery could not be confirmed.",
      },
    ],
    observedAt: occurredAt,
    taskId: record.task.id,
  });
}

function observedEvidence(
  id: string,
  occurredAt: string,
  sequence: number,
  observation: BountywellHealthObservation,
  summary = "Bounded Bountywell health evidence observed.",
): EvidenceEventProjection {
  return {
    details: {
      checks: observation.checks,
      rejectedEvidenceCount: observation.rejectedEvidenceCount,
      ...(observation.uncertainty === undefined
        ? {}
        : { uncertainty: observation.uncertainty }),
    },
    id,
    kind: "evidence.observed",
    occurredAt,
    sequence,
    summary,
  };
}

function lastSequence(record: EvidenceRecordProjection): number {
  return record.evidence.at(-1)?.sequence ?? 0;
}
