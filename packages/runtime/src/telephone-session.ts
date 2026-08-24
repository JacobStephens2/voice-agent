import {
  telephoneSessionActionResultSchema,
  telephoneSessionProviderEventSchema,
  telephoneTurnInterpretationSchema,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
  type FinalizedTelephoneTurn,
  type KeeploreDelegationRecord,
  type TelephoneConversationEvidenceEvent,
  type TelephoneProviderFailureRecovery,
  type TelephoneProviderFailureStage,
  type TelephoneSessionActionResult,
  type TelephoneSessionProviderEvent,
  type TelephoneTurnInterpretation,
} from "@voice-agent/contracts";
import type { TelephoneBoundaryDecision } from "@voice-agent/durable-store";
import {
  classifyConfirmationSpeech,
  transcriptReportsBountywellOutage,
} from "@voice-agent/policy";

export interface TelephoneTurnInterpreter {
  interpret(input: {
    readonly telephoneSessionId: string;
    readonly text: string;
    readonly turnId: string;
  }): Promise<TelephoneTurnInterpretation>;
}

interface TelephoneBountywellTasks {
  appendTelephoneEvidence(input: {
    readonly event: Omit<EvidenceEventProjection, "sequence">;
    readonly taskId: string;
  }): Promise<EvidenceRecordProjection>;
  presentBountywellOutage?(): Promise<
    { readonly taskId: string } | undefined
  >;
  processNextBountywellOutageRecovery?(): Promise<EvidenceRecordProjection | undefined>;
  submitTelephoneBountywellHealthInquiry(input: {
    readonly interpretation: TelephoneTurnInterpretation;
    readonly sanitizedTranscript: string;
    readonly turn: FinalizedTelephoneTurn;
  }): Promise<EvidenceRecordProjection>;
  requestStop?(input: {
    readonly requestId: string;
    readonly taskId: string;
  }): Promise<EvidenceRecordProjection>;
}

interface TelephoneKeeploreDelegations {
  accept(input: { readonly requestId: string }): Promise<KeeploreDelegationRecord>;
  get(taskId: string): Promise<KeeploreDelegationRecord | undefined>;
  list(): Promise<readonly KeeploreDelegationRecord[]>;
  requestStop(taskId: string): Promise<KeeploreDelegationRecord | undefined>;
}

export interface TelephoneSessionCoordinator {
  receiveProviderEvent(
    event: TelephoneSessionProviderEvent,
  ): Promise<TelephoneSessionActionResult>;
}

export interface TelephoneSessionEvidenceSink {
  append(
    event: Omit<TelephoneConversationEvidenceEvent, "sequence">,
  ): Promise<void>;
  requestFailureNotification?(input: {
    readonly failureEventId: string;
    readonly occurredAt: string;
  }): Promise<void>;
}

interface TelephoneSessionCoordinatorOptions {
  readonly activeTaskId?: string;
  readonly interpreter: TelephoneTurnInterpreter;
  readonly keeploreDelegations?: TelephoneKeeploreDelegations;
  readonly sessionEvidence?: TelephoneSessionEvidenceSink;
  readonly stateChangingTasks?: {
    claim(
      telephoneSessionId: string,
      taskId: string,
    ): Promise<TelephoneBoundaryDecision>;
    release(
      telephoneSessionId: string,
      taskId: string,
    ): Promise<{ readonly promotedOwnerId?: string }>;
  };
  readonly tasks: TelephoneBountywellTasks;
}

interface TelephoneSessionCoordinatorState {
  activeKeeploreTaskId: string | undefined;
  lastFinalizedTurnId: string | undefined;
  pendingCompletionOfferTaskId: string | undefined;
  pendingStateChangingDiscussionId: string | undefined;
  pendingStateChangingKind: "keeplore-button-trial" | "outage" | "other" | undefined;
  providerRetryUsed: boolean;
  terminalFailureIssued: boolean;
}

