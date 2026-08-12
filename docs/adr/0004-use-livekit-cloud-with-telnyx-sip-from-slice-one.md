# Use LiveKit Cloud with Telnyx SIP from slice one

The Voice Agent will use a dedicated Philadelphia-area Telnyx number for PSTN calls and SIP, LiveKit Cloud for realtime rooms and media transport, and a LiveKit Agents worker on the Agent Host for dialogue, policy, tools, and Subagent orchestration. This requires more initial assembly than Twilio ConversationRelay, but avoids migrating platforms when WebRTC is introduced and preserves granular control over the speech pipeline, models, interruption behavior, evidence, and provider selection.
