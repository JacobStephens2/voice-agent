import type {
  KeeploreDelegationBrief,
  KeeploreDelegationRecord,
  KeeploreDelegationResult,
  KeeploreWorktree,
} from "@voice-agent/contracts";

export interface AcceptedKeeploreDelegation {
  readonly brief: KeeploreDelegationBrief;
  readonly worktree: KeeploreWorktree;
}

export interface KeeploreDelegationStore {
  claimNext(input: { readonly claimedAt: string }): Promise<
    | {
        readonly brief: KeeploreDelegationBrief;
        readonly stopRequested: boolean;
        readonly worktree: KeeploreWorktree;
      }
    | undefined
  >;
  close(): void;
  complete(input: {
    readonly completedAt: string;
    readonly result: KeeploreDelegationResult;
    readonly taskId: string;
  }): Promise<KeeploreDelegationRecord>;
  findByTaskId(taskId: string): Promise<KeeploreDelegationRecord | undefined>;
  list(): Promise<readonly KeeploreDelegationRecord[]>;
  persistAccepted(
    input: AcceptedKeeploreDelegation,
  ): Promise<KeeploreDelegationRecord>;
  requestStop(input: {
    readonly requestedAt: string;
    readonly taskId: string;
  }): Promise<KeeploreDelegationRecord | undefined>;
  stopRequested(taskId: string): Promise<boolean>;
}
