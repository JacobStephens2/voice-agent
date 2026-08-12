# Use a modular speech pipeline

The Voice Agent will use independently replaceable speech-to-text, language-model, and text-to-speech stages within LiveKit Agents rather than a direct speech-to-speech realtime model. This accepts moderately higher latency in exchange for mature tool calling, immediate transcripts, exact control over spoken output, full Evidence Record auditability, and the ability to change any model provider without replacing LiveKit or the rest of the Voice Agent.
