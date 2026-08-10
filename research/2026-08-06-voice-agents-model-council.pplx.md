# Where Models Agree

| Finding                                                                                           | GPT-5.6 Sol Thinking | Claude Opus 5 Thinking | Kimi K3 | Evidence                                                                  |
| :------------------------------------------------------------------------------------------------ | :------------------- | :--------------------- | :------ | :------------------------------------------------------------------------ |
| Dropping Claude Code makes this simpler — you need no coding-agent harness at all                 | ✓                    | ✓                      | ✓       | The voice vendor's tool loop *is* the agent loop for v1                   |
| Never expose a generic `run_shell`/SSH tool to the voice agent                                    | ✓                    | ✓                      | ✓       | Makes the model your only security control; blast radius is total[^1][^2] |
| Build a narrow, explicit tool gateway on the VM instead                                           | ✓                    | ✓                      | ✓       | Structured tools with allowlists, not credentials handed to the LLM       |
| Three-tier permissions: auto read → approval-gated writes → never-exposed                         | ✓                    | ✓                      | ✓       | Read tier covers ~90% of real questions                                   |
| Approval must be an authenticated click, never a spoken "yes"                                     | ✓                    | ✓                      | ✓       | Spoken confirmation is unreliable and replayable                          |
| Postgres: dedicated read-only role, `READ ONLY` txn, `statement_timeout`, row caps, curated views | ✓                    | ✓                      | ✓       | "Read-only MCP" isn't safe unless enforced below the model[^3][^4][^5]    |
| Tools must return spoken summaries + visual evidence, not raw payloads                            | ✓                    | ✓                      | ✓       | 200 rows returned = 200 rows of speech                                    |
| A companion web/PWA console (transcript, tool calls, diffs, approvals) is mandatory               | ✓                    | ✓                      | ✓       | Voice is bad for filenames, SQL, diffs, stack traces                      |
| Do NOT co-locate local STT/TTS/LLM inference on your DO box                                       | ✓                    | ✓                      | ✓       | Your VM has already hit 99% memory under agent workloads                  |
| Cloudflare Access or Tailscale in front of the control plane                                      | ✓                    | ✓                      | ✓       | Self-hosted Access app means zero OAuth code in your server[^6][^7]       |
| OpenAI Realtime is the strongest option if you prioritize conversational feel                     | ✓                    | ✓                      | ✓       | Remote MCP via `server_url`, plus SIP[^8][^9][^10]                        |
| Long investigations must be async jobs, never inside a voice turn                                 | ✓                    | ✓                      | ✓       | "Let me dig into that" + stream results back[^11]                         |
| Zero-write policy for the initial deployment                                                      | ✓                    | ✓                      | ✓       | Add mutations only after read-only has an audit trail                     |

# Where Models Disagree

| Topic | GPT-5.6 Sol Thinking | Claude Opus 5 Thinking | Kimi K3 | Why They Differ |
| :-- | :-- | :-- | :-- | :-- |
| **Primary voice layer** | LiveKit Agents | **ElevenLabs Agents** (hosted) | LiveKit Agents | Claude Opus 5 Thinking found ElevenLabs' built-in per-tool approval UI; the others assume you build it |
| Is MCP needed for v1? | **No** — plain local function tools; MCP only for cross-agent reuse | **Yes** — MCP-over-HTTP is the load-bearing thin waist | Yes, MCP-compatible gateway | GPT-5.6 Sol Thinking optimizes for security simplicity; Claude Opus 5 Thinking optimizes for vendor swappability |
| Internet-exposing your VM | Avoid; Tailscale-only is fine with LiveKit | **Unavoidable** with hosted vendors — a real threat-model change | Private behind Tailscale/CF Access, "never unauthenticated" | Claude Opus 5 Thinking traced who executes the tool: OpenAI/ElevenLabs call *your* box[^9] |
| Time to working demo | Weekend | **2–3 hours today** | Phase 1 = weeks | Direct consequence of hosted-vs-self-built |
| Language | TypeScript gateway | Python (FastMCP) | TypeScript | Claude Opus 5 Thinking weights FastMCP's documented auth middleware[^12][^13]; others weight your stack |
| Gemini Live API | Not mentioned | **Ranked \#3, "the sleeper"** — MCP landed Mar 2026[^14] | Not as a voice option | Only Claude Opus 5 Thinking surfaced the March 2026 MCP addition |
| Non-Anthropic agent harness | Not needed | **Goose or `opencode serve`** as an `investigate()` tool[^15][^16] | Own async job queue | Claude Opus 5 Thinking took "not Anthropic" as a literal requirement to satisfy |
| Free-form SQL | `query_readonly(sql, max_rows, timeout)` is a first-class tool | **Named queries primary**, free-form is fallback only | Curated `ops.*` views, `purpose` field required | Different trust in the model's SQL under voice-only review |

