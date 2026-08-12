# LiveKit modular speech-pipeline provider recommendation

Research date: 2026-08-11

## Decision summary

For the first Telephone Session slice, start with this independently replaceable pipeline:

| Stage | Slice-1 choice | Evaluation fallback | Why |
| --- | --- | --- | --- |
| STT | `assemblyai/universal-3-5-pro` through LiveKit Inference | `deepgram/flux-general-en` through LiveKit Inference | AssemblyAI exposes the best documented combination for this workload: technical keyterms, conversation and agent context, noise-focused input modes, controllable early/continuous partials, and realtime end-of-turn signals. Flux is the strongest latency/turn-taking challenger. |
| LLM | `openai/gpt-5.6-terra` at medium reasoning through LiveKit Inference as the implementation baseline | GPT-5.6 Sol at low reasoning through LiveKit Inference; Kimi K3 at max reasoning through its direct API only if that provider-path exception is approved | Terra-medium is the responsive quality-first baseline. Sol-low and K3-max test whether more general benchmark intelligence produces a material gain on this project's code-discussion, policy, and tool-use evaluations. |
| TTS | `inworld/inworld-tts-2`, Sarah as the initial stock female voice, `delivery_mode="STABLE"`, through LiveKit Inference | Two other stock female voices over the PSTN path, then `cartesia/sonic-3.5-2026-05-04` if needed | Inworld has explicit stability control, streaming-oriented latency, custom pronunciation, and substantially lower LiveKit pricing. Sarah is the preferred starting voice but the final choice depends on telephone intelligibility and listening fatigue. |
| Turn/VAD | LiveKit audio Turn Detector `v1-mini` plus bundled/Silero VAD | STT-native end-of-turn (`turn_detection="stt"`) | The worker is intentionally self-hosted on the Agent Host; LiveKit selects local `v1-mini` for production agents outside LiveKit Cloud. STT-native endpointing is the direct A/B candidate. |
| Input cleanup | `BVCTelephony` for SIP input | no filter, then Krisp NC | LiveKit specifically recommends the telephony-tuned Krisp model for SIP participants. Only one enhancement layer should run at once. |

These are **benchmark defaults, not permanent provider commitments**. The product requirement is provider replaceability, and none of the providers' own quality or latency claims is sufficient evidence for this application's calls, vocabulary, Agent Host, or mobile networks.

