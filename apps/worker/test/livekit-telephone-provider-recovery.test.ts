import {
  APIError,
  APIStatusError,
  APITimeoutError,
  llm,
  voice,
} from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";
import {
  defaultConfiguredSpeechSynthesis,
  defaultRecognizedSpeechModel,
  recognizedSpeechModels,
  type TelephoneConversationEvidenceEvent,
} from "@voice-agent/contracts";
import {
  createDurableTaskRuntime,
  TelephoneSessionFault,
} from "@voice-agent/runtime";
import { createSqliteDurableTaskStore } from "@voice-agent/sqlite-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  runLiveKitTelephoneSession,
  type LiveKitTelephoneSessionDependencies,
} from "../src/livekit-telephone-session.ts";
import { SpeechProviderErrorFrameLog } from "../src/speech-provider-error-frame.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("bounded LiveKit telephone provider recovery", () => {
  test("one transient coordinator failure is retried under the same durable turn identity", async () => {
    const tasks = await createTasks("coordinator-retry");
    const session = new RecoverySessionHarness();
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    let attempts = 0;
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          attempts += 1;
          if (attempts === 1) {
            throw new APITimeoutError({ message: "Coordinator timed out" });
          }
          return {
            durationMs: 31,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks,
          telephoneSessionId: "telephone-session-coordinator-retry",
        }),
        dependencies,
      );

      expect(attempts).toBe(2);
      expect(session.spokenTexts).toHaveLength(1);
      expect(session.spokenTexts[0]).toContain("Bountywell's API is healthy.");
      expect(session.failurePlaybacks).toBe(0);
      expect(recordProviderFailure).toHaveBeenCalledTimes(1);
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "coordinator" }),
      );
      const retries = evidence.filter(
        (event) => event.kind === "telephone.provider.retry",
      );
      expect(retries).toHaveLength(1);
      expect(retries[0]?.details).toMatchObject({
        provider: "openai",
        stage: "coordinator",
        turnId: turnIdentityOf(evidence),
      });
      const summaries = await tasks.listEvidenceRecords();
      expect(summaries).toHaveLength(1);
    } finally {
      await tasks.close();
    }
  });

  test("a transient recognition failure asks the caller to repeat instead of ending", async () => {
    const tasks = await createTasks("stt-retry");
    const session = new RecoverySessionHarness({ transcriptionTimeout: true });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-stt-retry",
          }),
          endCall,
        },
        dependencies,
      );

      expect(session.spokenTexts).toContain(
        "Sorry, I did not catch that. Please say that again.",
      );
      expect(session.failurePlaybacks).toBe(0);
      expect(endCall).not.toHaveBeenCalled();
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "stt" }),
      );
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.retry"),
      ).toHaveLength(1);
      // The caller repeats and is answered under a fresh turn identity.
      expect(session.spokenTexts.at(-1)).toContain(
        "Bountywell's API is healthy.",
      );
    } finally {
      await tasks.close();
    }
  });

  test("recognition evidence names the configured model, and no other stage's", async () => {
    const tasks = await createTasks("stt-configured-model");
    const session = new RecoverySessionHarness({ transcriptionTimeout: true });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-stt-configured-model",
          }),
          recognitionModel: recognizedSpeechModels["deepgram/flux-general-en"],
        },
        dependencies,
      );

      // A recorded recognition fault must be readable against the model that
      // actually raised it, not the one that was hardcoded when it was written.
      const failures = evidence.filter(
        (event) =>
          event.kind === "telephone.provider.failure" &&
          event.details.stage === "stt",
      );
      expect(failures.length).toBeGreaterThan(0);
      for (const failure of failures) {
        expect(failure.details).toMatchObject({
          model: "deepgram/flux-general-en",
          provider: "deepgram",
        });
      }

      const timings = evidence.filter(
        (event) => event.kind === "telephone.provider.timing",
      );
      const recognitionTimings = timings.filter(
        (event) => event.details.stage === "stt",
      );
      expect(recognitionTimings.length).toBeGreaterThan(0);
      for (const timing of recognitionTimings) {
        expect(timing.details).toMatchObject({
          model: "deepgram/flux-general-en",
          provider: "deepgram",
        });
      }
      // The recognition model says nothing about a fault another stage raised.
      for (const timing of timings.filter(
        (event) => event.details.stage === "coordinator",
      )) {
        expect(timing.details).not.toHaveProperty("model");
      }
    } finally {
      await tasks.close();
    }
  });

  test("synthesis evidence names the configured model, and no other stage's", async () => {
    const tasks = await createTasks("tts-configured-model");
    const session = new RecoverySessionHarness();
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-tts-configured-model",
          }),
          synthesisModel: {
            model: "cartesia/sonic-3.5",
            provider: "cartesia",
            voice: "6f84f4b8-58a2-430c-8c79-688dad597532",
          },
        },
        dependencies,
      );

      // A recorded synthesis timing must be readable against the model that
      // actually spoke, not the one that was hardcoded when it was written.
      const timings = evidence.filter(
        (event) => event.kind === "telephone.provider.timing",
      );
      const synthesisTimings = timings.filter(
        (event) => event.details.stage === "tts",
      );
      expect(synthesisTimings.length).toBeGreaterThan(0);
      for (const timing of synthesisTimings) {
        expect(timing.details).toMatchObject({
          model: "cartesia/sonic-3.5",
          provider: "cartesia",
        });
      }
      // The synthesis model says nothing about a fault another stage raised.
      for (const timing of timings.filter(
        (event) => event.details.stage === "coordinator",
      )) {
        expect(timing.details).not.toHaveProperty("model");
      }
    } finally {
      await tasks.close();
    }
  });

  test("a retry that replays an already-answered turn still ends the call once", async () => {
    const pendingRecord = {
      evidence: [],
      task: {
        conclusion: "Bountywell inquiry is pending.",
        createdAt: "2026-08-24T09:00:00.000Z",
        id: "task-pending-recovery",
        kind: "bountywell.health.inquiry",
        question: "Is Bountywell healthy?",
        status: "pending",
        updatedAt: "2026-08-24T09:00:00.000Z",
      },
    };
    const session = new RecoverySessionHarness({
      extraCompletedTurns: [
        llm.ChatMessage.create({
          content: "Yes, I confirm.",
          createdAt: 1_787_000_004_000,
          id: "recovery-completed-turn-002",
          role: "user",
        }),
      ],
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    await runLiveKitTelephoneSession(
      {
        ...sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          // The Completion Callback control is absent, so accepting the offer
          // throws after the coordinator has already answered that turn.
          tasks: {
            async appendTelephoneEvidence() {
              return pendingRecord;
            },
            async submitTelephoneBountywellHealthInquiry() {
              return pendingRecord;
            },
          } as unknown as ReturnType<typeof createDurableTaskRuntime>,
          telephoneSessionId: "telephone-session-answered-replay",
        }),
        endCall,
      },
      dependencies,
    );

    expect(
      evidence.filter((event) => event.kind === "telephone.provider.retry"),
    ).toHaveLength(1);
    expect(session.failurePlaybacks).toBe(1);
    expect(endCall).toHaveBeenCalledTimes(1);
  });

  test("an interpretation fault this codebase raised is logged with its message", async () => {
    const tasks = await createTasks("coordinator-fault-logged");
    const session = new RecoverySessionHarness();
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    let attempts = 0;
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          attempts += 1;
          if (attempts === 1) {
            throw new TelephoneSessionFault(
              "Telephone coordinator returned an invalid typed intent",
            );
          }
          return {
            durationMs: 18,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks,
          telephoneSessionId: "telephone-session-coordinator-fault",
        }),
        dependencies,
      );

      // Interpretation is handed the caller's transcript, so a provider error
      // there logs its type alone. This message is our own fixed string, and
      // withholding it is what left the fault undiagnosable.
      expect(logProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: {
            message: "Telephone coordinator returned an invalid typed intent",
            name: "TelephoneSessionFault",
          },
          stage: "coordinator",
        }),
      );
    } finally {
      await tasks.close();
    }
  });

  test("a speech failure that ends the call is logged with a sanitized description", async () => {
    const tasks = await createTasks("tts-logged");
    const session = new RecoverySessionHarness({ failEverySay: true });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-tts-logged",
          }),
          endCall: async () => undefined,
        },
        dependencies,
      );

      // The call dies on this fault, so the operator's only copy of what the
      // provider said is this line.
      expect(logProviderFailure).toHaveBeenCalledWith({
        error: {
          message: "Speech synthesis timed out",
          name: "APITimeoutError",
        },
        provider: "inworld",
        recovery: "retryable",
        stage: "tts",
        telephoneSessionId: "telephone-session-tts-logged",
      });
      // The bounded retry fails the same way, and the fault that actually
      // ends the call is reported too rather than only the first one.
      expect(logProviderFailure).toHaveBeenCalledTimes(2);
    } finally {
      await tasks.close();
    }
  });

  test("a speech provider's own reason is logged instead of an undefined message", async () => {
    const tasks = await createTasks("tts-gateway-reason");
    const session = new RecoverySessionHarness({
      failEverySay: true,
      gatewayErrorFrame: {
        code: "upstream_error",
        message: "inworld: upstream request timed out",
        retryable: true,
        session_id: "tts-abc123",
        // The gateway echoes what it was asked to say; none of it may reach
        // the operator's journal.
        transcript: "restart the Bountywell API",
        type: "error",
      },
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks,
          telephoneSessionId: "telephone-session-tts-gateway-reason",
        }),
        dependencies,
      );

      // Diagnosing this fault previously meant hand-building a websocket
      // client against the gateway: the line said `undefined`.
      expect(logProviderFailure).toHaveBeenCalledWith({
        error: {
          code: "upstream_error",
          fault: "upstream",
          message: "inworld: upstream request timed out",
          name: "APIError",
          retryable: true,
        },
        provider: "inworld",
        recovery: "retryable",
        stage: "tts",
        telephoneSessionId: "telephone-session-tts-gateway-reason",
      });
      expect(JSON.stringify(logProviderFailure.mock.calls)).not.toContain(
        "Bountywell",
      );
    } finally {
      await tasks.close();
    }
  });

  test("a fault the provider calls unretryable ends the call without spending the retry", async () => {
    const tasks = await createTasks("tts-gateway-terminal");
    const session = new RecoverySessionHarness({
      failEverySay: true,
      gatewayErrorFrame: {
        code: "unauthenticated",
        message: "invalid api key",
        retryable: false,
        type: "error",
      },
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks,
          telephoneSessionId: "telephone-session-tts-gateway-terminal",
        }),
        dependencies,
      );

      // A wrong credential is not a provider outage, and the operator can see
      // that without probing the gateway by hand.
      expect(logProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ fault: "credential" }),
          recovery: "terminal",
        }),
      );
      // Retrying a credential the provider has already refused only spends the
      // one recovery this Telephone Session has.
      expect(recordProviderFailure).toHaveBeenCalledTimes(1);
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.retry"),
      ).toHaveLength(0);
      expect(session.failurePlaybacks).toBe(1);
    } finally {
      await tasks.close();
    }
  });

  test("a fault the provider calls retryable spends the retry the worker would have refused", async () => {
    const tasks = await createTasks("tts-gateway-retryable");
    const session = new RecoverySessionHarness({
      failEverySay: true,
      gatewayErrorFrame: {
        code: "upstream_error",
        message: "inworld: upstream request timed out",
        retryable: true,
        type: "error",
      },
      withoutCompletedTurn: true,
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret(): Promise<never> {
          throw new Error("The failed opening speech answers no turn");
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        sessionOptions({
          evidence,
          openingText: "Hello, this is your operations agent.",
          recordProviderFailure,
          session,
          tasks,
          telephoneSessionId: "telephone-session-tts-gateway-retryable",
        }),
        dependencies,
      );

      // The opening speech is reported as terminal on its own, so this
      // recovery came from the provider rather than from this worker's guess.
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ recovery: "retryable", stage: "tts" }),
      );
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.retry"),
      ).toHaveLength(1);
    } finally {
      await tasks.close();
    }
  });

  test("an error frame carrying no reason still names a usable fault", async () => {
    const tasks = await createTasks("tts-gateway-bare");
    const session = new RecoverySessionHarness({
      failEverySay: true,
      gatewayErrorFrame: { session_id: "tts-abc123", type: "error" },
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks,
          telephoneSessionId: "telephone-session-tts-gateway-bare",
        }),
        dependencies,
      );

      // Nothing was discarded and nothing threw: the frame said only that the
      // gateway failed, and that is what the line says.
      expect(logProviderFailure).toHaveBeenCalledWith({
        error: {
          fault: "unknown",
          message: "LiveKit TTS returned error: undefined",
          name: "APIError",
        },
        provider: "inworld",
        recovery: "retryable",
        stage: "tts",
        telephoneSessionId: "telephone-session-tts-gateway-bare",
      });
    } finally {
      await tasks.close();
    }
  });

  test("a remaining speech failure plays one prerecorded response and ends the call once", async () => {
    const tasks = await createTasks("tts-terminal");
    const session = new RecoverySessionHarness({ failEverySay: true });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-tts-terminal",
          }),
          endCall,
        },
        dependencies,
      );

      // The answer is attempted, retried once under its own identity, and then
      // abandoned for the one prerecorded terminal response.
      expect(session.attemptedSays).toBe(2);
      expect(session.failurePlaybacks).toBe(1);
      expect(endCall).toHaveBeenCalledTimes(1);
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.retry"),
      ).toHaveLength(1);
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.failure"),
      ).toHaveLength(2);
      const summaries = await tasks.listEvidenceRecords();
      expect(summaries).toHaveLength(1);
      const record = await tasks.getEvidenceRecord(summaries[0]?.id ?? "");
      // The accepted Durable Task survives the failed call for recovery.
      expect(record?.task.conclusion).toBe("Bountywell API is healthy.");
    } finally {
      await tasks.close();
    }
  });

  test("a synthesis fault speaking the Completion Callback confirmation is reported against synthesis", async () => {
    const pendingRecord = {
      evidence: [],
      task: {
        conclusion: "Bountywell inquiry is pending.",
        createdAt: "2026-08-24T09:00:00.000Z",
        id: "task-pending-callback",
        kind: "bountywell.health.inquiry",
        question: "Is Bountywell healthy?",
        status: "pending",
        updatedAt: "2026-08-24T09:00:00.000Z",
      },
    };
    const session = new RecoverySessionHarness({
      extraCompletedTurns: [
        llm.ChatMessage.create({
          content: "Yes, I confirm.",
          createdAt: 1_787_000_004_000,
          id: "recovery-completed-turn-002",
          role: "user",
        }),
      ],
      failSaysMatching: "call you back",
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    await runLiveKitTelephoneSession(
      {
        ...sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks: {
            async appendTelephoneEvidence() {
              return pendingRecord;
            },
            async submitTelephoneBountywellHealthInquiry() {
              return pendingRecord;
            },
          } as unknown as ReturnType<typeof createDurableTaskRuntime>,
          telephoneSessionId: "telephone-session-callback-tts",
        }),
        endCall: async () => undefined,
        async requestCompletionCallback() {
          return { text: "I will call you back once the work is done." };
        },
      },
      dependencies,
    );

    // The Completion Callback was requested and only its confirmation failed
    // to play, which is the synthesis provider's fault and not the agent's.
    expect(logProviderFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          message: "Speech synthesis timed out",
          name: "APITimeoutError",
        },
        provider: "inworld",
        stage: "tts",
      }),
    );
  });

  test("a synthesis fault playing the repeat prompt is reported against synthesis", async () => {
    const tasks = await createTasks("retry-prompt-tts");
    const session = new RecoverySessionHarness({
      failSaysMatching: "Please say that again",
      transcriptionTimeout: true,
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 26,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-retry-prompt-tts",
          }),
          endCall: async () => undefined,
        },
        dependencies,
      );

      // The recognition retry is what was running, but speech is what failed.
      expect(logProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: {
            message: "Speech synthesis timed out",
            name: "APITimeoutError",
          },
          provider: "inworld",
          stage: "tts",
        }),
      );
    } finally {
      await tasks.close();
    }
  });

  test("a fault after the answer is spoken is attributed to the Voice Agent, not the interpretation provider", async () => {
    const tasks = await createTasks("agent-stage");
    const session = new RecoverySessionHarness();
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 22,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };
    const options = sessionOptions({
      evidence,
      recordProviderFailure,
      session,
      tasks,
      telephoneSessionId: "telephone-session-agent-stage",
    });

    try {
      await runLiveKitTelephoneSession(
        {
          ...options,
          endCall,
          sessionEvidence: {
            async append(event) {
              // The reported symptom: the caller hears the whole answer, and
              // the line drops while the work after it is being recorded.
              if (
                event.kind === "telephone.provider.timing" &&
                "stage" in event.details &&
                event.details.stage === "tts"
              ) {
                throw new Error("evidence append failed");
              }
              await options.sessionEvidence.append(event);
            },
          },
        },
        dependencies,
      );

      expect(session.spokenTexts[0]).toContain("Bountywell's API is healthy.");
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "agent" }),
      );
      expect(logProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: { message: "evidence append failed", name: "Error" },
          provider: "voice-agent",
          stage: "agent",
        }),
      );
      expect(endCall).toHaveBeenCalledTimes(1);
    } finally {
      await tasks.close();
    }
  });

  test("an interpretation provider failure is still reported against the interpretation stage", async () => {
    const tasks = await createTasks("coordinator-stage");
    const session = new RecoverySessionHarness();
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret(): Promise<never> {
          throw new APIStatusError({
            message: "unreadable: cancel the Bountywell drill",
            options: { statusCode: 503 },
          });
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-coordinator-stage",
          }),
          endCall: async () => undefined,
        },
        dependencies,
      );

      // The provider's own message may quote the transcript it was given, so
      // the operator gets its type and status alone.
      expect(logProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: { name: "APIStatusError", status: 503 },
          provider: "openai",
          stage: "coordinator",
        }),
      );
    } finally {
      await tasks.close();
    }
  });

  test("a stalled provider ends the opening speech through the prerecorded response", async () => {
    const tasks = await createTasks("tts-opening-stall");
    const session = new RecoverySessionHarness({
      stallEverySay: true,
      withoutCompletedTurn: true,
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret(): Promise<never> {
          throw new Error("The stalled opening speech answers no turn");
        },
      }),
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            openingText: "Hello, this is your operations agent.",
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-opening-stall",
          }),
          endCall,
        },
        dependencies,
      );

      // The provider accepted the opening speech and produced no audio, so the
      // caller hears the prerecorded response rather than the silence that
      // preceded three dropped calls.
      expect(session.stalledSays).toBe(1);
      expect(session.spokenTexts).toHaveLength(0);
      expect(session.failurePlaybacks).toBe(1);
      expect(endCall).toHaveBeenCalledTimes(1);
      // The opening speech answers no accepted turn, so there is nothing to
      // replay and the call ends on the first report.
      expect(recordProviderFailure).toHaveBeenCalledTimes(1);
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ recovery: "terminal", stage: "tts" }),
      );
      const failures = evidence.filter(
        (event) => event.kind === "telephone.provider.failure",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.details).toMatchObject({
        provider: "inworld",
        stage: "tts",
      });
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.retry"),
      ).toHaveLength(0);
    } finally {
      await tasks.close();
    }
  });

  test("a stalled provider spends one replay on an answer and then plays the prerecorded response", async () => {
    const tasks = await createTasks("tts-answer-stall");
    const session = new RecoverySessionHarness({ stallEverySay: true });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-answer-stall",
          }),
          endCall,
        },
        dependencies,
      );

      // The answer is attempted, replayed once under the turn identity that
      // failed, and then abandoned for the one prerecorded response.
      expect(session.stalledSays).toBe(2);
      expect(session.failurePlaybacks).toBe(1);
      expect(endCall).toHaveBeenCalledTimes(1);
      const retries = evidence.filter(
        (event) => event.kind === "telephone.provider.retry",
      );
      expect(retries).toHaveLength(1);
      expect(retries[0]?.details).toMatchObject({
        provider: "inworld",
        stage: "tts",
        turnId: turnIdentityOf(evidence),
      });
      expect(
        evidence.filter((event) => event.kind === "telephone.provider.failure"),
      ).toHaveLength(2);
      expect(logProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: {
            message: "Speech synthesis produced no audio for this response",
            name: "APITimeoutError",
          },
          provider: "inworld",
          stage: "tts",
        }),
      );
      const summaries = await tasks.listEvidenceRecords();
      expect(summaries).toHaveLength(1);
      const record = await tasks.getEvidenceRecord(summaries[0]?.id ?? "");
      // The accepted Durable Task survives the outage for recovery.
      expect(record?.task.conclusion).toBe("Bountywell API is healthy.");
    } finally {
      await tasks.close();
    }
  });

  test("a stalled Completion Callback confirmation is reported against synthesis", async () => {
    const pendingRecord = {
      evidence: [],
      task: {
        conclusion: "Bountywell inquiry is pending.",
        createdAt: "2026-08-24T09:00:00.000Z",
        id: "task-pending-stalled-callback",
        kind: "bountywell.health.inquiry",
        question: "Is Bountywell healthy?",
        status: "pending",
        updatedAt: "2026-08-24T09:00:00.000Z",
      },
    };
    const session = new RecoverySessionHarness({
      extraCompletedTurns: [
        llm.ChatMessage.create({
          content: "Yes, I confirm.",
          createdAt: 1_787_000_004_000,
          id: "recovery-completed-turn-002",
          role: "user",
        }),
      ],
      stallSaysMatching: "call you back",
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
      logProviderFailure,
    };

    await runLiveKitTelephoneSession(
      {
        ...sessionOptions({
          evidence,
          recordProviderFailure,
          session,
          tasks: {
            async appendTelephoneEvidence() {
              return pendingRecord;
            },
            async submitTelephoneBountywellHealthInquiry() {
              return pendingRecord;
            },
          } as unknown as ReturnType<typeof createDurableTaskRuntime>,
          telephoneSessionId: "telephone-session-callback-stall",
        }),
        endCall,
        async requestCompletionCallback() {
          return { text: "I will call you back once the work is done." };
        },
      },
      dependencies,
    );

    // The Completion Callback was accepted and only its confirmation went
    // unheard, which is the synthesis provider's stall and not the agent's.
    expect(logProviderFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          message: "Speech synthesis produced no audio for this response",
          name: "APITimeoutError",
        },
        provider: "inworld",
        stage: "tts",
      }),
    );
    expect(recordProviderFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: "timeout", stage: "tts" }),
    );
    // The stall spends the session's one replay, which speaks the response the
    // caller last heard rather than composing a second one.
    expect(
      evidence.filter((event) => event.kind === "telephone.provider.retry"),
    ).toHaveLength(1);
    expect(endCall).not.toHaveBeenCalled();
  });

  test("an answer that keeps playing past the stall deadline is spoken to its end", async () => {
    vi.useFakeTimers();
    const tasks = await createTasks("tts-long-answer");
    // Longer than the deadline on the first frame, and short of the
    // prolonged-silence and maximum-duration boundaries.
    const session = new RecoverySessionHarness({ playoutMs: 40_000 });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret() {
          return {
            durationMs: 24,
            intent: "bountywell-health" as const,
            provider: "deterministic-recovery",
          };
        },
      }),
    };

    try {
      const running = runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-long-answer",
          }),
          endCall,
        },
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(45_000);
      await running;

      // The deadline bounds the wait for the first frame alone, so a response
      // that started speaking is never cut off part-way through.
      expect(session.spokenTexts[0]).toContain("Bountywell's API is healthy.");
      expect(session.failurePlaybacks).toBe(0);
      expect(recordProviderFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await tasks.close();
    }
  });

  test("a speech the framework abandoned is reported with the provider error it kept", async () => {
    const tasks = await createTasks("tts-abandoned");
    const session = new RecoverySessionHarness({
      abandonEverySay: true,
      withoutCompletedTurn: true,
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const logProviderFailure = vi.fn();
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret(): Promise<never> {
          throw new Error("The abandoned opening speech answers no turn");
        },
      }),
      logProviderFailure,
    };

    try {
      await runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            openingText: "Hello, this is your operations agent.",
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-abandoned-speech",
          }),
          endCall,
        },
        dependencies,
      );

      expect(session.failurePlaybacks).toBe(1);
      expect(endCall).toHaveBeenCalledTimes(1);
      // Synthesis sees only the agent's own text, so the gateway's account of
      // the outage reaches the operator whole.
      expect(logProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: {
            message: "provider returned no audio before the stall deadline",
            name: "APIStatusError",
            status: 500,
          },
          provider: "inworld",
          stage: "tts",
        }),
      );
    } finally {
      await tasks.close();
    }
  });

  test("a speech whose playout never finishes ends the call once its stall deadline passes", async () => {
    vi.useFakeTimers();
    const tasks = await createTasks("tts-hanging-playout");
    const session = new RecoverySessionHarness({
      hangEverySay: true,
      withoutCompletedTurn: true,
    });
    const recordProviderFailure = vi.fn(async () => ({ ended: false as const }));
    const evidence: TelephoneConversationEvidenceEvent[] = [];
    const endCall = vi.fn(async () => undefined);
    const dependencies: LiveKitTelephoneSessionDependencies = {
      createConversationSession: () => session.asAgentSession(),
      createInterpreter: () => ({
        async close() {},
        async interpret(): Promise<never> {
          throw new Error("The stalled opening speech answers no turn");
        },
      }),
    };

    try {
      const running = runLiveKitTelephoneSession(
        {
          ...sessionOptions({
            evidence,
            openingText: "Hello, this is your operations agent.",
            recordProviderFailure,
            session,
            tasks,
            telephoneSessionId: "telephone-session-hanging-playout",
          }),
          endCall,
        },
        dependencies,
      );
      // Long enough for the framework's own bounded synthesis retry, and short
      // of the prolonged-silence and maximum-duration boundaries.
      await vi.advanceTimersByTimeAsync(30_000);
      await running;

      expect(session.failurePlaybacks).toBe(1);
      expect(endCall).toHaveBeenCalledTimes(1);
      expect(recordProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({ failureClass: "timeout", stage: "tts" }),
      );
    } finally {
      vi.useRealTimers();
      await tasks.close();
    }
  });
});