# Unique Discoveries

| Model | Unique Finding | Why It Matters |
| :-- | :-- | :-- |
| Claude Opus 5 Thinking | **ElevenLabs Fine-Grained Tool Approval** — per-tool auto-approved / requires-approval / **disabled**, configured in a dashboard[^17] | Your exact read-vs-write boundary as vendor config instead of hand-written code; `exec_shell` disabled at platform level, not by prompt |
| Claude Opus 5 Thinking | **Remote MCP tools are executed by the Realtime API itself** — your client never runs the tool, it only listens for `mcp_list_tools.*` / `mcp_call.*` events and answers `mcp_approval_request`[^9] | Inverts the security model: OpenAI's infra must reach your VM. This alone rules out a Tailscale-only deployment for that path |
| Claude Opus 5 Thinking | **Cloudflare MCP Server Portals** — open beta July 2026, Access enforces which MCP servers a user reaches independent of the server's own authz[^18] | You already run Cloudflare; this is near-zero-effort centralized MCP gatekeeping |
| Claude Opus 5 Thinking | **Per-turn MCP scoping** via `response.tools` instead of `session.tools`[^9] | A write-capable MCP server that only exists for one explicitly-invoked turn — elegant mutation gating |
| Claude Opus 5 Thinking | **Goose works as an ACP server and can use ACP agents (Claude Code, Codex) as providers**[^15] | Model-agnosticism at the harness layer — swap Gemini/GPT/DeepSeek/local behind one agent |
| Claude Opus 5 Thinking | **MCP spec 2025-03-26**: Streamable HTTP (single `/mcp` endpoint, stateless behind load balancers) + OAuth 2.1 with PKCE, DCR, and RFC 8707 Resource Indicators so tokens can't be replayed across servers[^19][^20] | The technical reason "write the tools once, A/B the voice stack in an afternoon" actually holds |
| GPT-5.6 Sol Thinking | **The agent worker runs *on* the VM**, so it needs neither SSH nor a public "run command" endpoint | The cleanest possible answer to your question — the security problem partly dissolves via placement |
| GPT-5.6 Sol Thinking | A typed `ToolResult<T>` with `{ok, data, spokenSummary, evidence[]}` on every tool | Structurally prevents the model reading 500 lines of `journalctl` aloud |
| GPT-5.6 Sol Thinking | Managed platforms (Vapi/Retell/Telnyx) fit **ETA's customer-facing agent**, not your personal ops agent[^21][^22] | Cleanly separates your two active voice projects |
| Kimi K3 | **Per-task model routing**: deep investigation → Claude/GPT/Gemini; quick ops → cheap fast model; sensitive → local | Directly serves your multi-LLM cost-optimization interest; the real argument against hosted lock-in |
| Kimi K3 | **Qwen3-Omni** is the first Level-2 open speech-to-speech model with native function calling via `<tool_call>` tags[^23][^24]; Voxtral TTS runs on one 16GB GPU via vLLM-Omni[^25][^26] | The fully-sovereign path exists now — but note Voxtral is CC BY-NC |
| Kimi K3 | Four-channel voice UX: spoken ack → visual activity stream → short spoken conclusion → detailed written report | The most concrete UX spec of the three |

# Comprehensive Analysis

## High-Confidence Findings