The stages do not share a common billing unit and must not be added into a simple per-minute total. LiveKit lists AssemblyAI Universal-3.5 Pro per input-audio minute and Inworld TTS-2 per generated-audio minute, while the GPT-5.6 models are metered by input, cached-input, and output tokens. A bill forecast must measure an actual Telephone Session and also include LiveKit media/SIP transport, Telnyx, observability, and any Subagent. [LiveKit pricing](https://livekit.com/pricing/inference)

## Scope and non-negotiable boundary

The API-backed LLM in this note is the **Voice Agent's conversational and tool-routing model**. It is not Codex, Claude Code, Grok Build, or Kimi Code. Those are subscription-authenticated Subagents launched asynchronously by a narrow delegation tool. OpenAI explicitly bills its API separately from ChatGPT subscriptions, while LiveKit Inference manages model billing and rate limits through the LiveKit account without requiring separate provider API keys. A ChatGPT/Codex subscription therefore cannot fund `openai/gpt-5.6-terra` inference through LiveKit; it applies only to eligible Codex CLI work performed by a Subagent. [OpenAI account billing separation](https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api), [LiveKit model access and plugins](https://docs.livekit.io/agents/models/)

The first slice should use LiveKit Inference for all three stages. It is zero-data-retention by default for prompts, audio, and model outputs, and it consolidates model usage under one LiveKit project. This is separate from LiveKit Agent observability, which can retain session artifacts if enabled. [LiveKit Inference and ZDR](https://docs.livekit.io/agents/models/inference/)

If a required provider parameter is missing from LiveKit Inference later, the corresponding open-source LiveKit plugin is the escape hatch. Each direct plugin requires its own provider account/key and provider billing. Switching a stage from Inference to a plugin is therefore a credential and billing change, not just a model-string change. [LiveKit plugin model](https://docs.livekit.io/agents/models/)

## 1. Speech to text

### Recommendation: AssemblyAI Universal-3.5 Pro

`assemblyai/universal-3-5-pro` is the most complete documented match for a person walking and discussing servers and code:

- It accepts a `keyterms_prompt` for domain-specific terms and supports LiveKit's provider-neutral static or automatically detected keyterm set. Seed it from the selected repository and Deployment Contract with terms such as `stephens.page`, `Bountywell`, `Keeplore`, `Chart35`, `dailydozen-api.service`, `chart35-api.service`, `systemd`, and route names. Do not inject arbitrary file contents as keyterms. [LiveKit AssemblyAI integration](https://docs.livekit.io/agents/models/stt/assemblyai/), [LiveKit STT keyterms](https://docs.livekit.io/agents/models/stt/)
- It carries prior finalized conversation turns by default and can receive the Voice Agent's most recent spoken reply as `agent_context`. This matters for short, acoustically ambiguous answers during a long technical conversation. [LiveKit AssemblyAI conversation context](https://docs.livekit.io/agents/models/stt/assemblyai/)
- `mode="balanced"` is the provider's voice-agent preset; `continuous_partials` emits updates during long uninterrupted turns, and `interruption_delay` controls the trade-off between early partials for barge-in and first-partial confidence. [LiveKit AssemblyAI parameters](https://docs.livekit.io/agents/models/stt/assemblyai/)
- The model exposes `voice_focus="near-field"` for handsets/headsets and `far-field` for laptop/conference audio. This is useful as a benchmark alternative, but should **not** be stacked with LiveKit `BVCTelephony` until measurements show that double processing helps rather than damages speech. [LiveKit AssemblyAI parameters](https://docs.livekit.io/agents/models/stt/assemblyai/)
- AssemblyAI's current direct list price for Universal-3.5 Pro Realtime is $0.45/hour; keyterm prompting is included, while its own Voice Focus is an additional $0.10/hour. LiveKit lists the base model at the equivalent $0.0075/minute. [AssemblyAI pricing](https://www.assemblyai.com/pricing), [LiveKit pricing](https://livekit.com/pricing)

Suggested starting behavior, not final tuning:

- English only for slice 1.
- `mode="balanced"`.
- Static application/service terms plus dynamic keyterms derived from the live conversation.
- Conversation-context forwarding enabled.
- Continuous partials enabled.
- Provider Voice Focus disabled while LiveKit `BVCTelephony` is enabled.
- LiveKit's own turn detector controls committed turns in the first configuration; AssemblyAI's end-of-turn output becomes the first A/B alternative.

The July 2026 AssemblyAI material claims better accuracy in bad audio from contextual awareness, and its docs expose the necessary controls, but the claim is not a result for Telnyx calls from AT&T/Tello while walking. Treat it as a reason to test the model, not as proof. [AssemblyAI contextual-awareness announcement](https://www.assemblyai.com/blog/contextual-awareness-in-universal-3-5-pro-realtime)

### Fallback: Deepgram Flux

`deepgram/flux-general-en` is the best alternative when turn latency is the primary problem. Flux combines transcription with acoustic/semantic phrase endpointing, supports dynamic keyterms, emits eager end-of-turn/turn-resumed signals, and accepts raw μ-law, A-law, Opus, or linear PCM from 8 to 48 kHz. Deepgram claims about 260 ms end-of-turn detection; that number is vendor-reported and must be remeasured across the actual SIP path. [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart), [Deepgram dynamic keyterms](https://developers.deepgram.com/docs/flux/configure)

LiveKit exposes Flux through Inference, supports `eager_eot_threshold`, `eot_threshold`, `eot_timeout_ms`, and `keyterm`, and can let Flux own the turn boundary with `turn_detection="stt"` while VAD continues to detect interruption. Its Build/Ship list price is $0.0065/minute. [LiveKit Deepgram integration](https://docs.livekit.io/agents/models/stt/deepgram/), [LiveKit pricing](https://livekit.com/pricing)

Flux is the fallback rather than the default because the current AssemblyAI integration documents richer live partial, conversation-context, and noise-focused controls, all relevant to long walk-and-talk code discussions. Flux could still win the benchmark if its integrated turn model materially lowers latency without increasing premature turn commits or technical-term errors.

Deepgram Nova-3 at $0.0048/minute should be retained as a cheap control in the STT benchmark: it has ordinary interim results and keyterm prompting, and Deepgram specifically positions it for background noise, crosstalk, and far-field audio. It is not the designated fallback because it does not provide Flux's integrated conversational end-of-turn model. [Deepgram pricing](https://deepgram.com/pricing), [LiveKit Deepgram integration](https://docs.livekit.io/agents/models/stt/deepgram/)

## 2. Voice Agent LLM

### Implementation baseline: GPT-5.6 Terra at medium reasoning

Use `openai/gpt-5.6-terra` with medium reasoning as the first implemented Voice Agent coordinator. OpenAI describes Terra as the GPT-5.6 tier balancing intelligence and cost; it supports streaming, function calling, and structured outputs. Medium reasoning reflects the user's preference to prioritize intelligence while retaining conversational latency as a meaningful constraint. It is a baseline for representative evaluation, not a permanent winner. [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)

This application needs stronger tool reliability than a generic chat assistant because tool selection controls diagnostic reads, policy-authorized interventions, and Delegation. Terra is preferable to the cheaper Luna tier as the starting point because lower token cost does not compensate for a mistaken operation. The actual decision must be based on task success and end-to-end latency, with token cost measured from the representative calls rather than converted to an assumed per-minute rate. [LiveKit pricing](https://livekit.com/pricing/inference)

Keep the Voice Agent tool surface narrow. The LLM should not directly operate a shell or parse a Subagent's full event stream. It should call typed functions such as `check_application_health`, `start_incident_response`, and `delegate_to_subagent`; deterministic code enforces the Standing Autonomy Policy, creates the durable task, and returns a task identifier. LiveKit function tools derive schemas from typed signatures, and its async-tool mechanism lets long-running work report progress, receive cancellation, and continue while the Voice Agent talks. [LiveKit function tools](https://docs.livekit.io/agents/logic/tools/definition/), [LiveKit async tools](https://docs.livekit.io/agents/logic/tools/async/)

During slice one, a Telephone Session uses one coordinator model from start to finish. Model comparisons use separate otherwise-equivalent sessions so conversation continuity is preserved and evaluation results remain attributable. Automatic mid-session routing is deferred until evidence identifies a repeatable task category that benefits from it.

The coordinator may perform a Code Inquiry through narrow read-only tools that search only registered repositories and return code-enforced bounded excerpts. This supports immediate conversational questions without waiting for a Subagent. Broad multi-file analysis, tests, and every code change remain Delegations to Codex. Spoken depth is adaptive: short acknowledgements and progress updates should be immediate, while the user may ask for a slower, substantive explanation and may interrupt or redirect it naturally.

The async tool is essential for this product. Codex can work for minutes while the Telephone Session continues or ends, and the Completion Callback happens later. The Voice Agent model only needs to decide to delegate, communicate milestones, and interpret the final bounded result. Codex itself remains the subscription-backed Subagent selected for slice 1; its reasoning and token use are not part of the Voice Agent LLM price.

### Quality challengers: GPT-5.6 Sol low and Kimi K3 max

Evaluate `openai/gpt-5.6-sol` at low reasoning through LiveKit Inference. OpenAI identifies Sol as its frontier GPT-5.6 model for complex professional work. The cited Artificial Analysis snapshot reports only a modest Intelligence Index lead over Terra-medium while imposing materially greater first-chunk latency, so Sol should replace Terra only if it improves project-specific task success, safe tool selection, or code discussion. [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Artificial Analysis leaderboard](https://artificialanalysis.ai/leaderboards/models)

Evaluate `kimi-k3` at max reasoning only if a direct-provider exception to the LiveKit Inference decision is approved. Kimi documents K3 as its flagship model for long-horizon coding and knowledge work, with streaming, structured output, required/automatic tool choice, a 1M-token context, and `low`, `high`, or `max` reasoning. LiveKit Inference currently exposes Kimi K2 Instruct, K2.5, and K2.6 but not K3, so K3 requires a Moonshot API key, direct provider billing, and explicit validation of retention and disclosure controls. [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [LiveKit Kimi integration](https://docs.livekit.io/agents/models/llm/kimi/)

Artificial Analysis reports general cross-task indicators, not Voice Agent policy or operations evaluations. Treat Intelligence Index, first-chunk latency, output speed, and cost per task as screening evidence. Correctness and safe tool behavior are mandatory gates; among configurations that pass, compare end-of-turn-to-first-audible-speech and cost. At the reported output rates, all three candidates generate text far faster than it can be spoken, so output tokens per second is not a primary differentiator for this pipeline.

## 3. Text to speech

### Recommendation: Inworld Realtime TTS-2

Use `inworld/inworld-tts-2` with Sarah as the initial stock female voice and `delivery_mode="STABLE"`. Inworld currently presents Sarah as its website playground default, and LiveKit says LiveKit Inference supports all default voices exposed by the Inworld API. The final voice selection remains contingent on a comparison over the actual Telnyx PSTN path. The LiveKit integration supports streaming-oriented use, speaking-rate control, word or character timestamps, text normalization, and the explicit `STABLE`/`BALANCED`/`CREATIVE` consistency control. [Inworld](https://inworld.ai/), [LiveKit Inworld integration](https://docs.livekit.io/agents/models/tts/inworld/)

Inworld documents custom inline IPA pronunciation, streaming generation, and a `STABLE` mode intended for predictable speech. It reports roughly 200 ms median first-audio latency for TTS-2, but that is provider latency rather than first audible telephone audio and must not be treated as the call's latency. [Inworld TTS overview](https://docs.inworld.ai/tts/tts), [Inworld audio generation](https://docs.inworld.ai/tts/capabilities/generating-audio), [Inworld release notes](https://docs.inworld.ai/release-notes/tts)

For technical terms, build a code-controlled pronunciation map before text reaches TTS. It should cover stable project names, domains, abbreviations, route syntax, and service names. The Evidence Record must retain the original semantic text; pronunciation markup is a render-layer artifact, not the canonical answer. Avoid asking the LLM to invent IPA on every turn.

LiveKit lists Inworld TTS-2 at $0.015/minute of generated speech. Inworld's direct on-demand price is $25 per million characters, with lower subscription tiers, but slice 1 should use the LiveKit price/credential path. [LiveKit pricing](https://livekit.com/pricing), [Inworld pricing](https://inworld.ai/pricing)

### Fallback: Cartesia Sonic 3.5

Use the pinned `cartesia/sonic-3.5-2026-05-04` model as the evaluation fallback, not a `latest` alias. LiveKit exposes speed, volume, emotion, buffer delay, and word timestamps. Cartesia supports one-off inline IPA overrides; the direct plugin additionally accepts a reusable pronunciation-dictionary ID. [LiveKit Cartesia integration](https://docs.livekit.io/agents/models/tts/cartesia/)

Cartesia is the best pronunciation-control challenger, especially if the Voice Agent accumulates many repository-specific names. Through LiveKit Inference it costs $0.030/minute, twice Inworld TTS-2's listed rate. If a reusable Cartesia pronunciation dictionary proves materially better than inline transforms, using it through the direct plugin would add a Cartesia account/key and Cartesia billing. [LiveKit pricing](https://livekit.com/pricing), [LiveKit Cartesia plugin authentication](https://docs.livekit.io/agents/models/tts/cartesia/)

## 4. Turn detection, interruption, VAD, and walking noise

### Turn boundary

LiveKit's current audio Turn Detector combines semantic and acoustic cues. The full `v1` model runs through LiveKit Inference; `v1-mini` runs locally on CPU. A production agent started in another environment—this project's intended worker on `stephens.page`—defaults to `v1-mini`, whereas LiveKit-hosted deployment or local `dev` mode with Cloud credentials selects `v1`. The distinction must be explicit in configuration and Evidence Records; a successful dev test with `v1` does not prove the production `v1-mini` path. [LiveKit Turn Detector](https://docs.livekit.io/agents/logic/turns/turn-detector/)

Start with `v1-mini`, the default calibrated threshold, and the detector's default endpointing range. It requires VAD with at least 250 ms minimum silence; LiveKit's documented Silero default is 550 ms. The fallback experiment sets `turn_detection="stt"` and lets AssemblyAI or Flux provide the end-of-turn signal. Do not silently layer an extra LiveKit endpointing delay on top of an STT provider's delay; LiveKit documents that the two delays can be additive in STT mode. [LiveKit Turn Detector](https://docs.livekit.io/agents/logic/turns/turn-detector/), [LiveKit Silero VAD](https://docs.livekit.io/agents/logic/turns/vad/), [LiveKit turn-handling reference](https://docs.livekit.io/reference/python/livekit/agents/)

### Interruption

Keep VAD enabled even when the STT owns end-of-turn detection, because LiveKit uses VAD to notice that the caller has started talking over the agent. Configure false-interruption recovery so a traffic burst or empty transcript can resume the interrupted speech. [LiveKit turns guide](https://docs.livekit.io/agents/logic/turns/)

LiveKit's adaptive interruption model can distinguish intended barge-ins from backchannels, but its documented availability is for agents deployed to LiveKit Cloud or running in dev mode. The self-hosted Agent Host worker must not assume it is available; use VAD interruption first and treat adaptive interruption as a separately verified capability if LiveKit later exposes it to this deployment topology. [LiveKit adaptive interruption handling](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/)

### Noise and competing speakers

For a SIP participant, use LiveKit's `BVCTelephony` input filter first. LiveKit's turn-tuning guide specifically says to replace the ordinary voice-isolation model with its telephony-tuned Krisp model for SIP calls. Enhanced cancellation works when media travels through LiveKit Cloud even if the agent runs elsewhere. [LiveKit turn tuning](https://docs.livekit.io/agents/logic/turns/tuning/), [LiveKit noise cancellation](https://docs.livekit.io/transport/media/noise-cancellation/)

Do not blindly stack Telnyx processing, LiveKit `BVCTelephony`, and AssemblyAI Voice Focus. Compare one enhancement layer at a time against an unfiltered control. Walking includes at least two different problems: traffic/wind (non-speech noise) and nearby people (competing speech). A filter that helps one can erase quiet syllables or technical identifiers in the other.

## 5. Telnyx SIP and the audio-quality ceiling

Configure a Telnyx number with HD Voice and offer **G.722 plus PCMU** on the SIP connection. LiveKit's own Telnyx setup guide says to enable HD Voice on the number, enable G.722, and retain G.711 μ-law for compatibility. LiveKit's codec reference lists PCMU/PCMA/G.722 as defaults and AMR-WB as an optional 16 kHz HD codec. [LiveKit Telnyx setup](https://docs.livekit.io/telephony/start/providers/telnyx/), [LiveKit SIP codec support](https://docs.livekit.io/reference/telephony/codecs-negotiation/)

Telnyx's current LiveKit guide also claims Opus at 48 kHz is available when SRTP is enabled and says it is preferred over G.722. However, LiveKit's current general codec/API reference lists only PCMU, PCMA, G.722, and AMR-WB—not Opus. This first-party documentation mismatch means Opus must not be a slice-1 dependency. Verify what the actual LiveKit project API accepts and inspect the negotiated SDP/RTP codec before enabling it. [Telnyx LiveKit guide](https://developers.telnyx.com/docs/livekit/telephony), [LiveKit SIP API](https://docs.livekit.io/reference/telephony/sip-api/)

HD on the Telnyx-to-LiveKit SIP leg does not guarantee HD from the Android handset. Telnyx states that the number, SIP connection, receiving device, and mobile coverage/carrier path must all support an HD codec for an outbound HD call. A narrowband PSTN/mobile leg cannot be repaired by later upsampling. [Telnyx HD Voice requirements](https://support.telnyx.com/en/articles/8394071-hd-voice-number-feature)

Every benchmark result must therefore record the negotiated codec. Run the same script from both AT&T and Tello and from the actual Android handset/Bluetooth setup. The later PWA WebRTC slice will have a different, generally wider-band input path and must be benchmarked separately rather than assumed equivalent.

## 6. Credentials, billing, retention, and observability

### Slice-1 credential layout

- One dedicated personal LiveKit Cloud project supplies media/SIP connectivity and LiveKit Inference credentials.
- One dedicated personal Telnyx account/project supplies the number and PSTN/SIP billing.
- No AssemblyAI, OpenAI API, Google AI, Inworld, or Cartesia key is needed while the selected models are accessed through LiveKit Inference.
- Codex's subscription authentication belongs only to the restricted Subagent Linux identity; do not expose that credential to the Voice Agent model process or mistake it for OpenAI API capacity.
- Disable provider auto-top-ups where possible and apply LiveKit/Telnyx budget/rate limits consistent with the Standing Autonomy Policy.

LiveKit Inference includes $2.50 of credits on Build and $5 on Ship, with per-model overage billing and aggregate Inference concurrency limits. LiveKit third-party SIP minutes also have plan allowances before overage. [LiveKit pricing](https://livekit.com/pricing)

### Evidence without raw call retention

LiveKit Agent Insights can work with a self-hosted agent connected to LiveKit Cloud, but its default recording mode uploads audio, transcripts, traces, and logs. That conflicts with the decision not to retain raw telephone audio by default and may also bypass the code-enforced Bounded Excerpt path. Explicitly disable Cloud audio recording—and preferably collect the redacted transcript, tool events, and metrics locally into the Evidence Record rather than relying on default Insights retention. LiveKit supports granular recording flags and local data hooks. [LiveKit Agent Insights](https://docs.livekit.io/deploy/observability/insights/), [LiveKit data hooks](https://docs.livekit.io/deploy/observability/data/)

LiveKit Inference ZDR does not disable Agent Insights and does not sanitize application logs. Filter transcripts, tool arguments/results, model prompts, and provider error payloads in code before persistence or hosted observability.

## 7. Benchmark plan: what must be measured

Do not select providers from vendor demo audio or vendor-reported latency. Run a vertical-slice benchmark through **Android → AT&T/Tello → Telnyx → LiveKit Cloud → worker on the Agent Host → models → LiveKit/Telnyx → Android**.

### Corpus and environments

Use a fixed script containing:

- The slice-1 health request and Bountywell outage drill.
- Short confirmations, mid-sentence pauses, self-corrections, and interruptions such as “wait—don't restart it.”
- Long walk-and-talk turns about code, followed by a Delegation request.
- Technical terms: `stephens.page`, `Bountywell`, `Keeplore`, `Chart35`, `dailydozen-api.service`, `chart35-api.service`, `systemctl`, `/api/data`, `main`, GitHub, Codex, and realistic branch/file names.
- Digits, punctuation, URLs, mixed-case identifiers, and spelled-out tokens.

Record tests in quiet indoor audio, ordinary street traffic, wind, nearby speakers, handset mode, wired/Bluetooth headset, and weak/strong mobile signal. Repeat through both AT&T and Tello. Temporary raw audio may be retained only under the already-agreed debugging mode and automatic expiry; permanent results should be derived metrics and redacted transcripts.

### STT/turn metrics

- Technical-term error rate and overall word error rate.
- First useful partial latency, partial revision rate, final-transcript delay, and transcript stability.
- Premature end-of-turn rate, excessive-wait rate, and recovery after a resumed turn.
- False interruption and missed interruption rates, including time from barge-in to audible stop.
- Accuracy with static keyterms, dynamic keyterms, and no keyterms.
- `BVCTelephony` versus unfiltered input; only then compare provider Voice Focus or Krisp NC.
- Negotiated Telnyx/LiveKit codec for every sample.

LiveKit emits end-of-utterance delay, transcription delay, LLM time to first token, TTS time to first byte, and per-turn end-to-end metrics. Capture these locally in the Evidence Record rather than inventing timing around application logs. [LiveKit data hooks and latency metrics](https://docs.livekit.io/deploy/observability/data/)

### LLM/tool metrics

- Correct tool choice and exact schema-valid arguments.
- Correct refusal or escalation outside the Standing Autonomy Policy.
- No claim that a Subagent completed before the durable job reports completion.
- Correct behavior when a tool times out, returns partial evidence, is cancelled, or emits a conflicting result.
- Ability to remain conversational while an async Delegation is running, accept a redirect/cancel request, and summarize a later completion.
- Spoken-answer brevity and factual agreement with the Evidence Record.
- End-of-turn to first LLM token, full tool loop latency, input/output tokens, and cost.

Compare Terra-medium, Sol-low, and—only after approval of its direct-provider path—Kimi K3-max. Correctness, policy compliance, and safe tool behavior are gates. Among passing configurations, compare end-of-turn-to-first-audible-speech at p50 and p95, full tool-loop latency, interruptions, cost, and user preference. Output speed is secondary once it is comfortably faster than spoken playback. Promotion requires a fixed evaluation threshold; do not use subjective “felt good” or a general leaderboard score alone.

### TTS metrics

- Time from first LLM text chunk to first audible telephone audio, not provider TTFB alone.
- Intelligibility on narrowband PCMU and negotiated HD codecs.
- Correct pronunciation of every technical term and URL.
- Voice identity/stability over a 30–60 minute session and across repeated identical phrases.
- Naturalness of short acknowledgements, progress updates, uncertainty, and incident conclusions.
- Audio-stop latency and absence of stale buffered speech after interruption.
- Effect of Inworld `STABLE` versus `BALANCED`, and Inworld versus pinned Cartesia Sonic 3.5.

## Slice-1 implementation posture

Implement providers behind the native LiveKit `STT`, `LLM`, and `TTS` interfaces, but avoid a speculative custom provider abstraction until a second implementation exposes a real mismatch. Pin the explicit model IDs above; never use `chat-latest`, `sonic-latest`, or an automatic provider selector in an auditable operational agent.

Ship the smallest end-to-end path with:

1. Telnyx callback into a LiveKit SIP room with codec recorded.
2. LiveKit `BVCTelephony` input cleanup and local VAD.
3. AssemblyAI Universal-3.5 Pro with scoped technical keyterms and context forwarding.
4. LiveKit Turn Detector `v1-mini`, with STT-native turn detection implemented as the first experiment flag.
5. GPT-5.6 Terra at medium reasoning with only the bounded health/evidence tools needed for slice 1.
6. Inworld TTS-2 using Sarah in `STABLE` mode with a deterministic pronunciation transform; compare the final voice over PSTN.
7. Local Evidence Record events and latency/usage metrics; LiveKit raw-audio recording disabled.

The first provider switch should be a configuration-and-evaluation exercise, not an architecture project. If any stage cannot be replaced independently after this slice, the implementation has violated the modular-pipeline decision.