function turnIdentityOf(
  evidence: readonly TelephoneConversationEvidenceEvent[],
): string {
  const finalized = evidence.find(
    (event) => event.kind === "telephone.turn.finalized",
  );
  if (finalized?.kind !== "telephone.turn.finalized") {
    throw new Error("Expected one finalized telephone turn in evidence");
  }
  return finalized.details.turnId;
}

async function createTasks(
  suffix: string,
): Promise<ReturnType<typeof createDurableTaskRuntime>> {
  const directory = await mkdtemp(
    join(tmpdir(), `voice-agent-livekit-recovery-${suffix}-`),
  );
  temporaryDirectories.push(directory);
  const store = createSqliteDurableTaskStore(
    join(directory, "voice-agent.sqlite"),
  );
  await store.registerBountywell("2026-08-24T09:00:00.000Z");
  const ids = Array.from(
    { length: 16 },
    (_, index) => `${suffix}-id-${index + 1}`,
  );
  return createDurableTaskRuntime({
    applicationRegistry: store,
    healthObserver: {
      async observe() {
        return {
          checks: [
            {
              facts: { statusCode: 200 },
              outcome: "pass" as const,
              source: "public-health" as const,
              summary: "The public health endpoint responded successfully.",
            },
            {
              facts: { statusCode: 401 },
              outcome: "pass" as const,
              source: "authentication-boundary" as const,
              summary: "The protected data endpoint required authentication.",
            },
          ],
          observedAt: "2026-08-24T09:00:01.000Z",
          rejectedEvidenceCount: 0,
        };
      },
    },
    nextId() {
      const id = ids.shift();
      if (id === undefined) {
        throw new Error("The recovery test exhausted its deterministic IDs");
      }
      return id;
    },
    now: () => "2026-08-24T09:00:00.000Z",
    store,
  });
}