The most important convergence is that **all three models told you to stop looking for an agent harness**. Once the requirement is "voice talk with something that can call tools on my VM," the coding agent is dead weight — GPT-5.6 Sol Thinking states it plainly ("you do not need a coding agent at all"), Claude Opus 5 Thinking reduces the minimum viable system to two components, and Kimi K3 reframes the product as "a private, voice-first operations copilot" rather than voice Claude Code. That reframing is the actual answer to your question. Every hosted realtime voice platform now consumes tools natively — OpenAI Realtime via `mcp` with `server_url`, ElevenLabs via SSE/streamable-HTTP MCP servers, Gemini Live since March 2026 — so the tool loop you'd have borrowed from Claude Code is already provided.[^9][^14][^17]

The second unanimous point, and the one worth tattooing somewhere: **do not use an SSH MCP server.** Claude Opus 5 Thinking specifically named the tempting off-the-shelf options (`tufantunc/ssh-mcp`, `giuliolibrando/ssh-mcp-server`) that execute arbitrary shell commands on remote Linux hosts in about five minutes of setup, and then explained precisely why not: you'd be handing an always-listening speech model an unrestricted shell on the same box that runs your orchestration agents and reads production data. The blast radius of one misheard utterance — or one prompt injection embedded in a log line the agent reads — is total. All three models independently arrived at the same replacement: narrow, explicitly-typed tools with allowlists enforced *in code*, plus an allowlisted `run_diagnostic(name, args)` against a fixed command table if you want any shell at all. GPT-5.6 Sol Thinking's contrast is the clearest statement of the principle: `runShell({command})` is bad; `getServiceLogs({service, sinceMinutes, severity})` is correct.[^1][^2][^27]

Third, all three converged on the **voice-specific design constraint that text-agent instincts get wrong**: tools must return summaries, not payloads. Claude Opus 5 Thinking's formulation is that a tool returning 200 rows produces 200 rows of speech, so `query_readonly` should return `{row_count, columns, aggregate_summary, sample: [3 rows], full_result_url}`. GPT-5.6 Sol Thinking encodes this into the type system with `ToolResult<T>` carrying both `data` and `spokenSummary`. Kimi K3 splits it into four channels — immediate spoken acknowledgment, visual activity stream, short spoken conclusion, detailed written report — and states the constraint bluntly: voice is excellent for steering and discussing state, and terrible for filenames, SQL, diffs, and stack traces. This is why the companion web console isn't optional polish; it's half the product.

## Areas of Divergence

**The central disagreement is hosted-vs-self-built, and it splits 2-1 with an asymmetry in the evidence.** GPT-5.6 Sol Thinking and Kimi K3 both recommend LiveKit Agents with a worker on your VM; Claude Opus 5 Thinking recommends ElevenLabs Agents plus a FastMCP server. What makes Claude Opus 5 Thinking's dissent worth taking seriously is that it rests on a specific product feature the others didn't find: ElevenLabs' **Fine-Grained Tool Approval**, which lets you mark each tool auto-approved, requires-approval, or *disabled* — with the platform explicitly recommending you auto-approve low-risk read-only tools while gating anything that modifies data. That is exactly the tiering all three models designed, available as dashboard config. And crucially, `exec_shell` set to "disabled" at the platform level is a stronger guarantee than any prompt instruction. Claude Opus 5 Thinking's estimate of 2–3 hours to a talking read-only agent versus a weekend for LiveKit is a real difference in whether this project survives contact with your schedule.[^17]

The counter-argument is equally real and it comes from Claude Opus 5 Thinking's own research, which is what makes it credible. In tracing the Realtime MCP flow, Claude Opus 5 Thinking established that **remote MCP tools are executed by the Realtime API itself** — your client doesn't run the tool and return output, it configures access, listens for `mcp_list_tools.in_progress/completed/failed` and `response.mcp_call.*` events, and answers `mcp_approval_request` items with `mcp_approval_response`. The consequence is stated explicitly: this is not stdio-over-localhost, OpenAI's (or ElevenLabs') infrastructure must reach your VM over the internet, and that **rules out a Tailscale-only deployment**. OpenAI further notes that while remote MCP servers don't receive full conversation context, they *can* see any data the model sends in a tool call, and advises narrowing the surface with `allowed_tools`. GPT-5.6 Sol Thinking's LiveKit recommendation avoids this entirely through placement: the agent worker runs *on* the VM, so it needs no SSH and no public command endpoint. For a box holding your production database, that architectural difference deserves weight proportional to how sensitive that data is.[^9]

