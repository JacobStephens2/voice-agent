# Reach a safe point before switching the agent onto itself

A Self-Promotion replaces the runtime performing it, so the work it must not
disturb is running inside it. Before the atomic switch, Call Admission closes
and the Promotion waits for a Promotion Safe Point: no active Telephone Session
and no unsettled non-interruptible Operation. Waiting is the only instrument. A
live call is never ended to deploy sooner, and a safe point that is not reached
within its bound abandons the attempt with the prior Release still active rather
than taking the call away.

An Operation's kind declares whether it may be carried across the switch. The
kinds that mutate Agent Host service or timer state are non-interruptible:
interrupted in flight they leave the host in a state no Evidence Record can
describe, because the Operation neither took effect nor did not. Every other
Operation is read-only or idempotent under its own durable identity, so the
switched runtime replays it rather than repeating its external effect.

Call Admission is durable state rather than a flag in the process that closes
it, because that process restarts mid-Promotion. It reopens only once a healthy
runtime has been confirmed — the switched Release after its verification passes,
or the restored Release after a rollback verifies. If neither can be confirmed,
the gate stays closed and callers keep meeting the bounded refusal rather than
reaching a runtime nobody has verified.

Admission is enforced at the single reservation every entry path already uses,
so an inbound Callback Handshake, a Completion Callback, and an authenticated
resumption all report temporary unavailability through the bounded behavior they
already have for a refused reservation. No new spoken message, and no new
failure mode, is introduced for the minutes a Promotion holds the gate.