interface FinalizedTurnResult {
  readonly processing: Promise<TelephoneSessionActionResult>;
  readonly sanitizedTranscript: string;
}

export function createTelephoneSessionCoordinator(
  options: TelephoneSessionCoordinatorOptions,
): TelephoneSessionCoordinator {
  const finalizedTurnResults = new Map<string, FinalizedTurnResult>();
  const state: TelephoneSessionCoordinatorState = {
    activeKeeploreTaskId: undefined,
    lastFinalizedTurnId: undefined,
    pendingCompletionOfferTaskId: undefined,
    pendingStateChangingDiscussionId: undefined,
    pendingStateChangingKind: undefined,
    providerRetryUsed: false,
    terminalFailureIssued: false,
  };
  return {
    async receiveProviderEvent(untrustedEvent) {
      const event = telephoneSessionProviderEventSchema.parse(untrustedEvent);
      if (event.kind === "turn-finalized") {
        const sanitizedTranscript = sanitizeFinalizedTurn(event.transcript);
        const existing = finalizedTurnResults.get(event.turnId);
        if (existing !== undefined) {
          const result = await existing.processing;
          if (existing.sanitizedTranscript !== sanitizedTranscript) {
            const spoken = result.actions.find(
              (action) => action.kind === "speak-semantic-response",
            );
            // Two different transcripts under one durable turn identity is a
            // recognition integrity fault rather than a transient one, so it
            // is never spent on the session's single retry.
            return recordProviderFailure(
              options,
              state,
              {
                deliveryId: event.deliveryId,
                occurredAt: event.occurredAt,
                recovery: "terminal",
                ...(spoken === undefined ? {} : { taskId: spoken.taskId }),
              },
              {
                failure: "unavailable",
                provider: event.stt.provider,
                stage: "stt",
              },
            );
          }
          return telephoneSessionActionResultSchema.parse({ actions: [] });
        }
        const processing = handleFinalizedTurn(
          options,
          state,
          event,
          sanitizedTranscript,
        );
        finalizedTurnResults.set(event.turnId, {
          processing,
          sanitizedTranscript,
        });
        try {
          return await processing;
        } catch (error) {
          if (
            finalizedTurnResults.get(event.turnId)?.processing === processing
          ) {
            finalizedTurnResults.delete(event.turnId);
          }
          throw error;
        }
      }
      if (event.kind === "speech-hypothesis") {
        return telephoneSessionActionResultSchema.parse({ actions: [] });
      }
      if (event.kind === "response-interrupted") {
        const evidence = {
          details: {
            durationMs: event.durationMs,
            responseId: event.responseId,
          },
          id: `${event.deliveryId}:interruption`,
          kind: "telephone.response.interrupted" as const,
          occurredAt: event.occurredAt,
          summary: "The caller interrupted semantic speech.",
        };
        await options.sessionEvidence?.append(evidence);
        if (event.taskId !== undefined) {
          await options.tasks.appendTelephoneEvidence({
            event: evidence,
            taskId: event.taskId,
          });
        }
        return telephoneSessionActionResultSchema.parse({ actions: [] });
      }
      if (event.kind === "provider-timing") {
        const evidence = {
          details: {
            durationMs: event.durationMs,
            outcome: "completed" as const,
            provider: event.provider,
            stage: event.stage,
          },
          id: `${event.deliveryId}:timing`,
          kind: "telephone.provider.timing" as const,
          occurredAt: event.occurredAt,
          summary: "Bounded speech-provider timing was recorded.",
        };
        await options.sessionEvidence?.append(evidence);
        if (event.taskId !== undefined) {
          await options.tasks.appendTelephoneEvidence({
            event: evidence,
            taskId: event.taskId,
          });
        }
        return telephoneSessionActionResultSchema.parse({ actions: [] });
      }
      if (event.kind === "provider-timeout") {
        return recordProviderFailure(
          options,
          state,
          event,
          {
            failure: "timeout",
            provider: event.provider,
            stage: event.stage,
            timeoutMs: event.timeoutMs,
          },
        );
      }
      if (event.kind === "provider-failure") {
        return recordProviderFailure(
          options,
          state,
          event,
          {
            failure: event.failure,
            provider: event.provider,
            stage: event.stage,
          },
        );
      }
      throw new Error("Unsupported Telephone Session provider event");
    },
  };
}

