# OpenCode and Gemini 3.7 Flash for Task Media

_Researched 2026-08-23 from Google's official Gemini documentation, OpenCode's
official documentation, and pinned `anomalyco/opencode` and
`anomalyco/models.dev` source._

## Recommendation

Add Gemini 3.7 Flash through OpenCode only as an **asynchronous Task Media
provider** for audio and video that a confirmed Durable Task explicitly names.
Keep Codex, Claude, and Grok ahead of it for ordinary coding work. Do not use
Gemini 3.7 Flash as the Telephone Session's realtime voice model: Google lists
audio and video as supported inputs but says the Live API is not supported
([Gemini 3.7 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)).

Pin OpenCode 1.18.21 and evaluate one candidate server attachment path: start a
private `opencode serve` process, then submit media with `opencode run --attach
<server> -f <media> --model google/gemini-3.7-flash`. Register it only after an
end-to-end acceptance test proves delivery of both audio and video. OpenCode's
local `run -f` path does not preserve audio/video MIME types, and its public V2
attachment contract currently excludes audio and video from model requests.
These limitations make a real audio-and-video acceptance test part of the
integration contract, not an optional smoke test.

Use a dedicated Google Gemini API credential and meter its usage separately.
The documented native Google route is API-key authentication, not reuse of a
Google AI Pro, Ultra, or Antigravity subscription login. OpenCode Zen is a
second, separately billed API-key route, not a way to reuse a Google
subscription.

## Exact model

