import type {
  CallbackActionResult,
  CallbackHandshakeSnapshot,
  InboundTelephoneResult,
  RegisteredTelephone,
  RegisteredTelephoneInput,
  TelephoneEvidenceRecordSummary,
  TelephoneSessionEvidenceRecordProjection,
} from "@voice-agent/contracts";

export type CallbackDeliveryResult =
  | CallbackActionResult
  | InboundTelephoneResult;

export interface CallbackHandshakeOperationalMetrics {
  readonly attempts: number;
  readonly handshakes: {
    readonly authorized: number;
    readonly failed: number;
    readonly pending: number;
  };
}

export interface CreateCallbackHandshakePersistence {
  readonly acceptedAt: string;
  readonly deliveryId: string;
  readonly maximumAcceptedInWindow: number;
  readonly projection: TelephoneSessionEvidenceRecordProjection;
  readonly rateLimitCutoff: string;
  readonly rateLimitedResult: InboundTelephoneResult;
  readonly result: InboundTelephoneResult;
  readonly snapshot: CallbackHandshakeSnapshot;
}

export type CreateCallbackHandshakeResult =
  | { readonly kind: "created"; readonly result: InboundTelephoneResult }
  | { readonly kind: "duplicate"; readonly result: CallbackDeliveryResult }
  | { readonly kind: "rate-limited"; readonly result: InboundTelephoneResult };

export interface ApplyCallbackTransitionPersistence {
  readonly deliveryId: string;
  readonly expectedRevision: number;
  readonly projection: TelephoneSessionEvidenceRecordProjection;
  readonly result: CallbackActionResult;
  readonly snapshot: CallbackHandshakeSnapshot;
}

export type ApplyCallbackTransitionResult =
  | { readonly kind: "applied"; readonly result: CallbackActionResult }
  | { readonly kind: "conflict" }
  | { readonly kind: "duplicate"; readonly result: CallbackDeliveryResult };

export interface CallbackHandshakeStore {
  applyTransition(
    input: ApplyCallbackTransitionPersistence,
  ): Promise<ApplyCallbackTransitionResult>;
  claimCallbackPlacement(
    effectId: string,
    handshakeId: string,
  ): Promise<boolean>;
  close(): Promise<void>;
  createHandshake(
    input: CreateCallbackHandshakePersistence,
  ): Promise<CreateCallbackHandshakeResult>;
  findDelivery(deliveryId: string): Promise<CallbackDeliveryResult | undefined>;
  findDueRetries(now: string): Promise<readonly CallbackHandshakeSnapshot[]>;
  findEvidenceRecord(
    handshakeId: string,
  ): Promise<TelephoneSessionEvidenceRecordProjection | undefined>;
  findHandshake(
    handshakeId: string,
  ): Promise<CallbackHandshakeSnapshot | undefined>;
  listEvidenceRecords(): Promise<readonly TelephoneEvidenceRecordSummary[]>;
  readOperationalMetrics(): Promise<CallbackHandshakeOperationalMetrics>;
  findRegisteredTelephone(): Promise<RegisteredTelephone | undefined>;
  findRegisteredTelephoneRevision(
    revision: number,
  ): Promise<RegisteredTelephone | undefined>;
  persistRejectedDelivery(
    deliveryId: string,
    result: InboundTelephoneResult,
  ): Promise<InboundTelephoneResult>;
  registerTelephone(
    input: RegisteredTelephoneInput,
    registeredAt: string,
  ): Promise<RegisteredTelephone>;
}