async function handleFinalizedTurn(
  options: TelephoneSessionCoordinatorOptions,
  state: TelephoneSessionCoordinatorState,
  turn: FinalizedTelephoneTurn,
  sanitizedTranscript: string,
): Promise<TelephoneSessionActionResult> {
  state.lastFinalizedTurnId = turn.turnId;
  await options.sessionEvidence?.append({
    details: {
      telephoneSessionId: turn.telephoneSessionId,
      text: sanitizedTranscript,
      turnId: turn.turnId,
    },
    id: `${turn.turnId}:turn`,
    kind: "telephone.turn.finalized",
    occurredAt: turn.occurredAt,
    summary: "A finalized sanitized telephone turn was accepted.",
  });
  await options.sessionEvidence?.append({
    details: {
      durationMs: turn.stt.durationMs,
      outcome: "completed",
      provider: turn.stt.provider,
      stage: "stt",
    },
    id: `${turn.turnId}:stt`,
    kind: "telephone.provider.timing",
    occurredAt: turn.occurredAt,
    summary: "Final speech recognition timing was recorded.",
  });
  if (state.pendingStateChangingDiscussionId !== undefined) {
    const discussionId = state.pendingStateChangingDiscussionId;
    const discussionKind = state.pendingStateChangingKind;
    const speech = classifyConfirmationSpeech(sanitizedTranscript);
    if (speech === "ambiguous") {
      // The same Task Confirmation stays pending and keeps its claimed
      // state-changing slot, so unreadable speech costs the owner a repetition
      // rather than the decision itself.
      return guidance(
        options,
        turn,
        "I did not catch that. The same Task Confirmation is still pending. Please say yes to confirm it or no to decline it.",
      );
    }
    state.pendingStateChangingDiscussionId = undefined;
    state.pendingStateChangingKind = undefined;
    await options.stateChangingTasks?.release(
      turn.telephoneSessionId,
      discussionId,
    );
    if (speech === "negative") {
      return guidance(
        options,
        turn,
        "Okay. I did not confirm that state-changing task.",
      );
    }
    if (discussionKind === "keeplore-button-trial") {
      if (options.keeploreDelegations === undefined) {
        return guidance(
          options,
          turn,
          "The registered Keeplore Delegation runner is unavailable.",
        );
      }
      const record = await options.keeploreDelegations.accept({
        requestId: `telephone:${turn.turnId}`,
      });
      state.activeKeeploreTaskId = record.task.id;
      const responseId = `${turn.turnId}:delegation-response`;
      return telephoneSessionActionResultSchema.parse({
        actions: [
          {
            interruptible: true,
            kind: "speak-semantic-response",
            responseId,
            taskId: record.task.id,
            text:
              "The Keeplore Button Trial is confirmed and delegated to restricted Codex on a non-production branch. I’ll report its verified pull request without merging or deploying it.",
          },
        ],
      });
    }
    // Only the presented unavailable-API drill recovers from an affirmative
    // Task Confirmation. Presenting here, after the confirmation, keeps the
    // fault report and the owner's consent on the same Durable Task.
    const presented =
      discussionKind === "outage"
        ? await options.tasks.presentBountywellOutage?.()
        : undefined;
    const recovered =
      presented === undefined
        ? undefined
        : await options.tasks.processNextBountywellOutageRecovery?.();
    if (recovered === undefined) {
      return guidance(
        options,
        turn,
        "Task confirmation recorded. Use the secure app to authorize execution.",
      );
    }
    const responseId = `${turn.turnId}:outage-response`;
    const text = semanticOutageAnswer(recovered);
    await options.tasks.appendTelephoneEvidence({
      event: {
        details: { responseId, text },
        id: responseId,
        kind: "telephone.semantic.response",
        occurredAt: recovered.task.updatedAt,
        summary: "A semantic telephone recovery response was prepared for speech.",
      },
      taskId: recovered.task.id,
    });
    return telephoneSessionActionResultSchema.parse({
      actions: [
        {
          interruptible: true,
          kind: "speak-semantic-response",
          responseId,
          taskId: recovered.task.id,
          text,
        },
      ],
    });
  }
  if (state.pendingCompletionOfferTaskId !== undefined) {
    const taskId = state.pendingCompletionOfferTaskId;
    const offerSpeech = classifyConfirmationSpeech(sanitizedTranscript);
    if (offerSpeech === "ambiguous") {
      // The offer is a pending decision too: unreadable speech leaves it open
      // instead of silently keeping the caller on a call they wanted to end.
      return guidance(
        options,
        turn,
        "I did not catch that. Would you like me to disconnect and call you back when this finishes?",
      );
    }
    state.pendingCompletionOfferTaskId = undefined;
    if (offerSpeech === "affirmative") {
      return telephoneSessionActionResultSchema.parse({
        actions: [
          {
            interruptible: false,
            kind: "request-completion-callback-and-disconnect",
            requestId: `completion-callback:${turn.turnId}`,
            taskId,
            telephoneSessionId: turn.telephoneSessionId,
          },
        ],
      });
    }
    return guidance(
      options,
      turn,
      "Okay. I’ll keep this call open while the Durable Task continues.",
    );
  }
  if (
    transcriptRequestsKeeploreButtonTrialStatus(sanitizedTranscript) &&
    options.keeploreDelegations !== undefined
  ) {
    const record =
      state.activeKeeploreTaskId === undefined
        ? (await options.keeploreDelegations.list()).at(-1)
        : await options.keeploreDelegations.get(state.activeKeeploreTaskId);
    if (record !== undefined) {
      return keeploreStatusResponse(turn, record);
    }
  }
  const interpretation = telephoneTurnInterpretationSchema.parse(
    await options.interpreter.interpret({
      telephoneSessionId: turn.telephoneSessionId,
      text: sanitizedTranscript,
      turnId: turn.turnId,
    }),
  );
  await options.sessionEvidence?.append({
    details: {
      durationMs: interpretation.durationMs,
      outcome: "completed",
      provider: interpretation.provider,
      stage: "coordinator",
    },
    id: `${turn.turnId}:coordinator`,
    kind: "telephone.provider.timing",
    occurredAt: turn.occurredAt,
    summary: "Telephone turn interpretation timing was recorded.",
  });
  if (interpretation.intent === "stop") {
    if (
      state.activeKeeploreTaskId === undefined &&
      options.keeploreDelegations !== undefined
    ) {
      const durableDelegations = await options.keeploreDelegations.list();
      const activeDelegation =
        durableDelegations.findLast(
          (record) => record.task.status === "running",
        ) ??
        durableDelegations.findLast(
          (record) => record.task.status === "pending",
        );
      state.activeKeeploreTaskId = activeDelegation?.task.id;
    }
    if (
      state.activeKeeploreTaskId !== undefined &&
      options.keeploreDelegations !== undefined
    ) {
      const taskId = state.activeKeeploreTaskId;
      await options.keeploreDelegations.requestStop(taskId);
      const responseId = `${turn.turnId}:stop-response`;
      return telephoneSessionActionResultSchema.parse({
        actions: [
          {
            interruptible: true,
            kind: "speak-semantic-response",
            responseId,
            taskId,
            text:
              "I recorded the stop request. Restricted Codex will halt at its next safe boundary and preserve every completed commit and worktree change.",
          },
        ],
      });
    }
    if (
      options.activeTaskId === undefined ||
      options.tasks.requestStop === undefined
    ) {
      return guidance(
        options,
        turn,
        "There is no active Durable Task in this Telephone Session to stop.",
      );
    }
    const record = await options.tasks.requestStop({
      requestId: `telephone-stop:${turn.turnId}`,
      taskId: options.activeTaskId,
    });
    const responseId = `${turn.turnId}:stop-response`;
    const text = "I stopped the Durable Task at its next safe boundary.";
    await options.tasks.appendTelephoneEvidence({
      event: {
        details: { responseId, text },
        id: responseId,
        kind: "telephone.semantic.response",
        occurredAt: record.task.updatedAt,
        summary: "A cancellation response was prepared for speech.",
      },
      taskId: record.task.id,
    });
    return telephoneSessionActionResultSchema.parse({
      actions: [
        {
          interruptible: true,
          kind: "speak-semantic-response",
          responseId,
          taskId: record.task.id,
          text,
        },
      ],
    });
  }
  if (interpretation.intent === "state-changing") {
    const taskDescription = /[.!?]$/u.test(sanitizedTranscript)
      ? sanitizedTranscript
      : `${sanitizedTranscript}.`;
    const confirmationId = `${turn.turnId}:confirmation`;
    const boundaryDecision = await options.stateChangingTasks?.claim(
      turn.telephoneSessionId,
      confirmationId,
    );
    if (boundaryDecision?.decision === "queued") {
      return guidance(
        options,
        turn,
        `That state-changing discussion is queued in position ${boundaryDecision.position}.`,
      );
    }
    if (boundaryDecision?.decision === "rejected") {
      return guidance(
        options,
        turn,
        "I could not accept another state-changing discussion in this Telephone Session.",
      );
    }
    if (boundaryDecision?.decision === "accepted") {
      state.pendingStateChangingDiscussionId = confirmationId;
      state.pendingStateChangingKind = transcriptRequestsKeeploreButtonTrial(
        sanitizedTranscript,
      )
        ? "keeplore-button-trial"
        : transcriptReportsBountywellOutage(sanitizedTranscript)
          ? "outage"
          : "other";
    }
    const text = transcriptRequestsKeeploreButtonTrial(sanitizedTranscript)
      ? "Please confirm this state-changing task: Keeplore production — make table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight, while retaining content-based widths and leaving card view unchanged."
      : `Please confirm this state-changing task: ` +
        `Bountywell production — ${taskDescription}`;
    await options.sessionEvidence?.append({
      details: { responseId: confirmationId, text },
      id: confirmationId,
      kind: "telephone.semantic.response",
      occurredAt: turn.occurredAt,
      summary: "A Task Confirmation was prepared for speech.",
    });
    return telephoneSessionActionResultSchema.parse({
      actions: [
        {
          confirmationId,
          interruptible: true,
          kind: "request-task-confirmation",
          text,
        },
      ],
    });
  }
  if (interpretation.intent === "unrelated") {
    const responseId = `${turn.turnId}:guidance`;
    const text =
      "I can only answer the registered read-only Bountywell health " +
      "question in this Telephone Session.";
    await options.sessionEvidence?.append({
      details: { responseId, text },
      id: responseId,
      kind: "telephone.semantic.response",
      occurredAt: turn.occurredAt,
      summary: "Bounded Telephone Session guidance was prepared for speech.",
    });
    return telephoneSessionActionResultSchema.parse({
      actions: [
        {
          interruptible: true,
          kind: "speak-guidance",
          responseId,
          text,
        },
      ],
    });
  }
  const record = await options.tasks.submitTelephoneBountywellHealthInquiry({
    interpretation,
    sanitizedTranscript,
    turn,
  });
  const responseId = `${turn.turnId}:response`;
  if (record.task.status === "pending") {
    state.pendingCompletionOfferTaskId = record.task.id;
    const offerResponseId = `${turn.turnId}:completion-offer`;
    const text =
      "This is still running. I can disconnect and call your registered telephone when it finishes. Would you like that?" as const;
    const evidence = {
      details: { responseId: offerResponseId, text },
      id: offerResponseId,
      kind: "telephone.semantic.response" as const,
      occurredAt: record.task.updatedAt,
      summary: "A Completion Callback offer was prepared for speech.",
    };
    await options.tasks.appendTelephoneEvidence({
      event: evidence,
      taskId: record.task.id,
    });
    await options.sessionEvidence?.append(evidence);
    return telephoneSessionActionResultSchema.parse({
      actions: [
        {
          interruptible: true,
          kind: "offer-completion-callback",
          responseId: offerResponseId,
          taskId: record.task.id,
          text,
        },
      ],
    });
  }
  const text = semanticBountywellAnswer(record);
  await options.tasks.appendTelephoneEvidence({
    event: {
      details: { responseId, text },
      id: responseId,
      kind: "telephone.semantic.response",
      occurredAt: record.task.updatedAt,
      summary: "A semantic telephone response was prepared for speech.",
    },
    taskId: record.task.id,
  });
  await options.sessionEvidence?.append({
    details: { responseId, text },
    id: responseId,
    kind: "telephone.semantic.response",
    occurredAt: record.task.updatedAt,
    summary: "A semantic telephone response was prepared for speech.",
  });
  return telephoneSessionActionResultSchema.parse({
    actions: [
      {
        interruptible: true,
        kind: "speak-semantic-response",
        responseId,
        taskId: record.task.id,
        text,
      },
    ],
  });
}

