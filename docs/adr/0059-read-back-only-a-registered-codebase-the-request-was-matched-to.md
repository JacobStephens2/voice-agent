# Read back only a Registered Codebase the request was matched to

Every state-changing request that the Keeplore Button Trial matcher did not recognize was read back as `Bountywell production — <the owner's own transcript>`. Bountywell was never inferred from what was said; it was the hardcoded fallback branch of the readback, so a request about any other system, or a request whose recognition dropped a word, was attributed to a Registered Codebase the owner had not named. During the #13 trial a truncated turn produced exactly that: the owner asked for the Keeplore change and heard "Bountywell production — ...change in Keeplore".

A Task Confirmation is the one place this system states what it is about to change, and it is the sole gate before state-changing work. A readback that names the wrong codebase inverts that gate: instead of surfacing the misunderstanding for the owner to catch, the prompt asserts one, and an affirmative would be consent to a sentence that was never true. The effect was harmless only because the fallback's confirmed branch happens to start nothing and reply "Task confirmation recorded. Use the secure app to authorize execution." The safety rested on that accident rather than on the readback being honest.

A state-changing request is now matched before anything is claimed or read back. A request matched to the Keeplore Button Trial keeps its fixed Keeplore readback, and a request matched as a Bountywell outage report keeps its `Bountywell production — …` readback; both name a codebase the transcript reached. A request matched to neither is answered "I did not understand that request. Please say again what you want changed, and in which registered codebase." It names no codebase, prepares no Task Confirmation, and claims no state-changing slot.

## Consequences

The `other` state-changing kind is gone. There is no longer a way to hold a Task Confirmation for a request this system cannot name, so the generic "Task confirmation recorded" reply is reached only by a matched Bountywell outage report with no presented drill behind it. Anything the owner might once have confirmed generically now has to be matched first, which is a narrowing: the matchers are the vocabulary of what can be confirmed by telephone at all.

An unmatched request is refused before `stateChangingTasks.claim`, so it can no longer be queued or rejected at the concurrency boundary, and it never occupies a slot while the owner works out how to say it again. The boundary now counts only requests that reached a readback.

The failure mode this replaces is louder rather than quieter. Where recognition truncates a turn — the fault behind #123 — the owner previously heard a confident readback of the wrong system and now hears that the request was not understood. That is one more repetition on a call, and it is the outcome ADR-0049 already chose for a Task Confirmation answered by speech the classifier could not read.

The matcher itself is unchanged and remains coarse: the trial fires on `get rid of` and `remove` together, and nothing else. `docs/operations/keeplore-button-trial.md` now states that condition as it is, along with what an unmatched request sounds like, so an operator on an attended call can recognise a miss for what it is.