**Whether MCP belongs in v1** is the sharpest philosophical split. Claude Opus 5 Thinking treats MCP-over-HTTP as the thin waist that makes everything above and below swappable, and grounds it in the 2025-03-26 spec: Streamable HTTP through a single `/mcp` endpoint with optional SSE upgrade and stateless operation behind ordinary load balancers, plus an OAuth 2.1 framework classifying MCP servers as resource servers with PKCE, dynamic client registration, and RFC 8707 Resource Indicators preventing token replay across servers. The payoff claim — write the tools once, A/B the entire voice stack in an afternoon — is real, and given you're simultaneously evaluating Telnyx/Twilio/AssemblyAI for ETA's support agent, a shared tool layer across both projects is genuinely valuable. GPT-5.6 Sol Thinking pushes back on security grounds: direct function tools are easier to secure, test, and observe, and MCP earns its complexity only when the same capabilities must be reachable by your other agents, orchestration worker, and remote-machine workers. Both are right about different time horizons; the tell is whether you expect your Mac/Windows agents to call these same tools, and given your NATS orchestration direction, you probably do.[^19][^20]

**Model routing** is where Kimi K3 makes an argument neither other model raised and which lands hardest against the hosted recommendation. Kimi K3 proposes routing per task: deep codebase and infrastructure investigations to Claude/GPT/Gemini, quick operational questions to a cheap fast model, sensitive work to a local or private model, and database/schema work to whatever has the strongest structured-output tool use. That's a direct match for your multi-LLM cost-optimization interest, and it is structurally impossible on ElevenLabs or OpenAI Realtime, where the vendor owns the model. Claude Opus 5 Thinking's comparison table concedes this honestly — "Model choice: vendor" for all three hosted options, "any" only for LiveKit/Pipecat.[^28]

## Unique Insights Worth Noting

Two of Claude Opus 5 Thinking's findings are immediately actionable regardless of which stack you choose. **Cloudflare MCP Server Portals** went to open beta for Cloudflare One customers in July 2026, letting Access authenticate users against your IdP and enforce which MCP servers each can reach, independent of the underlying server's own authorization. Combined with the finding that an MCP server deployed as a Cloudflare Access self-hosted application needs **no OAuth implementation in your code at all** — Access handles it and passes the user's JWT in a header — this eliminates the auth work that would otherwise dominate your first weekend. You already run Cloudflare, so this is nearly free. The second is **per-turn MCP scoping**: attaching an MCP server to `response.tools` rather than `session.tools` means a write-capable tool server can exist for exactly one explicitly-invoked turn and then vanish. That's a cleaner mutation gate than most hand-rolled approval flows.[^18][^6][^7][^9]

Claude Opus 5 Thinking's non-Anthropic harness options also deserve a look given your framing. **Goose** is a general-purpose, MCP-native, on-machine agent that is explicitly not code-only, and it works as an ACP server while being able to use ACP agents like Claude Code and Codex as *providers* — genuine model-agnosticism at the harness layer. **`opencode serve`** runs a headless HTTP server with an OpenAPI endpoint, `GET /agent` enumeration, and `OPENCODE_SERVER_PASSWORD` basic auth across 75+ LLMs, and people are already chaining agents against it on a VM. The composition all three models implicitly endorse: fast tools answer simple questions inline, and one slow `investigate(question)` tool delegates to Goose or OpenCode as a background job with checkpointed spoken updates.[^15][^29][^16][^30][^31][^32]

Kimi K3's local-model findings are worth filing rather than acting on. **Qwen3-Omni** is the first Level-2 open speech-to-speech model with native function calling via `<tool_call>` tags, a 30B MoE with 3B active per token and a multi-codebook streaming Talker, and **Voxtral TTS** runs on a single 16GB-VRAM GPU through vLLM-Omni's OpenAI-compatible endpoint. The fully-sovereign path genuinely exists in August 2026 — but Voxtral is CC BY-NC, and all three models independently warned against putting inference on your 4-vCPU/16GB DigitalOcean box that has already hit 99% memory.[^26][^24][^23][^25][^33]

