/** A configuration the telephone worker accepts, for tests that start it. */
export const wellFormedTelephoneWorkerEnvironment = {
  LIVEKIT_API_KEY: "test-key",
  LIVEKIT_API_SECRET: "test-secret",
  LIVEKIT_URL: "wss://livekit.example.test",
  RESEND_API_KEY: "test-resend",
  RESEND_DOMAIN_ID: "test-domain",
  VOICE_AGENT_BROKER_SOCKET_PATH: "/run/voice-agent-broker/broker.sock",
  VOICE_AGENT_DATABASE_PATH: "/var/lib/voice-agent/voice-agent.sqlite",
  VOICE_AGENT_NOTIFICATION_SUBDOMAIN: "notify.example.test",
  VOICE_AGENT_PROLONGED_SILENCE_SECONDS: "60",
  VOICE_AGENT_RAW_AUDIO_DEBUG_DIRECTORY: "/var/lib/voice-agent/raw-audio-debug",
  VOICE_AGENT_SUBAGENT_SOCKET_PATH: "/run/voice-agent-subagent/runner.sock",
  VOICE_AGENT_WORKER_PORT: "3474",
} as const satisfies NodeJS.ProcessEnv;
