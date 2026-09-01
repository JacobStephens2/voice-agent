import {
  completionCallbackProviderEventSchema,
  completionCallbackRequestResultSchema,
  completionProviderActionResultSchema,
  completionReportOperationSchema,
  notificationPreferenceInputSchema,
  type CompletionCallbackProviderEvent,
  type CompletionCallbackRequestResult,
  type CompletionProviderActionResult,
  type CompletionReportOperation,
  type NotificationPreference,
  type NotificationPreferenceInput,
  type RegisteredTelephone,
} from "@voice-agent/contracts";
import type {
  CompletionCallbackOutcomeRecord,
  DurableTaskStore,
  NotificationDeliveryRecord,
  TaskContinuityStore,
} from "@voice-agent/durable-store";

const completionCallbackLeaseMs = 150_000;
const silentNotificationLeaseMs = 30_000;
const completionResumptionGraceMs = 15_000;
const ordinaryEvidenceRetentionMs = 90 * 24 * 60 * 60 * 1_000;
const disconnectText =
  "I’ll keep working and call your registered telephone once this task finishes." as const;
const voicemailText =
  "Your Voice Agent task has finished. Open the secure app for details." as const;

export interface TaskContinuityRuntime {
  applyEvidenceLifecyclePolicy(): Promise<{ readonly cutoff: string }>;
  claimImmediateCompletionResumption(input: {
    readonly operationId: string;
    readonly taskId: string;
  }): Promise<boolean>;
  close(): Promise<void>;
  configureNotification(
    input: NotificationPreferenceInput,
  ): Promise<NotificationPreference>;
  getNotificationPreference(): Promise<NotificationPreference | undefined>;
  processNextReport(): Promise<CompletionReportOperation | undefined>;
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
  requestCompletionCallback(input: {
    readonly requestId: string;
    readonly taskId: string;
    readonly telephone: RegisteredTelephone;
    readonly telephoneSessionId: string;
  }): Promise<CompletionCallbackRequestResult>;
  requestSessionFailureNotification(input: {
    readonly callbackOperationId: string;
    readonly failureEventId: string;
    readonly occurredAt: string;
  }): Promise<void>;
  runEvidenceLifecyclePolicy(): Promise<{ readonly cutoff: string } | undefined>;
}

