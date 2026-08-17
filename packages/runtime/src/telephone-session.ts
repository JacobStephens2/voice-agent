import {
  telephoneSessionActionResultSchema,
  telephoneSessionProviderEventSchema,
  telephoneTurnInterpretationSchema,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
  type FinalizedTelephoneTurn,
  type TelephoneConversationEvidenceEvent,
  type TelephoneSessionActionResult,
  type TelephoneSessionProviderEvent,
  type TelephoneTurnInterpretation,
} from "@voice-agent/contracts";

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
  readonly sessionEvidence?: TelephoneSessionEvidenceSink;
  readonly tasks: TelephoneBountywellTasks;
}

interface TelephoneSessionCoordinatorState {
  pendingCompletionOfferTaskId: string | undefined;
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
    pendingCompletionOfferTaskId: undefined,
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
            return recordProviderFailure(
              options,
              {
                deliveryId: event.deliveryId,
                occurredAt: event.occurredAt,
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
        return recordProviderFailure(options, event, {
          failure: "timeout",
          provider: event.provider,
          stage: event.stage,
          timeoutMs: event.timeoutMs,
        });
      }
      if (event.kind === "provider-failure") {
        return recordProviderFailure(options, event, {
          failure: event.failure,
          provider: event.provider,
          stage: event.stage,
        });
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
  if (state.pendingCompletionOfferTaskId !== undefined) {
    const taskId = state.pendingCompletionOfferTaskId;
    state.pendingCompletionOfferTaskId = undefined;
    if (isAffirmative(sanitizedTranscript)) {
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
    const text =
      `Please confirm this state-changing task: ` +
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

function isAffirmative(text: string): boolean {
  return /^(?:yes|yes(?:,\s*|\s+)please|yeah|yep|sure|okay|ok|please do)[.!]?$/iu.test(
    text.trim(),
  );
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

async function recordProviderFailure(
  options: {
    readonly sessionEvidence?: TelephoneSessionEvidenceSink;
    readonly tasks: TelephoneBountywellTasks;
  },
  event: {
    readonly deliveryId: string;
    readonly occurredAt: string;
    readonly taskId?: string | undefined;
  },
  details:
    | {
        readonly failure: "timeout";
        readonly provider: string;
        readonly stage: "stt" | "coordinator" | "tts";
        readonly timeoutMs: number;
      }
    | {
        readonly failure: "unavailable";
        readonly provider: string;
        readonly stage: "stt" | "coordinator" | "tts";
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
  await options.sessionEvidence?.append(evidence);
  await options.sessionEvidence?.requestFailureNotification?.({
    failureEventId: evidence.id,
    occurredAt: evidence.occurredAt,
  });
  if (event.taskId !== undefined) {
    await options.tasks.appendTelephoneEvidence({
      event: evidence,
      taskId: event.taskId,
    });
  }
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
