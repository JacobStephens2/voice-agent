# Establish production rules only by creating them

The Repository Administration Broker (issue #88) exists so that an activated
Administrative Autonomy Policy can bootstrap a private repository and its
standard production-branch rules without a human review gate. That makes it the
one place in the system holding an owner credential that can *write* a
repository ruleset, and a ruleset writer is, by construction, also a ruleset
weakener: the same call that adds `pull_request` can remove it, and the same
call that empties `bypass_actors` can fill it.

The broker therefore establishes rules only by **creating** a ruleset that is
not there. It lists the repository's rulesets, and when none carries the
reviewed name `voice-agent-production-branch` it creates exactly one, from a
payload written in this file rather than accepted from any request. When a
ruleset by that name already exists, the broker does not touch it. It reads it
back and either observes the standard — requiring a pull request, rejecting
force-push and branch deletion, with no bypass actor — or refuses.

The alternative, updating an existing ruleset to match the standard, is what
turns this service into one that can weaken rules. The owner may have made the
production branch *stricter* than the standard: more required approvals, a
required check, a code-owner review. An "establish the standard" write would
quietly reduce all of that to the standard, and nothing in the request would
distinguish that from the bootstrap it was written for. A refusal costs the
owner one deliberate action on a repository they already chose to configure;
the write would cost them a protection they had, silently, at a moment when no
human is watching, which is the whole point of the autonomy this broker serves.

## The observation is separate from the write

The result never reports what the broker asked for. After creating a ruleset —
and equally after finding one already present — the broker reads the ruleset
back through the repository's own identity and validates *that* response. An
establishment whose read-back is missing a rule, targets another branch, or
carries a bypass actor is a refusal, not a success with a caveat. This is the
same reason ADR-0056 keeps the publisher's refusals on the host: the value of
these services is that their answer describes production, not their intent.

## Idempotence lives in the observation, not in a ledger

Every operation observes before it writes: the repository is fetched before it
is created, the ruleset list is read before one is added. A replay of the same
Operation, or a resumption after the broker died between GitHub's write and its
own answer, therefore converges on the same result and the same repository
state without a second effect. A broker-side idempotency ledger would have to
be committed *after* the external write it describes, so exactly the crash it
is meant to cover is the one that loses it. Observation has no such window.
