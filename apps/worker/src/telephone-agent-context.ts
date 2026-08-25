import { inference } from "@livekit/agents";

import type { RecognizedSpeechModel } from "@voice-agent/contracts";
import { TelephoneSessionFault } from "@voice-agent/runtime";

/**
 * The Voice Agent's most recent spoken reply, pushed to the live transcriber so
 * the caller's next turn is recognized against what they were just asked.
 *
 * This is a per-turn value, not a setting: it changes with every reply, and the
 * entry it belongs to decides whether it is sent at all. An entry whose gateway
 * does not accept the option never receives it, because a gateway ignores an
 * option it does not know without saying so, which would read as a bias that
 * was applied when none was.
 *
 * `agent_context` is AssemblyAI's own spelling of it. It is written here rather
 * than in the Recognized Speech Model set because only this module talks to the
 * agents framework's typed option surface.
 */
export function createAgentContextBias(
  recognition: RecognizedSpeechModel,
  transcriber: unknown,
): (reply: string) => void {
  const bias = recognition.agentContext;
  if (bias === undefined) return () => {};
  // Only an Inference transcriber updates a running recognition connection,
  // and only its options are typed as the ones this entry's gateway accepts.
  // An entry was selected for this bias, so a transcriber that cannot carry it
  // is a wiring fault worth raising rather than a call quietly running without
  // the one thing that entry was chosen for.
  if (!(transcriber instanceof inference.STT)) {
    throw new TelephoneSessionFault(
      "Telephone transcriber cannot accept the agent context this recognition model was selected for",
    );
  }
  const live = transcriber as inference.STT<"assemblyai/universal-3-5-pro">;
  let sent: string | undefined;
  return (reply) => {
    const context = boundAgentContext(reply, bias.maximumCharacters);
    // A Bounded Provider Retry replays the same response; resending it would
    // spend a gateway update saying nothing new.
    if (context === "" || context === sent) return;
    sent = context;
    live.updateOptions({ modelOptions: { agent_context: context } });
  };
}

/**
 * The reply cut to what the gateway accepts.
 *
 * The end is what survives a cut: the caller is answering the question the
 * reply finished on, so the last sentence biases their turn and an opening the
 * reply has moved past does not. A cut that would start mid-word starts at the
 * next word instead, so the transcriber is never biased toward a fragment.
 */
export function boundAgentContext(
  reply: string,
  maximumCharacters: number,
): string {
  const text = reply.trim();
  if (text.length <= maximumCharacters) return text;
  const tail = text.slice(text.length - maximumCharacters);
  const wordBreak = tail.search(/\s/u);
  return (wordBreak === -1 ? tail : tail.slice(wordBreak)).trim();
}