Google released Gemini 3.7 Flash to general availability on 2026-08-13 under
the stable model code `gemini-3.7-flash`
([Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog#august-13-2026),
[model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)).
It accepts text, image, video, audio, and PDF and produces text, with a
1,048,576-token input limit and a 65,536-token output limit. It supports
function calling, structured output, and thinking, but not the Live API
([Gemini 3.7 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)).

The Models.dev record consumed by OpenCode describes the same media modalities
and limits and marks attachments as supported
([Models.dev Gemini 3.7 Flash record](https://github.com/anomalyco/models.dev/blob/8922bd89df0e6828cc934c7aef3bdc4632125133/models/google/gemini-3.7-flash.toml)).
For the native Google provider, the OpenCode model selector is therefore
`google/gemini-3.7-flash`
([Google provider model mapping](https://github.com/anomalyco/models.dev/blob/8922bd89df0e6828cc934c7aef3bdc4632125133/providers/google/models/gemini-3.7-flash.toml));
OpenCode documents model names in
`provider/model` form and refreshes its model cache from Models.dev with
`opencode models --refresh`
([OpenCode CLI](https://opencode.ai/docs/cli/#models)).

## The OpenCode 1.18.21 media path

This finding is version-specific. The inspected OpenCode commit identifies
itself as version 1.18.21
([package manifest](https://github.com/anomalyco/opencode/blob/03bba464d46f3eddf74195919b1344aa937f7b11/packages/opencode/package.json)).
Its provider transformation recognizes `audio/*` and `video/*` MIME types. A
file part remains intact when the selected model advertises the matching input
modality; otherwise OpenCode replaces it with a text error
([provider transform](https://github.com/anomalyco/opencode/blob/03bba464d46f3eddf74195919b1344aa937f7b11/packages/opencode/src/provider/transform.ts#L8-L15),
[modality check](https://github.com/anomalyco/opencode/blob/03bba464d46f3eddf74195919b1344aa937f7b11/packages/opencode/src/provider/transform.ts#L429-L441)).

The CLI has two materially different `run -f` paths:

| Invocation | OpenCode 1.18.21 behavior | Consequence |
| --- | --- | --- |
| `opencode run -f clip.mp4 ...` | The local path represents a non-directory attachment as `text/plain` and sends a `file:` URL rather than embedding its bytes with the detected media type. The Read tool exposes image and PDF binary attachments but rejects other binary files. | Do not use this path for audio or video Task Media; the provider is not reliably given the media. |
| `opencode run --attach http://127.0.0.1:4096 -f clip.mp4 ...` | The client reads the local file, detects non-UTF-8 media, preserves its detected MIME type, and embeds its bytes as a data URL in the prompt sent to the running server. | This is the specific path to prototype and acceptance-test. Each attached local file must be a regular file no larger than 10 MiB. |

Those behaviors are visible in the pinned `run` implementation
([attachment construction](https://github.com/anomalyco/opencode/blob/03bba464d46f3eddf74195919b1344aa937f7b11/packages/opencode/src/cli/cmd/run.ts#L356-L412),
[Read tool binary handling](https://github.com/anomalyco/opencode/blob/03bba464d46f3eddf74195919b1344aa937f7b11/packages/opencode/src/tool/read.ts#L303-L328)).
OpenCode documents `serve`, `run --attach`, `-f`, and `--model` as supported CLI
options, although its documentation does not promise audio/video semantics for
that combination
([OpenCode `run` CLI](https://opencode.ai/docs/cli/#run)).

There is an important contract mismatch: OpenCode's official V2 attachment
documentation says current V2 sessions expose UTF-8 text, directories, and
four image formats, while PDF, audio, video, and other binary prompt
attachments are not included in the model request
([OpenCode V2 attachments](https://opencode.ai/v2/docs/attachments)).
The 1.18.21 attached-run source is therefore a narrow implementation path, not
evidence that the V2 attachment API generally supports Task Media. Pinning the
version and proving that the selected provider actually receives both a known
audio fixture and a known video fixture are required. An upgrade must rerun
those tests before activation.

## Authentication and billing

OpenCode uses Models.dev for provider discovery and stores credentials added by
`opencode auth login` in its own credentials file
([OpenCode providers](https://opencode.ai/docs/providers/),
[OpenCode authentication CLI](https://opencode.ai/docs/cli/#auth)). The native
Google provider record selects `@ai-sdk/google` and recognizes
`GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY`
([Models.dev Google provider](https://github.com/anomalyco/models.dev/blob/8922bd89df0e6828cc934c7aef3bdc4632125133/providers/google/provider.toml)).
Google likewise requires a Gemini API key, and upgrading the Gemini API to its
paid tier requires Cloud Billing
([Gemini API getting started](https://ai.google.dev/gemini-api/docs/get-started#1-get-an-api-key)).

Do not inject that API key into the environment of a broadly authorized
OpenCode Code Subagent. OpenCode 1.18.21 constructs the environment for its
model-invoked shell tool by copying the runner's complete `process.env`
([OpenCode shell environment](https://github.com/anomalyco/opencode/blob/03bba464d46f3eddf74195919b1344aa937f7b11/packages/opencode/src/tool/shell.ts#L416-L425)).
An environment-provided Google key would therefore reach model-generated
commands. The default OpenCode credentials file also belongs to the runner's
Unix identity, so an OS boundary would have to make that file unavailable to
tool children. This repository's Credential Custody Boundary instead calls for
Brokered Secret Use: place the Google credential behind a task-scoped local
provider broker, or otherwise separate provider-request execution from the
process that executes model-selected commands.

Neither the official OpenCode Google provider record nor Google's Gemini API
setup documents using a Google AI Pro, Ultra, or Antigravity consumer
subscription for this route. That differs from OpenCode's explicit ChatGPT
Plus/Pro and SuperGrok OAuth options
([OpenCode provider authentication](https://opencode.ai/docs/providers/)). The
repository must therefore treat Google-through-OpenCode as API authentication
with its own credential and spend, even if the owner separately has a Google
subscription.

Google offers free and paid Gemini Developer API tiers. Its pricing page says
free-tier content is used to improve Google's products while paid-tier content
is not, and lists Gemini 3.7 Flash as separately metered API usage
([Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.7-flash)).
OpenCode Zen is an alternative gateway: it lists Gemini 3.7 Flash, uses an
OpenCode API key, requires billing details, and charges per request
([OpenCode Zen](https://opencode.ai/docs/zen/)). Its selector is
`opencode/gemini-3.7-flash`, not `google/gemini-3.7-flash`, and its billing is
separate from both Google API billing and consumer subscriptions.

## Repository implications

1. Add OpenCode as a provider runner and Gemini 3.7 Flash as an asynchronous
   Task Media model, while preserving the distinction between **Task Media**
   and raw **Telephone Session** audio. The model's lack of Live API support
   makes it unsuitable for the realtime speech pipeline.
2. Give the OpenCode/Google runner its own Unix identity, but do not place the
   Google key in its inherited environment or model-readable credential store.
   Route provider requests through Brokered Secret Use and test that shell
   commands cannot recover the raw key. ADR-0024's assumption that every
   provider uses an interactive subscription login must be revised to allow
   provider API credentials without weakening provider isolation
   ([ADR-0024](../adr/0024-isolate-provider-logins-and-code-disclosure.md)).
3. Account for Gemini API or OpenCode Zen usage under the metered provider
   ceiling. Record the runner, provider, model code, authentication route, and
   billing route in the Evidence Record without recording the API key.
4. Pin OpenCode 1.18.21 (or an intentionally reviewed successor), bind its
   server to a private interface, and use the exact `run --attach` flow. Add
   real fixtures that require facts available only in the audio and video,
   reject an apparently successful text-only response, exercise the 10 MiB
   boundary, and fail closed if either modality disappears.
5. Do not build new work on generic V2 attachment submission until OpenCode's
   documented V2 contract includes audio and video. Re-evaluate the adapter
   when that contract changes rather than inferring support from a file picker
   or accepted upload.