export function createTaskContinuityRuntime(options: {
  readonly administrativeEvidenceRetention?: {
    applyEvidenceRetention(input: { readonly cutoff: string }): Promise<void>;
  };
  readonly callbackEvidenceRetention?: {
    applyEvidenceRetention(input: { readonly cutoff: string }): Promise<void>;
  };
  readonly evidenceOrigin?: string;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly store: TaskContinuityStore;
  readonly tasks: DurableTaskStore;
}): TaskContinuityRuntime {
  const evidenceOrigin = options.evidenceOrigin ?? "https://voice.stephens.page";

  async function appendCallbackOutcomeEvidence(
    record: CompletionCallbackOutcomeRecord,
    resumptionCompleted = false,
  ): Promise<void> {
    const authentication =
      "authentication" in record.event
        ? record.event.authentication
        : undefined;
    await options.tasks.appendEvidence({
      event: {
        details: {
          humanDetected:
            record.event.outcome === "authorized" ||
            authentication?.answer === "human",
          operationId: record.event.operationId,
          outcome: record.event.outcome,
          receivedDtmfOne:
            record.event.outcome === "authorized" ||
            authentication?.digit === "1",
          ...(record.resumedTelephoneSessionId === undefined
            ? {}
            : {
                resumedTelephoneSessionId:
                  record.resumedTelephoneSessionId,
              }),
        },
        id: record.outcomeEventId,
        kind: "completion.callback.outcome",
        occurredAt: record.occurredAt,
        summary:
          record.event.outcome === "authorized"
            ? "The Completion Callback authenticated and authorized resumption of this Durable Task."
            : "The Completion Callback ended without authenticated resumption.",
      },
      taskId: record.taskId,
      updatedAt: record.occurredAt,
    });
    if (
      record.resumptionOperationId !== undefined &&
      record.resumptionAcceptedEventId !== undefined
    ) {
      await options.tasks.appendEvidence({
        event: {
          details: { operationId: record.resumptionOperationId },
          id: record.resumptionAcceptedEventId,
          kind: "operation.accepted",
          occurredAt: record.occurredAt,
          summary: "The authenticated Completion Callback resumption Operation was accepted.",
        },
        taskId: record.taskId,
        updatedAt: record.occurredAt,
      });
    }
    if (
      resumptionCompleted &&
      record.resumptionOperationId !== undefined &&
      record.resumptionCompletedEventId !== undefined
    ) {
      const completedAt = record.resumptionCompletedAt ?? options.now();
      await options.tasks.appendEvidence({
        event: {
          details: { operationId: record.resumptionOperationId },
          id: record.resumptionCompletedEventId,
          kind: "operation.completed",
          occurredAt: completedAt,
          summary: "The Completion Callback resumption Operation attached to the existing Durable Task.",
        },
        taskId: record.taskId,
        updatedAt: completedAt,
      });
    }
    await options.tasks.appendEvidence({
      event: {
        details: { operationId: record.event.operationId },
        id: record.completedEventId,
        kind: "operation.completed",
        occurredAt: record.occurredAt,
        summary: "The Completion Callback Operation reached a terminal outcome.",
      },
      taskId: record.taskId,
      updatedAt: record.occurredAt,
    });
    if (
      record.notificationOperationId !== undefined &&
      record.notificationRequestedEventId !== undefined
    ) {
      await options.tasks.appendEvidence({
        event: {
          details: { operationId: record.notificationOperationId },
          id: record.notificationRequestedEventId,
          kind: "notification.requested",
          occurredAt: record.occurredAt,
          summary: "A generic Silent Notification was requested.",
        },
        taskId: record.taskId,
        updatedAt: record.occurredAt,
      });
    }
  }

  async function appendNotificationEvidence(
    record: NotificationDeliveryRecord,
  ): Promise<void> {
    await options.tasks.appendEvidence({
      event: {
        details: { operationId: record.operationId },
        id: record.sentEventId,
        kind: "notification.sent",
        occurredAt: record.occurredAt,
        summary: "A generic Silent Notification was sent.",
      },
      taskId: record.taskId,
      updatedAt: record.occurredAt,
    });
    await options.tasks.appendEvidence({
      event: {
        details: { operationId: record.operationId },
        id: record.completedEventId,
        kind: "operation.completed",
        occurredAt: record.occurredAt,
        summary: "The Silent Notification Operation completed.",
      },
      taskId: record.taskId,
      updatedAt: record.occurredAt,
    });
  }

  async function pruneOrdinaryEvidence(): Promise<{ readonly cutoff: string }> {
    const cutoff = new Date(
      new Date(options.now()).getTime() - ordinaryEvidenceRetentionMs,
    ).toISOString();
    await options.tasks.applyEvidenceRetention({ cutoff });
    await options.callbackEvidenceRetention?.applyEvidenceRetention({ cutoff });
    await options.administrativeEvidenceRetention?.applyEvidenceRetention({
      cutoff,
    });
    return { cutoff };
  }

  return {
    async applyEvidenceLifecyclePolicy() {
      await options.store.activateEvidenceLifecyclePolicy(options.now());
      return pruneOrdinaryEvidence();
    },
    async claimImmediateCompletionResumption(input) {
      const claimedAt = options.now();
      return options.store.claimImmediateCompletionResumption({
        claimedAt,
        leaseExpiresAt: new Date(
          new Date(claimedAt).getTime() + completionCallbackLeaseMs,
        ).toISOString(),
        operationId: input.operationId,
        taskId: input.taskId,
      });
    },
    close: () => options.store.close(),
    configureNotification(input) {
      return options.store.configureNotification(
        notificationPreferenceInputSchema.parse(input),
        options.now(),
      );
    },
    getNotificationPreference: () => options.store.findNotificationPreference(),
    async processNextReport() {
      const claimedAt = options.now();
      const claimed = await options.store.claimNextReport({
        claimedAt,
        callbackLeaseExpiresAt: new Date(
          new Date(claimedAt).getTime() + completionCallbackLeaseMs,
        ).toISOString(),
        notificationLeaseExpiresAt: new Date(
          new Date(claimedAt).getTime() + silentNotificationLeaseMs,
        ).toISOString(),
      });
      if (claimed === undefined) return undefined;
      if (claimed.kind === "callback") {
        return completionReportOperationSchema.parse({
          destination: claimed.telephone.telephoneNumber,
          effectId: claimed.operationId,
          from: claimed.telephone.telnyxNumber,
          kind: "place-completion-callback",
          livekitOutboundTrunkId: claimed.telephone.livekitOutboundTrunkId,
          operationId: claimed.operationId,
          taskId: claimed.taskId,
          telephoneSessionId: claimed.telephoneSessionId,
        });
      }
      if (claimed.kind === "resumption") {
        return completionReportOperationSchema.parse({
          callbackOperationId: claimed.callbackOperationId,
          effectId: claimed.operationId,
          kind: "resume-completion-callback",
          operationId: claimed.operationId,
          taskId: claimed.taskId,
          telephoneSessionId: claimed.telephoneSessionId,
        });
      }
      const evidenceRecordUrl = `${evidenceOrigin}/?task=${encodeURIComponent(claimed.taskId)}`;
      return completionReportOperationSchema.parse({
        clickTracking: false,
        evidenceRecordUrl,
        from: claimed.preference.from,
        idempotencyKey: claimed.operationId,
        kind: "send-silent-notification",
        openTracking: false,
        operationId: claimed.operationId,
        subject: "Voice Agent task update",
        taskId: claimed.taskId,
        text: `A Voice Agent task reached a terminal state. View it securely at ${evidenceRecordUrl}`,
        to: claimed.preference.email,
      });
    },
    async receiveCompletionCallbackEvent(untrustedEvent) {
      const event = completionCallbackProviderEventSchema.parse(untrustedEvent);
      const existing = await options.store.findCompletionCallbackOutcome(
        event.deliveryId,
      );
      if (existing !== undefined) {
        await appendCallbackOutcomeEvidence(existing);
        if (
          existing.event.deliveryId === event.deliveryId &&
          existing.event.outcome === "authorized" &&
          existing.resumedTelephoneSessionId !== undefined &&
          existing.resumptionOperationId !== undefined &&
          (await options.store.isCompletionResumptionPending(
            existing.event.operationId,
          ))
        ) {
          return completionProviderActionResultSchema.parse({
            actions: [
              {
                effectId: existing.resumptionOperationId,
                kind: "resume-existing-task",
                taskId: existing.taskId,
                telephoneSessionId: existing.resumedTelephoneSessionId,
              },
            ],
          });
        }
        return { actions: [] };
      }
      const taskId = await options.store.findTaskIdByReportOperation(
        event.operationId,
      );
      if (taskId === undefined) {
        throw new Error("Completion Callback Operation is unavailable");
      }
      const authorized = event.outcome === "authorized";
      const occurredAt = options.now();
      const outcomeEventId = options.nextId();
      const completedEventId = options.nextId();
      const notificationOperationId = authorized ? undefined : options.nextId();
      const notificationRequestedEventId = authorized
        ? undefined
        : options.nextId();
      const resumedTelephoneSessionId = authorized
        ? options.nextId()
        : undefined;
      const resumptionLeaseExpiresAt = authorized
        ? new Date(
            new Date(occurredAt).getTime() + completionResumptionGraceMs,
          ).toISOString()
        : undefined;
      const resumptionOperationId = authorized ? options.nextId() : undefined;
      const resumptionAcceptedEventId = authorized ? options.nextId() : undefined;
      const resumptionCompletedEventId = authorized ? options.nextId() : undefined;
      const applied = await options.store.applyCompletionCallbackOutcome({
        completedEventId,
        event,
        ...(notificationOperationId === undefined
          ? {}
          : { notificationOperationId }),
        ...(notificationRequestedEventId === undefined
          ? {}
          : { notificationRequestedEventId }),
        occurredAt,
        outcomeEventId,
        ...(resumedTelephoneSessionId === undefined
          ? {}
          : { resumedTelephoneSessionId }),
        ...(resumptionLeaseExpiresAt === undefined
          ? {}
          : { resumptionLeaseExpiresAt }),
        ...(resumptionOperationId === undefined
          ? {}
          : { resumptionOperationId }),
        ...(resumptionAcceptedEventId === undefined
          ? {}
          : { resumptionAcceptedEventId }),
        ...(resumptionCompletedEventId === undefined
          ? {}
          : { resumptionCompletedEventId }),
        taskId,
      });
      await appendCallbackOutcomeEvidence(applied.record);
      if (applied.duplicate) return { actions: [] };
      if (event.outcome === "voicemail") {
        return completionProviderActionResultSchema.parse({
          actions: [
            {
              effectId: `${event.operationId}:voicemail`,
              kind: "play-completion-voicemail-and-end",
              text: voicemailText,
            },
          ],
        });
      }
      if (
        event.outcome === "authorized" &&
        applied.record.resumedTelephoneSessionId !== undefined &&
        applied.record.resumptionOperationId !== undefined
      ) {
        return completionProviderActionResultSchema.parse({
          actions: [
            {
              effectId: applied.record.resumptionOperationId,
              kind: "resume-existing-task",
              taskId,
              telephoneSessionId: applied.record.resumedTelephoneSessionId,
            },
          ],
        });
      }
      return { actions: [] };
    },
    async recordNotificationDelivery(input) {
      const existing = await options.store.findNotificationDelivery(
        input.deliveryId,
      );
      if (existing !== undefined) {
        await appendNotificationEvidence(existing);
        return;
      }
      const taskId = await options.store.findTaskIdByReportOperation(
        input.operationId,
      );
      if (taskId === undefined) {
        throw new Error("Silent Notification Operation is unavailable");
      }
      const record = await options.store.completeNotification({
        completedEventId: options.nextId(),
        deliveryId: input.deliveryId,
        occurredAt: options.now(),
        operationId: input.operationId,
        providerMessageId: input.providerMessageId,
        sentEventId: options.nextId(),
        taskId,
      });
      await appendNotificationEvidence(record.record);
    },
    async recordCompletionResumption(input) {
      const record = await options.store.completeCompletionResumption(
        input.operationId,
        options.now(),
      );
      if (record !== undefined) await appendCallbackOutcomeEvidence(record, true);
    },
    async requestCompletionCallback(input) {
      const preference = await options.store.findNotificationPreference();
      if (preference === undefined) {
        throw new Error("Silent Notification preference is unavailable");
      }
      const existing = await options.store.findCompletionCallbackRequest(
        input.requestId,
      );
      const reportId = existing === undefined ? options.nextId() : undefined;
      const operationId = existing === undefined ? options.nextId() : undefined;
      const requestedEventId =
        existing === undefined ? options.nextId() : undefined;
      const snapshot =
        existing ??
        (await options.store.persistCompletionCallbackRequest({
          operationId: requireId(operationId),
          preferenceRevision: preference.revision,
          reportId: requireId(reportId),
          requestId: input.requestId,
          requestedAt: options.now(),
          requestedEventId: requireId(requestedEventId),
          taskId: input.taskId,
          telephone: input.telephone,
          telephoneSessionId: input.telephoneSessionId,
        }));
      await options.tasks.appendEvidence({
        event: {
          details: {
            operationId: snapshot.operationId,
            telephoneSessionId: snapshot.telephoneSessionId,
          },
          id: snapshot.requestedEventId,
          kind: "completion.callback.requested",
          occurredAt: snapshot.requestedAt,
          summary: "A Completion Callback was requested for this Durable Task.",
        },
        taskId: snapshot.taskId,
        updatedAt: snapshot.requestedAt,
      });
      return completionCallbackRequestResultSchema.parse({
        disposition: "disconnect",
        text: disconnectText,
      });
    },
    async requestSessionFailureNotification(input) {
      const taskId = await options.store.findTaskIdByReportOperation(
        input.callbackOperationId,
      );
      if (taskId === undefined) {
        throw new Error("Completion Callback Operation is unavailable");
      }
      const requested = await options.store.requestSessionFailureNotification({
        callbackOperationId: input.callbackOperationId,
        notificationOperationId: options.nextId(),
        occurredAt: input.occurredAt,
        taskId,
      });
      await options.tasks.appendEvidence({
        event: {
          details: { operationId: requested.notificationOperationId },
          id: `${input.failureEventId}:notification-requested`,
          kind: "notification.requested",
          occurredAt: input.occurredAt,
          summary: "A generic Silent Notification was requested after a resumed-session provider failure.",
        },
        taskId,
        updatedAt: input.occurredAt,
      });
      if (
        requested.resumptionOperationId !== undefined &&
        requested.resumptionCompletedEventId !== undefined
      ) {
        await options.tasks.appendEvidence({
          event: {
            details: { operationId: requested.resumptionOperationId },
            id: requested.resumptionCompletedEventId,
            kind: "operation.completed",
            occurredAt: input.occurredAt,
            summary: "The Completion Callback resumption Operation ended at a safe failure boundary.",
          },
          taskId,
          updatedAt: input.occurredAt,
        });
      }
    },
    async runEvidenceLifecyclePolicy() {
      if (!(await options.store.isEvidenceLifecyclePolicyActive())) {
        return undefined;
      }
      return pruneOrdinaryEvidence();
    },
  };
}

function requireId(id: string | undefined): string {
  if (id === undefined) throw new Error("Missing durable identifier");
  return id;
}
