import {
  telephoneSessionActionResultSchema,
  telephoneSessionProviderEventSchema,
  telephoneTurnInterpretationSchema,
  type EvidenceEventProjection,
  type EvidenceRecordProjection,
  type FinalizedTelephoneTurn,
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
}

export interface TelephoneSessionCoordinator {
  receiveProviderEvent(
    event: TelephoneSessionProviderEvent,
  ): Promise<TelephoneSessionActionResult>;
}

export function createTelephoneSessionCoordinator(options: {
  readonly interpreter: TelephoneTurnInterpreter;
  readonly tasks: TelephoneBountywellTasks;
}): TelephoneSessionCoordinator {
  return {
    async receiveProviderEvent(untrustedEvent) {
      const event = telephoneSessionProviderEventSchema.parse(untrustedEvent);
      if (event.kind === "speech-hypothesis") {
        return telephoneSessionActionResultSchema.parse({ actions: [] });
      }
      if (event.kind === "response-interrupted") {
        await options.tasks.appendTelephoneEvidence({
          event: {
            details: {
              durationMs: event.durationMs,
              responseId: event.responseId,
            },
            id: `${event.deliveryId}:interruption`,
            kind: "telephone.response.interrupted",
            occurredAt: event.occurredAt,
            summary: "The caller interrupted semantic speech.",
          },
          taskId: event.taskId,
        });
        return telephoneSessionActionResultSchema.parse({ actions: [] });
      }
      if (event.kind === "provider-timing") {
        await options.tasks.appendTelephoneEvidence({
          event: {
            details: {
              durationMs: event.durationMs,
              outcome: "completed",
              provider: event.provider,
              stage: event.stage,
            },
            id: `${event.deliveryId}:timing`,
            kind: "telephone.provider.timing",
            occurredAt: event.occurredAt,
            summary: "Bounded speech-provider timing was recorded.",
          },
          taskId: event.taskId,
        });
        return telephoneSessionActionResultSchema.parse({ actions: [] });
      }
      if (event.kind === "provider-timeout") {
        await options.tasks.appendTelephoneEvidence({
          event: {
            details: {
              failure: "timeout",
              provider: event.provider,
              stage: event.stage,
              timeoutMs: event.timeoutMs,
            },
            id: `${event.deliveryId}:failure`,
            kind: "telephone.provider.failure",
            occurredAt: event.occurredAt,
            summary: "A speech provider exceeded its bounded timeout.",
          },
          taskId: event.taskId,
        });
        return telephoneSessionActionResultSchema.parse({
          actions: [
            {
              interruptible: false,
              kind: "play-prerecorded-failure-and-end",
              taskId: event.taskId,
              text: "The voice service is temporarily unavailable. Please check the Evidence Record.",
            },
          ],
        });
      }
      if (event.kind === "provider-failure") {
        await options.tasks.appendTelephoneEvidence({
          event: {
            details: {
              failure: event.failure,
              provider: event.provider,
              stage: event.stage,
            },
            id: `${event.deliveryId}:failure`,
            kind: "telephone.provider.failure",
            occurredAt: event.occurredAt,
            summary: "A speech provider reported a bounded failure.",
          },
          taskId: event.taskId,
        });
        return telephoneSessionActionResultSchema.parse({
          actions: [
            {
              interruptible: false,
              kind: "play-prerecorded-failure-and-end",
              taskId: event.taskId,
              text: "The voice service is temporarily unavailable. Please check the Evidence Record.",
            },
          ],
        });
      }
      const turn = event;
      const sanitizedTranscript = sanitizeFinalizedTurn(turn.transcript);
      const interpretation = telephoneTurnInterpretationSchema.parse(
        await options.interpreter.interpret({
          telephoneSessionId: turn.telephoneSessionId,
          text: sanitizedTranscript,
          turnId: turn.deliveryId,
        }),
      );
      if (interpretation.intent === "state-changing") {
        const taskDescription = /[.!?]$/u.test(sanitizedTranscript)
          ? sanitizedTranscript
          : `${sanitizedTranscript}.`;
        return telephoneSessionActionResultSchema.parse({
          actions: [
            {
              confirmationId: `${turn.deliveryId}:confirmation`,
              interruptible: true,
              kind: "request-task-confirmation",
              text: `Please confirm this state-changing task: Bountywell production — ${taskDescription}`,
            },
          ],
        });
      }
      if (interpretation.intent === "unrelated") {
        return telephoneSessionActionResultSchema.parse({
          actions: [
            {
              interruptible: true,
              kind: "speak-guidance",
              responseId: `${turn.deliveryId}:guidance`,
              text: "I can only answer the registered read-only Bountywell health question in this Telephone Session.",
            },
          ],
        });
      }
      const record = await options.tasks.submitTelephoneBountywellHealthInquiry({
        interpretation,
        sanitizedTranscript,
        turn,
      });
      const responseId = `${turn.deliveryId}:response`;
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
    },
  };
}

function sanitizeFinalizedTurn(transcript: string): string {
  return transcript
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /\b(authorization|api[-_ ]?key|password|secret|token)\s*[:=]\s*\S+/giu,
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
    if (
      primary?.source !== "public-health" ||
      authentication?.source !== "authentication-boundary"
    ) {
      throw new Error("Healthy Bountywell evidence lacks required boundary facts");
    }
    const uncertainty = observed.details.uncertainty ?? "No material uncertainty was reported.";
    const secondaryFacts =
      local?.outcome === "pass" &&
      service?.outcome === "pass" &&
      resources?.outcome === "pass"
        ? "The registered local endpoint and service are healthy, and the bounded resource check passed."
        : "Some secondary registered checks were unavailable, so the answer is limited to the primary and authentication-boundary facts.";
    return `Bountywell's API is healthy. The primary /api/health check returned ${primary.facts.statusCode}. The authentication-boundary /api/data check returned the expected ${authentication.facts.statusCode}. ${secondaryFacts} Uncertainty: ${uncertainty}`;
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