function transcriptRequestsKeeploreButtonTrial(text: string): boolean {
  return /get rid of/iu.test(text) && /remove/iu.test(text);
}

function transcriptRequestsKeeploreButtonTrialStatus(text: string): boolean {
  return /keeplore/iu.test(text) && /(status|result|pull request)/iu.test(text);
}

function keeploreStatusResponse(
  turn: FinalizedTelephoneTurn,
  record: KeeploreDelegationRecord,
): TelephoneSessionActionResult {
  const result = record.delegation.result;
  let text: string;
  if (result?.status === "completed" && result.pullRequest.state === "open") {
    const commitNoun = result.commits.length === 1 ? "commit" : "commits";
    text =
      `The Keeplore Button Trial is complete on branch ${result.branch} ` +
      `with ${result.commits.length} ${commitNoun}. Its verified pull request ` +
      `is ${result.pullRequest.url}. It has not been merged or deployed.`;
  } else if (result?.status === "stopped") {
    text =
      "The Keeplore Button Trial is stopped. Its completed commits and worktree changes are preserved for inspection.";
  } else if (result?.status === "failed") {
    text =
      "The Keeplore Button Trial could not be verified. Its worktree is quarantined for inspection and nothing was merged or deployed.";
  } else if (record.task.status === "running") {
    text = "The Keeplore Button Trial is still running in its restricted worktree.";
  } else {
    text = "The Keeplore Button Trial is delegated and waiting for restricted Codex.";
  }
  return telephoneSessionActionResultSchema.parse({
    actions: [
      {
        interruptible: true,
        kind: "speak-semantic-response",
        responseId: `${turn.turnId}:keeplore-status-response`,
        taskId: record.task.id,
        text,
      },
    ],
  });
}

