import type {
  CallAdmissionPauseReason,
  CallAdmissionRecord,
} from "@voice-agent/contracts";

export type {
  CallAdmissionPauseReason,
  CallAdmissionRecord,
  CallAdmissionState,
} from "@voice-agent/contracts";

/**
 * Unsettled work at the moment a Self-Promotion looks for its Promotion Safe
 * Point. `kind` is the Operation kind, which is what declares whether the work
 * may be carried across the switch.
 */
export interface UnsettledOperation {
  readonly id: string;
  readonly kind: string;
  readonly status: "accepted" | "running";
  readonly taskId: string;
}

/**
 * The durable state a Self-Promotion reads and writes. It is durable rather
 * than in-process precisely because the switch restarts the process: admission
 * must stay closed across the restart and reopen only once a healthy runtime
 * has been confirmed.
 */
export interface SelfPromotionStore {
  close(): Promise<void>;
  findActiveTelephoneSessionIds(): Promise<readonly string[]>;
  findUnsettledOperations(): Promise<readonly UnsettledOperation[]>;
  /**
   * Sessions reserved but not yet live. An admission granted before the gate
   * closed is still an admission, so the safe point waits for these too rather
   * than letting one activate into a call the switch would then interrupt.
   */
  findWarmTelephoneSessionIds(): Promise<readonly string[]>;
  pauseCallAdmission(input: {
    readonly changedAt: string;
    readonly commit: string;
    readonly promotionId: string;
    readonly reason: CallAdmissionPauseReason;
  }): Promise<CallAdmissionRecord>;
  readCallAdmission(): Promise<CallAdmissionRecord>;
  reopenCallAdmission(input: {
    readonly changedAt: string;
  }): Promise<CallAdmissionRecord>;
}
