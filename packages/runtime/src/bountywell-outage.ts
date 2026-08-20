import {
  bountywellHealthObservationSchema,
  bountywellOutageDrillQuestion,
  bountywellOutageNotPresented,
  bountywellOutageReport,
  type BountywellBaselineEvidence,
  type BountywellHealthObservation,
  type BountywellHealthObserver,
  type BountywellRegistration,
  type BountywellRecoveryTimer,
  type BountywellRecoveryTimerProof,
  type BountywellServiceController,
  type BountywellTimerLifecycleEvidenceEvent,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import type {
  ApplicationRegistry,
  BountywellOperationKind,
  DurableTaskStore,
  StoredOperation,
} from "@voice-agent/durable-store";
import {
  authorizeBountywellDrillControl,
  authorizeBountywellFaultInjection,
  authorizeBountywellOutageReport,
  authorizeBountywellRestart,
  denyBountywellAuthorityExpansion,
  deriveBountywellOutageConclusion,
  diagnoseBountywellOutage,
  publicEndpointsRecovered,
} from "@voice-agent/policy";

/** One Evidence Event before the append-only history assigns its sequence. */
type UnsequencedEvidenceEvent<E = EvidenceEventProjection> = E extends unknown
  ? Omit<E, "sequence">
  : never;

const BOUNTYWELL_UNIT = "bountywell-api.service" as const;
const RECOVERY_DELAY_SECONDS = 600 as const;

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

/** Where a finished drill sends the owner's agreed completion report. */
export interface BountywellCompletionReports {
  requestBountywellCompletionReport(input: {
    readonly requestId: string;
    readonly taskId: string;
  }): Promise<void>;
}

/** Live evidence that the owner is available for the guarded drill. */
export interface BountywellOwnerAvailability {
  countLiveTelephoneSessions(): Promise<number>;
}

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
  /**
   * Hand the Voice Agent the drill's one sentence and open its diagnosis
   * Operation. Until this records a presentation, nothing recovers the drill.
   */
  presentBountywellOutage(): Promise<BountywellOutageInjection | undefined>;
  processNextBountywellOutageRecovery(): Promise<EvidenceRecordProjection | undefined>;
  proveBountywellRecoveryTimer(): Promise<BountywellRecoveryTimerProof>;
  submitBountywellOutageRecovery(requestId: string): Promise<EvidenceRecordProjection>;
}

