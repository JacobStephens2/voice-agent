import type {
  CompletionCallbackProviderEvent,
  NotificationPreference,
  NotificationPreferenceInput,
  RegisteredTelephone,
} from "@voice-agent/contracts";

export interface CompletionCallbackRequestSnapshot {
  readonly operationId: string;
  readonly preferenceRevision: number;
  readonly reportId: string;
  readonly requestId: string;
  readonly requestedEventId: string;
  readonly requestedAt: string;
  readonly taskId: string;
  readonly telephone: RegisteredTelephone;
  readonly telephoneSessionId: string;
}

export interface ClaimedCompletionCallback {
  readonly kind: "callback";
  readonly operationId: string;
  readonly taskId: string;
  readonly telephone: RegisteredTelephone;
  readonly telephoneSessionId: string;
}

export interface ClaimedSilentNotification {
  readonly kind: "notification";
  readonly operationId: string;
  readonly preference: NotificationPreference;
  readonly taskId: string;
}

export interface ClaimedCompletionResumption {
  readonly callbackOperationId: string;
  readonly kind: "resumption";
  readonly operationId: string;
  readonly taskId: string;
  readonly telephoneSessionId: string;
}

export type ClaimedCompletionReport =
  | ClaimedCompletionCallback
  | ClaimedCompletionResumption
  | ClaimedSilentNotification;

export interface CompletionCallbackOutcomeRecord {
  readonly completedEventId: string;
  readonly event: CompletionCallbackProviderEvent;
  readonly notificationOperationId?: string;
  readonly notificationRequestedEventId?: string;
  readonly occurredAt: string;
  readonly outcomeEventId: string;
  readonly resumedTelephoneSessionId?: string;
  readonly resumptionLeaseExpiresAt?: string;
  readonly resumptionAcceptedEventId?: string;
  readonly resumptionCompletedAt?: string;
  readonly resumptionCompletedEventId?: string;
  readonly resumptionOperationId?: string;
  readonly taskId: string;
}

export interface NotificationDeliveryRecord {
  readonly completedEventId: string;
  readonly deliveryId: string;
  readonly occurredAt: string;
  readonly operationId: string;
  readonly providerMessageId: string;
  readonly sentEventId: string;
  readonly taskId: string;
}

export interface TaskContinuityStore {
  activateEvidenceLifecyclePolicy(activatedAt: string): Promise<void>;
  applyCompletionCallbackOutcome(
    record: CompletionCallbackOutcomeRecord,
  ): Promise<{
    readonly duplicate: boolean;
    readonly record: CompletionCallbackOutcomeRecord;
  }>;
  claimNextReport(input: {
    readonly claimedAt: string;
    readonly callbackLeaseExpiresAt: string;
    readonly notificationLeaseExpiresAt: string;
  }): Promise<ClaimedCompletionReport | undefined>;
  claimCompletionCallbackPlacement(
    effectId: string,
    taskId: string,
  ): Promise<boolean>;
  claimImmediateCompletionResumption(input: {
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
    readonly operationId: string;
    readonly taskId: string;
  }): Promise<boolean>;
  close(): Promise<void>;
  completeNotification(
    record: NotificationDeliveryRecord,
  ): Promise<{
    readonly duplicate: boolean;
    readonly record: NotificationDeliveryRecord;
  }>;
  completeCompletionResumption(
    operationId: string,
    occurredAt: string,
  ): Promise<CompletionCallbackOutcomeRecord | undefined>;
  configureNotification(
    input: NotificationPreferenceInput,
    configuredAt: string,
  ): Promise<NotificationPreference>;
  findCompletionCallbackOutcome(
    deliveryId: string,
  ): Promise<CompletionCallbackOutcomeRecord | undefined>;
  findCompletionCallbackRequest(
    requestId: string,
  ): Promise<CompletionCallbackRequestSnapshot | undefined>;
  findNotificationDelivery(
    deliveryId: string,
  ): Promise<NotificationDeliveryRecord | undefined>;
  findTaskIdByReportOperation(operationId: string): Promise<string | undefined>;
  findNotificationPreference(): Promise<NotificationPreference | undefined>;
  isCompletionResumptionPending(operationId: string): Promise<boolean>;
  isEvidenceLifecyclePolicyActive(): Promise<boolean>;
  persistCompletionCallbackRequest(
    snapshot: CompletionCallbackRequestSnapshot,
  ): Promise<CompletionCallbackRequestSnapshot>;
  requestSessionFailureNotification(input: {
    readonly callbackOperationId: string;
    readonly notificationOperationId: string;
    readonly occurredAt: string;
    readonly taskId: string;
  }): Promise<{
    readonly notificationOperationId: string;
    readonly resumptionCompletedEventId?: string;
    readonly resumptionOperationId?: string;
  }>;
}
