/**
 * One run whose subscription login expired part way through it, recorded from
 * the Agent Host on 2026-08-31 against the installed grok 1.0.13.
 *
 * The run began with three seconds left on the credential, spent 305 output
 * tokens and 4.6 seconds of model time on one request, and got a 401 back. The
 * auth crossing was never invoked a second time: headless mode does not
 * re-mint from the `expires_in` the broker reported. These are the exact bytes
 * the runner produced, kept whole because the ending this contract gives them
 * is the whole reason the missing re-mint is survivable. See the addendum in
 * docs/research/grok-build-install-and-auth.md and ADR-0069.
 */
export const expiredMidRunStandardError =
  "Error: Internal error: {\n  \"message\": \"Unauthorized (401) from"
  + " https://cli-chat-proxy.grok.com/v1/responses: Invalid or "
  + "expired credentials (auth_kind=none, "
  + "x_xai_token_auth=xai-grok-cli, upstream=Unauthenticated, "
  + "reason=no auth context)\\n\\n  Model:     grok-4.6\\n  Auth:"
  + "      External\\n  Version:   1.0.13\\n  Available: grok-4.6, "
  + "grok-4.5\\n\\nYour session expired and your sign-in helper could"
  + " not renew it in the background. Run /login to sign in "
  + "again.\",\n  \"promptUsage\": {\n    \"inputTokens\": 14404,\n    "
  + "\"outputTokens\": 305,\n    \"totalTokens\": 14709,\n    "
  + "\"cachedReadTokens\": 0,\n    \"cacheCreationTokens\": 0,\n    "
  + "\"reasoningTokens\": 195,\n    \"modelCalls\": 1,\n    "
  + "\"apiDurationMs\": 4607,\n    \"costUsdTicks\": 52084600,\n    "
  + "\"modelUsage\": {\n      \"grok-4.6-build\": {\n        "
  + "\"inputTokens\": 14404,\n        \"outputTokens\": 305,\n        "
  + "\"totalTokens\": 14709,\n        \"cachedReadTokens\": 0,\n        "
  + "\"cacheCreationTokens\": 0,\n        \"reasoningTokens\": 195,\n"
  + "        \"modelCalls\": 1,\n        \"apiDurationMs\": 4607,\n"
  + "        \"costUsdTicks\": 52084600\n      }\n    },\n    "
  + "\"numTurns\": 1\n  }\n}\n";

export const expiredMidRunStandardOutput =
  "{\"type\":\"error\",\"message\":\"Internal error: {\\n  \\\"message\\\": "
  + "\\\"Unauthorized (401) from "
  + "https://cli-chat-proxy.grok.com/v1/responses: Invalid or "
  + "expired credentials (auth_kind=none, "
  + "x_xai_token_auth=xai-grok-cli, upstream=Unauthenticated, "
  + "reason=no auth context)\\\\n\\\\n  Model:     grok-4.6\\\\n  Auth:"
  + "      External\\\\n  Version:   1.0.13\\\\n  Available: grok-4.6, "
  + "grok-4.5\\\\n\\\\nYour session expired and your sign-in helper "
  + "could not renew it in the background. Run /login to sign in "
  + "again.\\\",\\n  \\\"promptUsage\\\": {\\n    \\\"inputTokens\\\": 14404,\\n"
  + "    \\\"outputTokens\\\": 305,\\n    \\\"totalTokens\\\": 14709,\\n    "
  + "\\\"cachedReadTokens\\\": 0,\\n    \\\"cacheCreationTokens\\\": 0,\\n"
  + "    \\\"reasoningTokens\\\": 195,\\n    \\\"modelCalls\\\": 1,\\n    "
  + "\\\"apiDurationMs\\\": 4607,\\n    \\\"costUsdTicks\\\": 52084600,\\n"
  + "    \\\"modelUsage\\\": {\\n      \\\"grok-4.6-build\\\": {\\n        "
  + "\\\"inputTokens\\\": 14404,\\n        \\\"outputTokens\\\": 305,\\n"
  + "        \\\"totalTokens\\\": 14709,\\n        \\\"cachedReadTokens\\\":"
  + " 0,\\n        \\\"cacheCreationTokens\\\": 0,\\n        "
  + "\\\"reasoningTokens\\\": 195,\\n        \\\"modelCalls\\\": 1,\\n"
  + "        \\\"apiDurationMs\\\": 4607,\\n        \\\"costUsdTicks\\\": "
  + "52084600\\n      }\\n    },\\n    \\\"numTurns\\\": 1\\n  }\\n}\",\"usage"
  + "\":{\"input_tokens\":14404,\"cache_read_input_tokens\":0,\"cache_cre"
  + "ation_input_tokens\":0,\"output_tokens\":305,\"reasoning_tokens\":1"
  + "95,\"total_tokens\":14709},\"num_turns\":1,\"total_cost_usd\":0.0052"
  + "0846,\"total_cost_usd_ticks\":52084600,\"modelUsage\":{\"grok-4.6-b"
  + "uild\":{\"inputTokens\":14404,\"outputTokens\":305,\"cacheReadInputT"
  + "okens\":0,\"cacheCreationInputTokens\":0,\"modelCalls\":1,\"costUSD\""
  + ":0.00520846}}}\n";
