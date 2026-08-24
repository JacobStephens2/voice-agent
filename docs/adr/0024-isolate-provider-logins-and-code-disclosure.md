# Isolate provider logins and code disclosure

Each coding provider will run under its own dedicated restricted Unix identity with a separately completed interactive subscription login and owner-only credential storage; existing credentials belonging to `jacob` will not be copied or exposed to the Voice Agent. Every Registered Codebase explicitly names the hosted Subagent providers allowed to inspect its source. An authorized Delegation permits task-scoped automated source inspection by those providers while excluding secrets, blocked data, unrelated repositories, and raw telephone transcripts.

ADR-0048 supersedes the exclusions for unrelated repositories and repository-contained secrets under Administrative Autonomy. Dedicated provider identities, credential custody, task-scoped disclosure, blocked host data, and exclusion of raw Telephone Session audio remain active.