async function guidance(
  options: { readonly sessionEvidence?: TelephoneSessionEvidenceSink },
  turn: FinalizedTelephoneTurn,
  text: string,
): Promise<TelephoneSessionActionResult> {
  const responseId = `${turn.turnId}:guidance`;
  await options.sessionEvidence?.append({
    details: { responseId, text },
    id: responseId,
    kind: "telephone.semantic.response",
    occurredAt: turn.occurredAt,
    summary: "Bounded Telephone Session guidance was prepared for speech.",
  });
  return telephoneSessionActionResultSchema.parse({
    actions: [
      {
        interruptible: true,
        kind: "speak-guidance",
        responseId,
        text,
      },
    ],
  });
}

/**
 * Record one bounded speech-provider failure and decide what the call does
 * next.
 *
 * A Telephone Session spends at most one recovery: the first transient failure
 * is retried against the same durable turn identity, and any remaining failure
 * ends the call once. Both outcomes append the failing component to evidence,
 * and the terminal response is issued exactly once so a stuttering provider
 * cannot replay the prerecorded audio.
 */
async function recordProviderFailure(
  options: {
    readonly sessionEvidence?: TelephoneSessionEvidenceSink;
    readonly tasks: TelephoneBountywellTasks;
  },
  state: TelephoneSessionCoordinatorState,
  event: {
    readonly deliveryId: string;
    readonly occurredAt: string;
    readonly recovery?: TelephoneProviderFailureRecovery | undefined;
    readonly taskId?: string | undefined;
  },
  details:
    | {
        readonly failure: "timeout";
        readonly provider: string;
        readonly stage: TelephoneProviderFailureStage;
        readonly timeoutMs: number;
      }
    | {
        readonly failure: "unavailable";
        readonly provider: string;
        readonly stage: TelephoneProviderFailureStage;
      },
): Promise<TelephoneSessionActionResult> {
  const evidence: Omit<
    Extract<
      TelephoneConversationEvidenceEvent,
      { kind: "telephone.provider.failure" }
    >,
    "sequence"
  > = {
    details,
    id: `${event.deliveryId}:failure`,
    kind: "telephone.provider.failure",
    occurredAt: event.occurredAt,
    summary:
      details.failure === "timeout"
        ? "A speech provider exceeded its bounded timeout."
        : "A speech provider reported a bounded failure.",
  };
  // A setup failure has no accepted turn to replay: the session never started,
  // so it ends on its first report rather than spending the retry.
  const retrying =
    (event.recovery ?? "retryable") === "retryable" &&
    details.stage !== "setup" &&
    !state.providerRetryUsed;
  await options.sessionEvidence?.append(evidence);
  if (!retrying) {
    await options.sessionEvidence?.requestFailureNotification?.({
      failureEventId: evidence.id,
      occurredAt: evidence.occurredAt,
    });
  }
  if (event.taskId !== undefined) {
    await options.tasks.appendTelephoneEvidence({
      event: evidence,
      taskId: event.taskId,
    });
  }
  if (retrying) {
    state.providerRetryUsed = true;
    const retry = {
      details: {
        provider: details.provider,
        stage: details.stage,
        ...(state.lastFinalizedTurnId === undefined
          ? {}
          : { turnId: state.lastFinalizedTurnId }),
      },
      id: `${event.deliveryId}:retry`,
      kind: "telephone.provider.retry" as const,
      occurredAt: event.occurredAt,
      summary: "One bounded speech-provider retry was authorized.",
    };
    await options.sessionEvidence?.append(retry);
    if (event.taskId !== undefined) {
      await options.tasks.appendTelephoneEvidence({
        event: retry,
        taskId: event.taskId,
      });
    }
    return telephoneSessionActionResultSchema.parse({
      actions: [
        {
          kind: "retry-provider-turn",
          retryId: retry.id,
          stage: details.stage,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          ...(state.lastFinalizedTurnId === undefined
            ? {}
            : { turnId: state.lastFinalizedTurnId }),
        },
      ],
    });
  }
  if (state.terminalFailureIssued) {
    // The call is already ending on the first terminal response. Later
    // failures stay in evidence but never speak again.
    return telephoneSessionActionResultSchema.parse({ actions: [] });
  }
  state.terminalFailureIssued = true;
  return telephoneSessionActionResultSchema.parse({
    actions: [
      {
        interruptible: false,
        kind: "play-prerecorded-failure-and-end",
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        text: "The voice service is temporarily unavailable. Please check the Evidence Record.",
      },
    ],
  });
}