function sessionOptions(input: {
  readonly evidence: TelephoneConversationEvidenceEvent[];
  readonly openingText?: string;
  readonly recordProviderFailure: () => Promise<{ readonly ended: false }>;
  readonly session: RecoverySessionHarness;
  readonly tasks: ReturnType<typeof createDurableTaskRuntime>;
  readonly telephoneSessionId: string;
}): Parameters<typeof runLiveKitTelephoneSession>[0] {
  return {
    recognitionModel: defaultRecognizedSpeechModel,
    synthesisModel: defaultConfiguredSpeechSynthesis,
    boundaries: {
      async claimRawAudioCapture() {
        return {
          decision: "rejected" as const,
          reason: "debug-grant-required" as const,
        };
      },
      async claimStateChangingTask() {
        return {
          decision: "accepted" as const,
          resource: "state-changing-task" as const,
        };
      },
      async endSession() {
        return { ended: false as const };
      },
      async noteActivity() {},
      recordProviderFailure: input.recordProviderFailure,
      async releaseStateChangingTask() {
        return {};
      },
      async reserveUsageSlice() {
        return {
          disposition: "continue" as const,
          month: "2026-08",
          reservedSources: [
            "api" as const,
            "telephony" as const,
            "realtime-media" as const,
          ],
          totalMicrousd: 1,
          warnings: [],
        };
      },
    } as unknown as Parameters<
      typeof runLiveKitTelephoneSession
    >[0]["boundaries"],
    disconnected: Promise.resolve(),
    async endCall() {},
    ...(input.openingText === undefined
      ? {}
      : { openingText: input.openingText }),
    room: {} as Room,
    sessionEvidence: {
      async append(event) {
        input.evidence.push({
          ...event,
          sequence: input.evidence.length + 1,
        } as TelephoneConversationEvidenceEvent);
      },
    },
    tasks: input.tasks,
    telephoneSessionId: input.telephoneSessionId,
    usageRatesMicrousdPerMinute: {
      api: 1,
      "realtime-media": 1,
      telephony: 1,
    },
  };
}