## Recommendations

Do the fast thing first, but build the boundary correctly. **This afternoon**, write a FastMCP server on the DO box with six read-only tools — `search_code`, `read_file`, `tail_logs`, `service_status`, `disk_and_memory`, `list_tables` — with bearer-token middleware, behind a Cloudflare Tunnel and Access self-hosted application so you write zero OAuth code. Register it with ElevenLabs, set all six to auto-approved under Fine-Grained Tool Approval, and talk to it. Twenty minutes of conversation will tell you whether this is useful, and Claude Opus 5 Thinking is right that this is the honest first question. Add `disk_and_memory` as a real tool rather than an afterthought — your box's memory history makes it one of the questions you'll actually ask.[^6][^7][^12][^13][^17]

**Week one**, add `query_readonly` against a dedicated role with only `CONNECT`/`USAGE`/`SELECT` on curated `ops.*` views, every request in a `READ ONLY` transaction with a `statement_timeout`, single-statement enforcement, row and byte caps, PII redaction, and full query auditing — and follow Claude Opus 5 Thinking's advice of making 5–10 *named* queries the primary path with free-form SQL as fallback, since a hallucinated `JOIN` you can't see on screen is worse than one you can. Add the Next.js companion page rendering the last tool result. Adopt GPT-5.6 Sol Thinking's `ToolResult<T>` shape from the first tool, not retrofitted.

**Then decide the long-term stack based on one question**: does audio need to stay in your infrastructure, and do you need per-task model routing? If yes to either, migrate the voice layer to LiveKit Agents with the worker on the VM — which also eliminates the internet-exposure requirement and gives you Kimi K3's routing. If no, stay hosted and spend the saved effort on tools. Either way, the FastMCP server you wrote in step one survives the migration intact, which is the entire point of the thin-waist design. Keep the zero-write policy for the first month, put write tools behind an authenticated click in the console rather than a spoken "yes," run everything as a dedicated unprivileged user with secrets injected via `op run` from 1Password so the process can never read `/etc/orchestration/env` as a file, and cap the MCP process's memory with a systemd restart policy — a voice agent that dies mid-sentence because a background job ate the box is worse than no voice agent at all.
<span style="display:none">[^100][^101][^102][^103][^104][^105][^106][^107][^108][^109][^110][^111][^112][^113][^114][^115][^116][^117][^118][^119][^120][^34][^35][^36][^37][^38][^39][^40][^41][^42][^43][^44][^45][^46][^47][^48][^49][^50][^51][^52][^53][^54][^55][^56][^57][^58][^59][^60][^61][^62][^63][^64][^65][^66][^67][^68][^69][^70][^71][^72][^73][^74][^75][^76][^77][^78][^79][^80][^81][^82][^83][^84][^85][^86][^87][^88][^89][^90][^91][^92][^93][^94][^95][^96][^97][^98][^99]</span>

<div align="center">⁂</div>

[^1]: https://developers.openai.com/api/docs/guides/voice-agents

[^2]: https://www.reddit.com/r/mcp/comments/1tvijqq/i_built_a_readonly_postgres_mcp_server_would_love/

[^3]: https://docs.livekit.io/agents/start/voice-ai/

[^4]: https://github.com/pipecat-ai/pipecat

[^5]: https://mcpservers.org/agent-skills/livekit/livekit-agents

[^6]: https://openai.github.io/openai-agents-js/guides/voice-agents/

[^7]: https://lobehub.com/mcp/simonjang-mcp-postgres-readonly

[^8]: https://github.com/den-vasyliev/voice-mcp-agent

[^9]: https://soniox.com/wiki/voice-agent-frameworks

[^10]: https://github.com/livekit-examples/basic-mcp

[^11]: https://www.reddit.com/r/AI_Agents/comments/1o4gq71/long_running_tool_calls_in_realtime_conversations/

[^12]: https://www.opensourcealternatives.to/blog/best-open-source-ai-coding-assistants

[^13]: https://code.claude.com/docs/en/agent-sdk/overview

[^14]: https://www.reddit.com/r/ClaudeCode/comments/1q2phbx/i_built_a_personal_life_database_with_claude_in/