function sanitizeFinalizedTurn(transcript: string): string {
  return transcript
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /\b((?:(?:my|our|the)\s+)?(?:authorization|api[-_ ]?key|password|secret|token))\s*(?:[:=]|\b(?:equals|is|was)\b\s*:?)\s*\S+/giu,
      "$1: [redacted]",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function semanticOutageAnswer(record: EvidenceRecordProjection): string {
  if (record.task.kind !== "bountywell.outage.recovery") {
    throw new Error("Bountywell outage Evidence Record is unavailable");
  }
  const diagnosis = record.evidence.find((event) => event.kind === "diagnosis.recorded");
  const diagnosed =
    diagnosis?.kind === "diagnosis.recorded" &&
    diagnosis.details.inactiveUnit === "bountywell-api.service"
      ? " Observation identified the inactive registered bountywell-api.service unit."
      : "";
  if (record.task.conclusion === "Bountywell API was recovered.") {
    return (
      "Bountywell's API was recovered." +
      diagnosed +
      " The public /api/health check returned 200 and /api/data returned the expected 401. The recovery timer has been removed."
    );
  }
  if (record.task.conclusion === "Bountywell API was already recovered.") {
    return (
      "Bountywell's API was already recovered." +
      diagnosed +
      " The public endpoints already matched the required health semantics."
    );
  }
  return (
    "Bountywell API recovery could not be confirmed." +
    diagnosed +
    " The independent recovery timer remains armed."
  );
}

function semanticBountywellAnswer(record: EvidenceRecordProjection): string {
  const observed = record.evidence.find(
    (event) => event.kind === "evidence.observed",
  );
  if (observed?.kind !== "evidence.observed") {
    throw new Error("Bountywell health evidence is unavailable");
  }
  const checks = observed.details.checks;
  const primary = checks.find((check) => check.source === "public-health");
  const authentication = checks.find(
    (check) => check.source === "authentication-boundary",
  );
  const local = checks.find((check) => check.source === "local-health");
  const service = checks.find((check) => check.source === "service-state");
  const resources = checks.find((check) => check.source === "resource-health");

  if (record.task.conclusion === "Bountywell API is healthy.") {
    if (primary?.source !== "public-health") {
      throw new Error("Healthy Bountywell evidence lacks a primary health fact");
    }
    const uncertainty =
      observed.details.uncertainty ??
      "No material uncertainty was reported.";
    const authenticationSentence =
      authentication?.source === "authentication-boundary"
        ? authentication.outcome === "pass" &&
          authentication.facts.statusCode === 401
          ? "The authentication-boundary /api/data check returned the expected 401."
          : `The authentication-boundary /api/data check returned ${authentication.facts.statusCode}.`
        : "The authentication-boundary check was unavailable.";
    const secondaryFacts =
      local?.outcome === "pass" &&
      service?.outcome === "pass" &&
      resources?.outcome === "pass"
        ? "The registered local endpoint and service are healthy, and the bounded resource check passed."
        : "Some secondary registered checks were unavailable, so the answer is limited to the supported facts.";
    return `Bountywell's API is healthy. The primary /api/health check returned ${primary.facts.statusCode}. ${authenticationSentence} ${secondaryFacts} Uncertainty: ${uncertainty}`;
  }

  const primaryFact =
    primary?.source === "public-health"
      ? `the primary /api/health check returned ${primary.facts.statusCode}`
      : "no primary /api/health evidence was available";
  const authenticationFact =
    authentication?.source === "authentication-boundary"
      ? authentication.outcome === "pass" &&
        authentication.facts.statusCode === 401
        ? "the authentication-boundary /api/data check returned the expected 401"
        : `the authentication-boundary /api/data check returned ${authentication.facts.statusCode}`
      : "the authentication-boundary check was unavailable";
  const uncertainty =
    observed.details.uncertainty ??
    "The bounded evidence did not support a healthy conclusion.";
  return `I could not confirm that Bountywell's API is healthy. Supported facts: ${primaryFact}; ${authenticationFact}. Uncertainty: ${uncertainty}`;
}