class RecoverySessionHarness {
  attemptedSays = 0;
  failurePlaybacks = 0;
  stalledSays = 0;
  readonly spokenTexts: string[] = [];
  readonly #abandonEverySay: boolean;
  readonly #extraCompletedTurns: readonly llm.ChatMessage[];
  readonly #failEverySay: boolean;
  readonly #failSaysMatching: string | undefined;
  readonly #gatewayErrorFrame: unknown;
  readonly #gatewayFrames = new SpeechProviderErrorFrameLog();
  readonly #handlers = new Map<string, (event: never) => void>();
  readonly #hangEverySay: boolean;
  readonly #playoutMs: number | undefined;
  readonly #stallEverySay: boolean;
  readonly #stallSaysMatching: string | undefined;
  readonly #transcriptionTimeout: boolean;
  readonly #withoutCompletedTurn: boolean;

  constructor(
    options: {
      /** The framework abandons every speech and records its provider error. */
      readonly abandonEverySay?: boolean;
      readonly extraCompletedTurns?: readonly llm.ChatMessage[];
      readonly failEverySay?: boolean;
      readonly failSaysMatching?: string;
      /**
       * The raw frame the speech gateway sends before the framework gives up
       * on the stream, exactly as it arrives on the websocket.
       */
      readonly gatewayErrorFrame?: unknown;
      /** The playout of every speech never finishes at all. */
      readonly hangEverySay?: boolean;
      /** Every speech starts audibly and then plays for this long. */
      readonly playoutMs?: number;
      /** The provider accepts every speech and then produces no audio. */
      readonly stallEverySay?: boolean;
      readonly stallSaysMatching?: string;
      readonly transcriptionTimeout?: boolean;
      /** The caller stays silent, so the opening speech is the only speech. */
      readonly withoutCompletedTurn?: boolean;
    } = {},
  ) {
    this.#abandonEverySay = options.abandonEverySay ?? false;
    this.#extraCompletedTurns = options.extraCompletedTurns ?? [];
    this.#failEverySay = options.failEverySay ?? false;
    this.#failSaysMatching = options.failSaysMatching;
    this.#gatewayErrorFrame = options.gatewayErrorFrame;
    this.#hangEverySay = options.hangEverySay ?? false;
    this.#playoutMs = options.playoutMs;
    this.#stallEverySay = options.stallEverySay ?? false;
    this.#stallSaysMatching = options.stallSaysMatching;
    this.#transcriptionTimeout = options.transcriptionTimeout ?? false;
    this.#withoutCompletedTurn = options.withoutCompletedTurn ?? false;
  }