[^15]: https://aws.amazon.com/blogs/machine-learning/building-intelligent-ai-voice-agents-with-pipecat-and-amazon-bedrock-part-1/

[^16]: https://support.claude.com/en/articles/11101966-use-voice-mode

[^17]: https://github.com/vocodedev/vocode-core

[^18]: https://dev.to/cloudx/building-voice-ai-agents-with-the-openai-agents-sdk-2aog

[^19]: https://www.facebook.com/groups/claudecommunity/posts/1080388441168487/

[^20]: https://railway.com/deploy/livekit-voice-agent-self-hosted-webrtc-ai-on-railway--livekit-voice-agent

[^21]: https://www.perplexity.ai/search/854251d6-0fd0-44ed-85eb-fb446fa8d7e1

[^22]: https://www.perplexity.ai/search/4fd1f239-43e5-4d94-b9a8-a43da84825ee

[^23]: https://docs.livekit.io/telephony/

[^24]: https://arxiv.org/html/2603.05413v2

[^25]: https://pinggy.io/blog/best_open_source_self_hosted_text_to_speech_models/

[^26]: https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/

[^27]: https://www.promptfoo.dev/docs/providers/claude-agent-sdk/

[^28]: https://github.com/openai/openai-realtime-agents

[^29]: https://openai.com/index/introducing-gpt-realtime/

[^30]: https://code.claude.com/docs/en/voice-dictation

[^31]: https://www.reddit.com/r/LocalLLaMA/comments/1nktpac/open_source_voice_ai_agents/

[^32]: https://aivancity.ai/en/blog/claude-code-voice-anthropic-permet-enfin-de-piloter-son-code-a-la-voix/

[^33]: https://docs.pipecat.ai/client/concepts/choosing-a-transport

[^34]: https://livekit.com/products/agents-sdks

[^35]: https://github.com/livekit/agents

[^36]: https://openai.github.io/openai-agents-python/

[^37]: https://developers.openai.com/api/docs/guides/realtime

[^38]: https://docs.vapi.ai/tools/custom-tools

[^39]: https://docs.vapi.ai/server-url/setting-server-urls

[^40]: https://www.retellai.com/

[^41]: https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant

[^42]: https://telnyx.com/release-notes/async-webhook-tools-ai-assistants

[^43]: https://docs.cloud.google.com/sql/docs/postgres/secure-agent-interactions-mcp

[^44]: https://www.nodejs-security.com/blog/how-to-mitigate-sql-bypass-in-mcp-servers

[^45]: https://developers.openai.com/api/docs/guides/realtime-mcp

[^46]: https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp

[^47]: https://zylos.ai/research/2026-03-08-mcp-remote-evolution-streamable-http-enterprise-adoption/

[^48]: https://modelcontextprotocol.io/specification/draft/basic/authorization

[^49]: https://ai.google.dev/gemini-api/docs/live-api

[^50]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-live

[^51]: https://nettpilot.com/google-gemini-business-guide-2026/

[^52]: https://github.com/allenbijo/gemini-live-mcp

[^53]: https://goose-docs.ai/

[^54]: https://block.xyz/inside/block-open-source-introduces-codename-goose

[^55]: https://blog.marcnuri.com/goose-on-machine-ai-agent-cli-introduction

[^56]: https://opencode.ai/docs/server/

[^57]: https://opencode.ai/docs/cli/

[^58]: https://developers.cloudflare.com/agent-setup/opencode/

[^59]: https://www.reddit.com/r/opencodeCLI/comments/1rj61qn/does_anyone_use_opencode_server/

[^60]: https://gofastmcp.com/deployment/http

[^61]: https://gofastmcp.com/servers/auth/authentication

[^62]: https://gofastmcp.com/clients/auth/bearer

[^63]: https://gelembjuk.com/blog/post/authentication-remote-mcp-server-python/

[^64]: https://github.com/tufantunc/ssh-mcp

[^65]: https://mcpservers.org/servers/giuliolibrando/ssh-mcp-server

[^66]: https://conare.ai/marketplace/mcp/ssh-mcp-f752

[^67]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/linked-apps/

[^68]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/

[^69]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/

[^70]: https://blog.cloudflare.com/zero-trust-mcp-server-portals/

