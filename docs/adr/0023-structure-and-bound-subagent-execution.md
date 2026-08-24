# Structure and bound Subagent execution

Slice one will run at most one Subagent globally and queue additional Delegations to protect telephone latency on the Agent Host. A Subagent receives a Delegation Brief rather than a raw call transcript and returns a Delegation Result rather than exposing its raw event stream to the conversational model. Cancellation stops pending execution without reverting, deleting, resetting, or stashing completed work, and the Delegated Worktree and Evidence Record remain available. Concurrency may increase only after simultaneous voice, test, and Subagent workloads are measured.

ADR-0048 supersedes only the one-Subagent-global limit: administrative mutations remain serialized while read-only Research may run concurrently. The structured brief, result, cancellation, and preservation decisions remain active.