export function createBountywellOutageControls(options: {
  readonly applicationRegistry?: ApplicationRegistry;
  /**
   * The agreed completion report for a finished drill. Without it the owner
   * would learn of recovery only by opening the Durable Task page.
   */
  readonly completionReports?: BountywellCompletionReports;
  readonly healthObserver?: BountywellHealthObserver;
  readonly nextId: () => string;
  readonly now: () => string;
  /** Evidence that the owner is live for the drill, not merely asserted to be. */
  readonly ownerAvailability?: BountywellOwnerAvailability;
  readonly recordPolicyDenial: () => Promise<void>;
  readonly serviceController?: BountywellServiceController;
  readonly store: DurableTaskStore;
}): BountywellOutageControls {
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

  /**
   * Authorize one drill Intervention against the Bountywell registration and
   * return the decision to record beside the Operation's own result.
   */
  async function authorizeDrillControl(): Promise<
    ReturnType<typeof authorizeBountywellDrillControl>
  > {
    const decision = authorizeBountywellDrillControl(
      await (await requireRegistry()).findBountywellRegistration(),
    );
    if (decision.decision === "deny") {
      await options.recordPolicyDenial();
      throw new Error(decision.reason);
    }
    return decision;
  }

  /**
   * Authorize injecting the drill fault against the Bountywell registration and
   * live evidence that the owner is available, not merely asserted to be.
   */
  async function authorizeFaultInjection(assertedAvailable: boolean): Promise<
    ReturnType<typeof authorizeBountywellFaultInjection>
  > {
    const decision = authorizeBountywellFaultInjection({
      assertedAvailable,
      liveTelephoneSessions:
        (await options.ownerAvailability?.countLiveTelephoneSessions()) ?? 0,
      registration: await (await requireRegistry()).findBountywellRegistration(),
    });
    if (decision.decision === "deny") {
      await options.recordPolicyDenial();
      throw new Error(decision.reason);
    }
    return decision;
  }

  /**
   * The open drill Durable Task, opened by the first Intervention rather than by
   * the injected fault, so that arming, proof, and baseline survive restart.
   */
  async function openDrill(): Promise<EvidenceRecordProjection> {
    const existing = await findOpenDrill(options.store);
    if (existing !== undefined) return existing;
    const openedAt = options.now();
    const taskId = options.nextId();
    return options.store.persistAcceptedInquiry({
      record: {
        evidence: [],
        task: {
          conclusion: "Bountywell Outage Drill preparation is pending.",
          createdAt: openedAt,
          id: taskId,
          kind: "bountywell.outage.recovery",
          question: bountywellOutageDrillQuestion,
          status: "pending",
          updatedAt: openedAt,
        },
      },
      requestId: drillRequestId(taskId),
    });
  }

  /**
   * Accept one durably identified drill Operation and record its result as
   * Evidence Events. A completed Operation replays its recorded result without
   * touching the Agent Host. An acceptance interrupted before completion is
   * resumed by re-running `execute`, so every effect must either reconcile
   * against the Agent Host first, as arming does, or be safe to re-apply to the
   * registered unit, as stopping it is.
   */
  async function runDrillOperation(input: {
    readonly acceptedSummary: string;
    readonly completedSummary: string;
    readonly kind: BountywellOperationKind;
    readonly record: EvidenceRecordProjection;
    readonly task?: {
      readonly conclusion: EvidenceRecordProjection["task"]["conclusion"];
      readonly question?: EvidenceRecordProjection["task"]["question"];
    };
    execute(): Promise<readonly UnsequencedEvidenceEvent[]>;
  }): Promise<EvidenceRecordProjection> {
    const taskId = input.record.task.id;
    const operations = await options.store.listOperations(taskId);
    const existing = operations.find((operation) => operation.kind === input.kind);
    // A completed Operation replays its recorded result; its effect is not repeated.
    if (existing?.status === "completed") return input.record;
    const operationId = existing?.id ?? options.nextId();
    const acceptedAt = options.now();
    let record = input.record;
    if (existing === undefined) {
      record = await options.store.persistAcceptedOperation({
        acceptedAt,
        evidence: [
          {
            details: { operationId },
            id: options.nextId(),
            kind: "operation.accepted",
            occurredAt: acceptedAt,
            sequence: lastSequence(record) + 1,
            summary: input.acceptedSummary,
          },
        ],
        idempotencyKey: `${taskId}:${input.kind}`,
        kind: input.kind,
        operationId,
        taskId,
      });
    }
    const results = await input.execute();
    const completedAt = options.now();
    let sequence = lastSequence(record);
    return options.store.completeBountywellOperation({
      evidence: [
        ...results.map(
          (event): EvidenceEventProjection => ({ ...event, sequence: ++sequence }),
        ),
        {
          details: { operationId },
          id: options.nextId(),
          kind: "operation.completed",
          occurredAt: completedAt,
          sequence: ++sequence,
          summary: input.completedSummary,
        } satisfies EvidenceEventProjection,
      ],
      observedAt: completedAt,
      operationId,
      ...(input.task === undefined
        ? {}
        : { task: { ...input.task, status: "pending" as const } }),
      taskId,
    });
  }

  async function captureBaseline(
    drill: EvidenceRecordProjection,
  ): Promise<EvidenceRecordProjection> {
    const observer = await requireObserver();
    const observation = bountywellHealthObservationSchema.parse(
      await observer.observe({
        operationId: options.nextId(),
        taskId: drill.task.id,
      }),
    );
    if (!publicEndpointsRecovered(observation)) {
      throw new Error("Bountywell baseline health could not be confirmed");
    }
    return options.store.appendEvidence({
      event: baselineEvidence(options.nextId(), options.now()),
      taskId: drill.task.id,
      updatedAt: options.now(),
    });
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
      const controller = await requireController();
      const policy = await authorizeDrillControl();
      const drill = await openDrill();
      // The recorded result of a completed arming is its lifecycle Evidence Event.
      if (projectDrill(drill).recordedArming) return armedTimer();
      let armed: BountywellRecoveryTimer | undefined;
      await runDrillOperation({
        acceptedSummary: "Arming the independent recovery timer was accepted.",
        completedSummary: "The independent recovery timer was armed.",
        execute: async () => {
          // An interrupted acceptance may already have armed the timer; the
          // Agent Host's own state decides whether to apply the effect again.
          const current = await controller.readRecoveryTimer();
          armed = current.armed ? current : await controller.armRecoveryTimer();
          return [
            policyDecided(options.nextId(), options.now(), policy),
            timerLifecycle(
              options.nextId(),
              options.now(),
              "armed",
              "The independent recovery timer is armed for bountywell-api.service.",
            ),
          ];
        },
        kind: "bountywell.recovery-timer.arm",
        record: drill,
      });
      return armed ?? armedTimer();
    },

    async proveBountywellRecoveryTimer() {
      const controller = await requireController();
      const policy = await authorizeDrillControl();
      const drill = await openDrill();
      const provenTimer = {
        capable: true as const,
        delaySeconds: RECOVERY_DELAY_SECONDS,
        unit: BOUNTYWELL_UNIT,
      };
      const projection = projectDrill(drill);
      if (projection.proved) return provenTimer;
      if (!projection.armed) {
        throw new Error("Recovery timer is not armed");
      }
      let proof: BountywellRecoveryTimerProof | undefined;
      await runDrillOperation({
        acceptedSummary: "Proving the independent recovery timer was accepted.",
        completedSummary:
          "The independent recovery timer was proven and left armed.",
        execute: async () => {
          proof = await controller.proveRecoveryTimer();
          return [
            policyDecided(options.nextId(), options.now(), policy),
            timerLifecycle(
              options.nextId(),
              options.now(),
              "proven",
              "The recovery timer was proven capable of starting bountywell-api.service after ten minutes.",
            ),
          ];
        },
        kind: "bountywell.recovery-timer.prove",
        record: drill,
        task: { conclusion: "Bountywell Outage Drill is armed and ready." },
      });
      return proof ?? provenTimer;
    },

    async captureBountywellBaseline() {
      const drill = await openDrill();
      const recorded = projectDrill(drill).baseline;
      if (recorded !== undefined) return recorded;
      const captured = projectDrill(await captureBaseline(drill)).baseline;
      if (captured === undefined) {
        throw new Error("Bountywell baseline evidence was not captured");
      }
      return captured;
    },

    async injectBountywellOutage(input) {
      const controller = await requireController();
      const policy = await authorizeFaultInjection(input.ownerAvailable);
      let drill = await openDrill();
      const injection = {
        report: authorizeBountywellOutageReport(bountywellOutageReport),
        requestId: drillRequestId(drill.task.id),
        taskId: drill.task.id,
      };
      const projection = projectDrill(drill);
      if (!projection.faultReported) {
        if (!projection.armed) {
          throw new Error("Recovery timer is not armed");
        }
        if (projection.baseline === undefined) {
          drill = await captureBaseline(drill);
        }
      }
      drill = await runDrillOperation({
        acceptedSummary: "Stopping the registered unit for the drill was accepted.",
        completedSummary: "The registered bountywell-api.service unit was stopped.",
        execute: async () => {
          await controller.stopRegisteredUnit();
          return [
            policyDecided(options.nextId(), options.now(), policy),
            {
              details: { report: bountywellOutageReport },
              id: options.nextId(),
              kind: "fault.reported",
              occurredAt: options.now(),
              summary: bountywellOutageReport,
            },
          ];
        },
        kind: "bountywell.service.stop",
        record: drill,
        task: {
          conclusion: "Bountywell outage recovery is pending.",
          question: bountywellOutageReport,
        },
      });
      const acceptedAt = options.now();
      if (!projectDrill(drill).taskAccepted) {
        await options.store.appendEvidence({
          event: {
            details: { requestId: injection.requestId },
            id: options.nextId(),
            kind: "task.accepted",
            occurredAt: acceptedAt,
            summary: "Bountywell outage recovery accepted.",
          },
          taskId: drill.task.id,
          updatedAt: acceptedAt,
        });
      }
      return injection;
    },

    async presentBountywellOutage() {
      const drill = await findOpenDrill(options.store);
      if (drill === undefined) return undefined;
      const projection = projectDrill(drill);
      // A drill that has not stopped the unit has no fault to present.
      if (!projection.faultReported) return undefined;
      const injection = {
        report: authorizeBountywellOutageReport(bountywellOutageReport),
        requestId: drillRequestId(drill.task.id),
        taskId: drill.task.id,
      };
      if (projection.faultPresented) return injection;
      const policy = await authorizeDrillControl();
      const presentedAt = options.now();
      await options.store.appendEvidence({
        event: policyDecided(options.nextId(), presentedAt, policy),
        taskId: drill.task.id,
        updatedAt: presentedAt,
      });
      const presented = await options.store.appendEvidence({
        event: {
          details: { report: bountywellOutageReport },
          id: options.nextId(),
          kind: "fault.presented",
          occurredAt: presentedAt,
          summary:
            "The Voice Agent was presented only that Bountywell's API appears unavailable.",
        },
        taskId: drill.task.id,
        updatedAt: presentedAt,
      });
      const diagnosisOperationId = options.nextId();
      await options.store.persistAcceptedOperation({
        acceptedAt: presentedAt,
        evidence: [
          {
            details: { operationId: diagnosisOperationId },
            id: options.nextId(),
            kind: "operation.accepted",
            occurredAt: presentedAt,
            sequence: lastSequence(presented) + 1,
            summary: "Bounded Bountywell diagnosis observation accepted.",
          },
        ],
        idempotencyKey: `${drill.task.id}:bountywell.outage.diagnose`,
        kind: "bountywell.outage.diagnose",
        operationId: diagnosisOperationId,
        taskId: drill.task.id,
      });
      return injection;
    },

    async submitBountywellOutageRecovery(requestId) {
      const existing = await options.store.findByRequestId(requestId);
      if (existing === undefined) {
        throw new Error(bountywellOutageNotPresented);
      }
      if ("expired" in existing) {
        throw new Error("Evidence Record retention expired");
      }
      if (existing.task.status !== "pending") return existing;
      if (!projectDrill(existing).faultPresented) {
        throw new Error(bountywellOutageNotPresented);
      }
      return completeOutageRecovery({
        ...(options.completionReports === undefined
          ? {}
          : { completionReports: options.completionReports }),
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
      const drill = await findOpenDrill(options.store);
      if (drill === undefined) return undefined;
      const operations = await options.store.listOperations(drill.task.id);
      // The diagnosis Operation exists only once the fault report was presented
      // to the Voice Agent, so an unpresented drill never auto-completes here.
      if (!operations.some(isDiagnosisOperation)) return undefined;
      return completeOutageRecovery({
        ...(options.completionReports === undefined
          ? {}
          : { completionReports: options.completionReports }),
        nextId: options.nextId,
        now: options.now,
        observer: await requireObserver(),
        record: drill,
        registration: await (await requireRegistry()).findBountywellRegistration(),
        serviceController: await requireController(),
        store: options.store,
      });
    },
  };
}

function drillRequestId(taskId: string): string {
  return `drill:${taskId}`;
}

/** The one request identity under which a drill's completion report is asked for. */
function drillCompletionRequestId(taskId: string): string {
  return `drill-completion:${taskId}`;
}

async function findOpenDrill(
  store: DurableTaskStore,
): Promise<EvidenceRecordProjection | undefined> {
  const pending = (await store.listTasks()).find(
    (task) =>
      task.kind === "bountywell.outage.recovery" && task.status === "pending",
  );
  return pending === undefined ? undefined : store.findByTaskId(pending.id);
}

function isDiagnosisOperation(operation: StoredOperation): boolean {
  return operation.kind === "bountywell.outage.diagnose";
}

/**
 * The drill state projected from one walk of the append-only Evidence Events:
 * whether arming and proof recorded their results, whether the timer is armed
 * now, and the baseline the drill captured before the fault.
 */
interface DrillProjection {
  readonly armed: boolean;
  readonly baseline: BountywellBaselineEvidence | undefined;
  readonly faultPresented: boolean;
  readonly faultReported: boolean;
  readonly proved: boolean;
  readonly recordedArming: boolean;
  readonly taskAccepted: boolean;
}

function projectDrill(record: EvidenceRecordProjection): DrillProjection {
  let armed = false;
  let baseline: BountywellBaselineEvidence | undefined;
  let faultPresented = false;
  let faultReported = false;
  let proved = false;
  let recordedArming = false;
  let taskAccepted = false;
  for (const event of record.evidence) {
    switch (event.kind) {
      case "evidence.observed":
        baseline ??= projectBaseline(event.details.checks);
        break;
      case "fault.presented":
        faultPresented = true;
        break;
      case "fault.reported":
        faultReported = true;
        break;
      case "task.accepted":
        taskAccepted = true;
        break;
      case "timer.lifecycle":
        if (event.details.phase === "removed") armed = false;
        else if (event.details.phase !== "retained") armed = true;
        if (event.details.phase === "armed") recordedArming = true;
        if (event.details.phase === "proven") proved = true;
        break;
      default:
        break;
    }
  }
  return {
    armed,
    baseline,
    faultPresented,
    faultReported,
    proved,
    recordedArming,
    taskAccepted,
  };
}

/**
 * The captured baseline read from the first observed Evidence Event, which is
 * recorded only once the public endpoints and registered unit are confirmed.
 */
function projectBaseline(
  checks: Extract<
    EvidenceEventProjection,
    { kind: "evidence.observed" }
  >["details"]["checks"],
): BountywellBaselineEvidence | undefined {
  const publicHealth = checks.find((check) => check.source === "public-health");
  const authentication = checks.find(
    (check) => check.source === "authentication-boundary",
  );
  const service = checks.find((check) => check.source === "service-state");
  return publicHealth?.facts.statusCode === 200 &&
    authentication?.facts.statusCode === 401 &&
    service?.facts.active === true
    ? { authenticationBoundary: 401, publicHealth: 200, serviceActive: true }
    : undefined;
}

function policyDecided(
  id: string,
  occurredAt: string,
  policy: ReturnType<typeof authorizeBountywellDrillControl>,
): UnsequencedEvidenceEvent<
  Extract<EvidenceEventProjection, { kind: "policy.decided" }>
> {
  return {
    details: policy,
    id,
    kind: "policy.decided",
    occurredAt,
    summary: policy.reason,
  };
}

function armedTimer(): BountywellRecoveryTimer {
  return {
    armed: true,
    delaySeconds: RECOVERY_DELAY_SECONDS,
    unit: BOUNTYWELL_UNIT,
  };
}

type BountywellTimerPhase =
  BountywellTimerLifecycleEvidenceEvent["details"]["phase"];

function timerLifecycle(
  id: string,
  occurredAt: string,
  phase: BountywellTimerPhase,
  summary: string,
): UnsequencedEvidenceEvent<BountywellTimerLifecycleEvidenceEvent> {
  return {
    details: {
      delaySeconds: RECOVERY_DELAY_SECONDS,
      phase,
      unit: BOUNTYWELL_UNIT,
    },
    id,
    kind: "timer.lifecycle",
    occurredAt,
    summary,
  };
}

function baselineEvidence(
  id: string,
  occurredAt: string,
): UnsequencedEvidenceEvent<
  Extract<EvidenceEventProjection, { kind: "evidence.observed" }>
> {
  return {
    details: {
      checks: [
        {
          facts: { statusCode: 200 },
          outcome: "pass",
          source: "public-health",
          summary: "Baseline public /api/health returned 200.",
        },
        {
          facts: { statusCode: 401 },
          outcome: "pass",
          source: "authentication-boundary",
          summary: "Baseline public /api/data returned 401.",
        },
        {
          facts: { active: true },
          outcome: "pass",
          source: "service-state",
          summary: "Baseline registered unit was active.",
        },
      ],
      rejectedEvidenceCount: 0,
    },
    id,
    kind: "evidence.observed",
    occurredAt,
    summary: "Baseline Bountywell public endpoint and service evidence was recorded.",
  };
}

async function completeOutageRecovery(options: {
  readonly completionReports?: BountywellCompletionReports;
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
  const observe = operations.find(isDiagnosisOperation);
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
        hypotheses: [...diagnosis.hypotheses],
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
    readonly completionReports?: BountywellCompletionReports;
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
    // Removal is claimed only once the Agent Host itself reports the timer gone,
    // so a drill never concludes while a backstop could still start the unit.
    if ((await options.serviceController.readRecoveryTimer()).armed) {
      throw new Error("The independent recovery timer could not be removed");
    }
  }
  // The owner's completion report is requested before the drill concludes, so a
  // report that cannot be requested leaves the recovery to be retried rather
  // than concluding a drill the owner is never told about. Reports are claimed
  // only once their Durable Task is terminal, so nothing is delivered early.
  await options.completionReports?.requestBountywellCompletionReport({
    requestId: drillCompletionRequestId(record.task.id),
    taskId: record.task.id,
  });
  const reported = (await options.store.findByTaskId(record.task.id)) ?? accepted;
  const nextSequence = lastSequence(reported);
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
        ...timerLifecycle(
          options.nextId(),
          occurredAt,
          "removed",
          "The recovery timer is no longer armed.",
        ),
        sequence: nextSequence + 2,
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
        ...timerLifecycle(
          options.nextId(),
          occurredAt,
          "retained",
          "The recovery timer remains armed after unsuccessful recovery.",
        ),
        sequence: sequence + 1,
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
