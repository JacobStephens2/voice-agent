# Reach a safe point before switching the agent onto itself

A Self-Promotion replaces the runtime performing it, so the work it must not
disturb is running inside it. Before the atomic switch, Call Admission closes
and the Promotion waits for a Promotion Safe Point: no Telephone Session live or
reserved, and no unsettled non-interruptible Operation. Reserved sessions count
because an admission granted before the gate closed can still become a call, and
switching between a clear reading and that activation would interrupt a call
that had just begun. Waiting is the only instrument. A live call is never ended
to deploy sooner, and a safe point not reached within the bound the Deployment
Contract enrols abandons the attempt with the prior Release still active rather
than taking the call away.

That bound belongs to the authenticated contract rather than to the promoter's
code, so changing how long a Promotion may wait for a live call is a Fresh
Passkey Action like every other deployment-policy change.

An Operation's kind declares whether it may be carried across the switch. The
kinds that mutate Agent Host service or timer state are non-interruptible:
interrupted in flight they leave the host in a state no Evidence Record can
describe, because the Operation neither took effect nor did not. Every other
Operation is read-only or idempotent under its own durable identity, so the
switched runtime replays it rather than repeating its external effect.

Call Admission is durable state rather than a flag in the process that closes
it, because that process restarts mid-Promotion. It reopens only once a healthy
runtime has been confirmed, and that decision is made in exactly one place: the
promoter's cleanup path, which every exit between closing the gate and the end
of the attempt passes through. Reopening at each success path instead would
leave the gate closed after a failure in between — a unit install, a
`daemon-reload`, a migration-backup check — with the prior healthy Release
serving and every caller refused. If nothing healthy can be confirmed the gate
stays closed, and callers keep meeting the bounded refusal rather than reaching
a runtime nobody has verified.

The Evidence Record names which runtime the reopened gate was confirmed against:
the switched Release, a restored one after a rollback, or an unchanged one after
an attempt that never switched. There is no value for reopening without a
reading, because that never happens.

Admission is enforced at the single reservation every entry path already uses,
so an inbound Callback Handshake, a Completion Callback, and an authenticated
resumption all report temporary unavailability through the bounded behavior they
already have for a refused reservation. No new spoken message, and no new
failure mode, is introduced for the minutes a Promotion holds the gate.
