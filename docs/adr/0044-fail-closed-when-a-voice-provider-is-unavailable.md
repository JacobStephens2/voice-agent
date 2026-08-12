# Fail closed when a voice provider is unavailable

If the selected speech-to-text, coordinator, or text-to-speech provider remains unavailable after bounded transient retries, the Telephone Session plays a generic prerecorded failure message, ends cleanly, and produces an Evidence Record and Silent Notification. It never leaves the caller in indefinite silence, loops paid retries, or silently discloses the conversation to another provider. Automatic cross-provider failover remains deferred under ADR 0034.