  asAgentSession(): voice.AgentSession {
    const harness = this;
    return {
      async close() {},
      async interrupt() {},
      on(eventType: string, handler: (event: never) => void) {
        harness.#handlers.set(eventType, handler);
        return this;
      },
      output: {
        audio: {
          async captureFrame() {},
          flush() {
            harness.failurePlaybacks += 1;
          },
          async waitForPlayout() {},
        },
      },
      tts: { errorFrames: harness.#gatewayFrames },
      say(text: string) {
        harness.attemptedSays += 1;
        if (
          harness.#failEverySay ||
          (harness.#failSaysMatching !== undefined &&
            text.includes(harness.#failSaysMatching))
        ) {
          if (harness.#gatewayErrorFrame !== undefined) {
            // The gateway reports its error frame and the framework, whose
            // schema keeps none of it, raises this exact message.
            harness.#gatewayFrames.observe(
              Buffer.from(JSON.stringify(harness.#gatewayErrorFrame)),
            );
            throw new APIError("LiveKit TTS returned error: undefined");
          }
          throw new APITimeoutError({ message: "Speech synthesis timed out" });
        }
        if (harness.#abandonEverySay) {
          harness.stalledSays += 1;
          // The framework gave up on the speech and kept the provider's error
          // on the handle instead of failing the awaited playout.
          return {
            done: () => true,
            exception: () =>
              new APIStatusError({
                message: "provider returned no audio before the stall deadline",
                options: { statusCode: 500 },
              }),
            interrupted: false,
            async waitForPlayout() {},
          };
        }
        if (harness.#hangEverySay) {
          harness.stalledSays += 1;
          // The synthesis task is still pending, so its playout never finishes.
          return {
            done: () => false,
            exception: () => undefined,
            interrupted: false,
            waitForPlayout: () => new Promise<void>(() => {}),
          };
        }
        if (
          harness.#stallEverySay ||
          (harness.#stallSaysMatching !== undefined &&
            text.includes(harness.#stallSaysMatching))
        ) {
          harness.stalledSays += 1;
          // The provider accepted the speech and returned no audio: the
          // framework abandons the task, and the awaited playout finishes
          // having said nothing and raised nothing.
          return {
            done: () => true,
            exception: () => undefined,
            interrupted: false,
            async waitForPlayout() {},
          };
        }
        harness.spokenTexts.push(text);
        const playoutMs = harness.#playoutMs;
        return {
          done: () => true,
          exception: () => undefined,
          interrupted: false,
          async waitForPlayout() {
            // A working provider plays its first synthesized frame, which is
            // what moves the agent into speaking, and keeps playing until the
            // whole response has been spoken.
            harness.emit(voice.AgentSessionEventTypes.AgentStateChanged, {
              newState: "speaking",
            });
            if (playoutMs === undefined) return;
            await new Promise<void>((resolve) => {
              setTimeout(resolve, playoutMs);
            });
          },
        };
      },
      async start(input: { agent: voice.Agent }) {
        harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
          createdAt: 1_787_000_000_000,
          newState: "speaking",
        });
        if (harness.#transcriptionTimeout) {
          harness.emit(
            voice.AgentSessionEventTypes.UserTranscriptionTimeout,
            {},
          );
          harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
            createdAt: 1_787_000_001_000,
            newState: "speaking",
          });
        }
        if (harness.#withoutCompletedTurn) return;
        await input.agent.onUserTurnCompleted(
          llm.ChatContext.empty(),
          llm.ChatMessage.create({
            content: "Is Bountywell healthy?",
            createdAt: 1_787_000_002_000,
            id: "recovery-completed-turn-001",
            role: "user",
          }),
        );
        for (const extra of harness.#extraCompletedTurns) {
          harness.emit(voice.AgentSessionEventTypes.UserStateChanged, {
            createdAt: extra.createdAt - 1_000,
            newState: "speaking",
          });
          await input.agent.onUserTurnCompleted(llm.ChatContext.empty(), extra);
        }
      },
    } as unknown as voice.AgentSession;
  }

  private emit(eventType: string, event: unknown): void {
    const handler = this.#handlers.get(eventType);
    if (handler === undefined) {
      throw new Error(`Missing LiveKit handler for ${eventType}`);
    }
    handler(event as never);
  }
}