[^71]: https://docs.livekit.io/agents/

[^72]: https://docs.livekit.io/agents/models/

[^73]: https://docs.livekit.io/agents/integrations/xai/

[^74]: https://developers.openai.com/api/docs/guides/realtime-sip

[^75]: https://docs.pipecat.ai/overview/introduction

[^76]: https://docs.pipecat.ai/overview/flows

[^77]: https://github.com/QwenLM/Qwen3-Omni

[^78]: https://punits.dev/blog/mcp-with-postgres/

[^79]: https://docs.livekit.io/transport/self-hosting/sip-server/

[^80]: https://www.reddit.com/r/Speechmatics/comments/1mo5juk/build_your_own_voice_ai_agent_with_pipecat/

[^81]: https://dev.to/anmolbaranwal/open-source-toolkit-for-building-ai-agents-in-2026-55h1

[^82]: https://docs.livekit.io/intro/coding-agents/

[^83]: https://www.facebook.com/groups/developerkaki/posts/2434014983611067/

[^84]: https://github.com/pipecat-ai/pipecat-mcp-server

[^85]: https://www.reddit.com/r/LangChain/comments/1m0l2mx/my_dream_project_is_finally_live_an_opensource_ai/

[^86]: https://www.gumloop.com/blog/open-source-ai-agents

[^87]: https://www.pipecat.ai/

[^88]: https://www.morphllm.com/ai-agent-framework

[^89]: https://www.youtube.com/watch?v=KrFSaY-v-tE

[^90]: https://news.ycombinator.com/item?id=42879323

[^91]: https://www.reddit.com/r/ollama/comments/1ji8vlm/codename_goose_agentic_ai/

[^92]: https://www.youtube.com/watch?v=uZGDO0L-Dr4

[^93]: https://developers.openai.com/api/docs/guides/agents

[^94]: https://www.scalekit.com/blog/vapi-voice-agent-development-with-authenticated-app-access

[^95]: https://n8n.io/workflows/3805-connect-retell-voice-agents-to-custom-functions/

[^96]: https://telnyx.com/release-notes/ai-assistant-post-call-insights-webhook

[^97]: https://www.sacesta.com/our-work/blog/complete-guide-retell-ai-function-calling-custom-tools

[^98]: https://callsphere.ai/blog/vw9h-build-voice-agent-vapi-functions-tools-2026

[^99]: https://openai.com/index/retell-ai/

[^100]: https://www.reddit.com/r/mcp/comments/1jk9t5k/is_there_mcp_tool_to_ssh_to_some_host_and_execute/

[^101]: https://elevenlabs.io/docs/eleven-agents/customization/tools

[^102]: https://www.youtube.com/watch?v=m1HgNvafID8

[^103]: https://adk.dev/integrations/elevenlabs/

[^104]: https://www.youtube.com/watch?v=1fLOzOocEBw\&vl=en

[^105]: https://elevenlabs.io/blog/introducing-elevenlabs-mcp

[^106]: https://www.reddit.com/r/OpenAI/comments/1l1k505/using_openais_realtime_api_with_an_mcp_server/

[^107]: https://github.com/elevenlabs/elevenlabs-mcp

[^108]: https://community.openai.com/t/realtime-api-mcp-server-sends-10-tools-but-api-receives-0/1367933

[^109]: https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/

[^110]: https://www.youtube.com/watch?v=gl6U8s3zStI\&vl=en

[^111]: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/

[^112]: https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1247

[^113]: https://www.descope.com/blog/post/mcp-auth-spec

[^114]: https://ai.google.dev/gemini-api/docs/function-calling

[^115]: https://aiskill.market/blog/realtime-voice-tools-mcp-skills

[^116]: https://github.com/googleapis/python-genai/issues/843

[^117]: https://noqta.tn/en/blog/openai-gpt-realtime-voice-agents-sip-mcp-2026

[^118]: https://www.reddit.com/r/Bard/comments/1roe1co/function_calling_on/

[^119]: https://www.reddit.com/r/mcp/comments/1plz2yb/best_solution_for_building_a_realtime/

[^120]: https://mcpservers.org/agent-skills/google-gemini/gemini-skills/gemini-live-api-dev

