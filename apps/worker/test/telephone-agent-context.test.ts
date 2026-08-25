import { initializeLogger } from "@livekit/agents";
import {
  recognizedSpeechModels,
  type RecognizedSpeechModel,
} from "@voice-agent/contracts";
import { describe, expect, test } from "vitest";

import { createConversationRecognitionSTT } from "../src/livekit-telephone-session.ts";
import {
  boundAgentContext,
  createAgentContextBias,
} from "../src/telephone-agent-context.ts";

initializeLogger({ level: "silent", pretty: false });
process.env.LIVEKIT_API_KEY ??= "agent-context-key";
process.env.LIVEKIT_API_SECRET ??= "agent-context-secret-agent-context";
process.env.LIVEKIT_URL ??= "ws://127.0.0.1:1";

const contextual = recognizedSpeechModels["assemblyai/universal-3-5-pro"];
const multilingual =
  recognizedSpeechModels["assemblyai/universal-streaming-multilingual"];
const deepgram = recognizedSpeechModels["deepgram/flux-general-en"];

/**
 * The transcriber an entry actually builds, recording the option updates it is
 * given. It is the real Inference transcriber, because only that one carries
 * the seam a per-turn option reaches a running connection through.
 */
function recordingTranscriber(recognition: RecognizedSpeechModel): {
  readonly transcriber: unknown;
  readonly updates: Record<string, unknown>[];
} {
  const transcriber = createConversationRecognitionSTT(recognition);
  const updates: Record<string, unknown>[] = [];
  transcriber.updateOptions = (options: {
    readonly modelOptions?: Record<string, unknown>;
  }) => {
    if (options.modelOptions !== undefined) updates.push(options.modelOptions);
  };
  return { transcriber, updates };
}

describe("bounding the reply a transcriber is biased with", () => {
  test("a reply within the bound is sent whole", () => {
    expect(boundAgentContext("Is that right?", 1_500)).toBe("Is that right?");
  });

  test("an over-long reply keeps its end, which is what the caller answers", () => {
    const reply = `${"a ".repeat(40)}confirm the restart?`;

    const bounded = boundAgentContext(reply, 24);

    expect(bounded.length).toBeLessThanOrEqual(24);
    expect(reply.endsWith(bounded)).toBe(true);
    expect(bounded).toContain("confirm the restart?");
  });

  test("a truncation never leaves the tail of a cut word", () => {
    expect(boundAgentContext("restart dailydozen-api now", 12)).toBe("now");
  });

  test("a reply of nothing but whitespace bounds to nothing", () => {
    expect(boundAgentContext("   \n ", 1_500)).toBe("");
  });
});

describe("biasing the caller's next turn with the agent's last reply", () => {
  test("the contextual entry receives the reply as agent_context", () => {
    const transcriber = recordingTranscriber(contextual);
    const bias = createAgentContextBias(contextual, transcriber.transcriber);

    bias("Should I restart dailydozen-api?");

    expect(transcriber.updates).toStrictEqual([
      { agent_context: "Should I restart dailydozen-api?" },
    ]);
  });

  test("each reply replaces the one before it", () => {
    const transcriber = recordingTranscriber(contextual);
    const bias = createAgentContextBias(contextual, transcriber.transcriber);

    bias("Should I restart dailydozen-api?");
    bias("Bountywell's API is healthy.");

    expect(transcriber.updates).toStrictEqual([
      { agent_context: "Should I restart dailydozen-api?" },
      { agent_context: "Bountywell's API is healthy." },
    ]);
  });

  test("before the first reply nothing is sent at all", () => {
    const transcriber = recordingTranscriber(contextual);

    createAgentContextBias(contextual, transcriber.transcriber);

    expect(transcriber.updates).toStrictEqual([]);
  });

  test("a reply repeated by a bounded retry is not sent twice", () => {
    const transcriber = recordingTranscriber(contextual);
    const bias = createAgentContextBias(contextual, transcriber.transcriber);

    bias("Should I restart dailydozen-api?");
    bias("Should I restart dailydozen-api?");

    expect(transcriber.updates).toHaveLength(1);
  });

  test("a reply longer than the gateway accepts is truncated rather than sent", () => {
    const transcriber = recordingTranscriber(contextual);
    const bias = createAgentContextBias(contextual, transcriber.transcriber);

    bias("x".repeat(4_000));

    const sent = transcriber.updates[0]?.agent_context;
    expect(typeof sent).toBe("string");
    expect(String(sent)).toHaveLength(
      contextual.agentContext.maximumCharacters,
    );
  });

  test("a reply of nothing but whitespace is not sent", () => {
    const transcriber = recordingTranscriber(contextual);
    const bias = createAgentContextBias(contextual, transcriber.transcriber);

    bias("  ");

    expect(transcriber.updates).toStrictEqual([]);
  });

  test("an entry whose gateway does not accept the option is never sent one", () => {
    for (const entry of [multilingual, deepgram]) {
      const transcriber = recordingTranscriber(entry);
      const bias = createAgentContextBias(entry, transcriber.transcriber);

      bias("Should I restart dailydozen-api?");

      expect(transcriber.updates).toStrictEqual([]);
    }
  });

  test("a transcriber that cannot carry the option raises rather than running without it", () => {
    // The entry was selected for this bias, so a call that silently ran
    // without it would deliver the setting and none of its benefit.
    expect(() =>
      createAgentContextBias(contextual, {
        model: "assemblyai/universal-3-5-pro",
      }),
    ).toThrow(/agent context/u);
  });

  test("an entry that never carries it takes any transcriber", () => {
    expect(() => createAgentContextBias(deepgram, {})).not.toThrow();
  });
});
