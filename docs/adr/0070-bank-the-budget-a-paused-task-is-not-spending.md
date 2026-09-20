# Bank the budget a paused Task is not spending

ADR-0048 bounds a confirmed Durable Task to six hours of *active execution*
while leaving paused time unlimited. The implementation that landed with
issue #83 bounded something else: `answerTaskConfirmation` stamped
`acceptedAt + 6h` onto the Task and every fence — claim admission, lease
renewal, planning, the executor's own pre-effect check — compared the wall
clock against it. A Task that spent five of those hours waiting on an exhausted
Grok quota therefore had one hour of work left, which is the opposite of what
the policy says.

The deadline is kept, because it is already the value every fence reads, and it
is made to mean *remaining budget* rather than *elapsed time*. Consumption is
what the deadline no longer covers: at any instant `t`, a running Task has
spent `6h - (deadline - t)`. Pausing writes that number to
`active_execution_consumed_ms` and clears the deadline; resuming writes
`deadline = t + (6h - consumed)`. No second clock is stored, no fence changes,
and a Task that never pauses behaves exactly as it did before — which is why
twenty-six existing scenarios covering the six-hour bound still pass unedited.

Two clamps make the arithmetic safe against a clock this system does not own.
Consumption never falls below what was already banked, so a clock that moves
backwards cannot refund budget; and it never exceeds six hours, so a deadline
that elapsed long ago cannot bank a negative remainder that resume would read
as time to spend. A Task whose budget reaches zero cannot resume at all: the
store refuses it rather than minting a deadline in the past for a fence to
discover later.

**A paused Task is `running`, and that is a state the recovery path had to be
taught.** Its deadline is `NULL`, which every pre-existing reading of `NULL`
treats as "this Task is out of time" — `claimNextOperation` denied it,
`taskRequiresResultSettlement` selected it for settlement, and
`claimOperationSettlement` threw outright. Each of those is now guarded by the
pause itself: the claim transactions return a new `halted` decision, distinct
from `empty` because an empty plan completes a Task and a paused one must not,
and the reconciliation pass filters paused Tasks before it selects work.
Recovery after a restart therefore neither resumes a paused Task on its own nor
fails it closed for a deadline it is not spending.

## The reasons a Task may pause are ours, not the provider's

Pausing is raised where the pause is discovered — an Operation executor throws
`AdministrativeExecutionPaused` — and that is a value crossing from a boundary
this system does not trust. The reason is therefore parsed against a closed
enum of three: `provider-paused`, `quota-blocked`, `owner-waiting`. An executor
that raises anything else does not pause the Task; the runtime falls through to
the failure handling it already had, and the invented reason reaches no durable
record. This matters more than it looks: a pause is an *indefinite* hold on the
six-hour bound, so a provider able to name its own pause reason would be a
provider able to describe its way out of the only time bound it has.

The three reasons are recorded, but nothing branches on which one it was. They
exist so the Evidence Record says why the budget stopped, and the resumption
that follows is the owner's either way. Nothing here retries a pause on a
timer: ADR-0048 makes provider failure and quota exhaustion durable pause
states rather than grounds for failover, and a pause that cleared itself would
be a failover to the same exhausted route.

A pause is raised at both points a provider can refuse — choosing the plan and
running an Operation — because a Task blocked at planning is spending the same
budget as one blocked mid-Operation. It stays `planning` while paused, and the
plan it never received is chosen when it resumes.

**A Task holding an armed Live Patch rollback may not pause.** These two holds
are incompatible by construction: the rollback window is thirty minutes and a
pause has no bound, so pausing over an armed rollback would let the window
mature on the wall clock while the Task that owns the mutation sits
indefinitely — and a later Stop would find nothing left to compensate. The
store refuses that pause, and the executor's failure settles the way it would
have without a pause signal, which leaves the independent rollback controller
holding the mutation exactly as it does for a Live Patch whose process died.

## Stop is terminal, and its compensation outlives the policy

Administrative Suspension already had a compensation path: it marks every armed
Live Patch rollback `activation-pending` and drives each to an activated proof.
Stop needs the same machinery for one Task, and the difference is what makes a
pending activation *still owed*. Suspension owes it only while suspension
stands, which is why the completion transaction checked the policy state. Stop
owes it for that one Task whatever the policy does next — the owner stopped a
live mutation, and reactivating the policy is not an answer to it.

So a pending activation now records what asked for it and when:
`compensation_trigger` decides whether the policy state still has to agree, and
`compensation_requested_at` replaces `policy.suspendedAt` as the floor every
activation proof must postdate. The rollback controller is otherwise unchanged,
which is the point — it is the independent, root-owned path that ADR-0048
requires to survive provider, worker, service, and host loss, and Stop reaches
production through it rather than through anything the stopped Task holds.

Stop outranks a late denial. It aborts the Task's in-flight executions, and the
executor those aborts reach will report a failure a moment later; settling that
failure would overwrite `stopped` with a denial reason the owner did not give.
The runtime therefore recognises its own stop reason and declines to settle
twice, and the store treats a stopped Task as already terminal rather than
raising on a denial it cannot apply. Nothing is deleted on the way: outstanding
Operations move to `stopped` with their evidence, and Delegated Worktrees,
commits, and branches are not touched at all, which is asserted in the Stop
Evidence Event rather than left implied.

## A Task drives itself before it joins the shared pass

ADR-0048 also requires read-only Research to run while a mutation holds the
global mutation lane. The durable lane always permitted it — only
`delegated-worktree.change` and `live-patch.apply` claim it — but the driver did
not: `answerTaskConfirmation` awaited one shared reconciliation pass, and a
pass that was executing a long mutation held every Task admitted behind it.
The lane was serialized correctly and the process was serialized as well.

A confirmed Task now drives itself first, in a loop keyed by its own identity,
and joins the shared pass only if it could not reach a rest point alone. An
observation admitted while a mutation is held completes on its own loop and
never asks for the pass. A second *mutation* cannot settle alone — the lane
defers it — so it does ask, and the shared pass waits for whatever the per-Task
loops are already driving before it selects work, which is how the deferred
mutation is picked up the moment the lane frees rather than at its next
scheduled retry.

## Consequences

Six hours now means six hours of work. A Task can wait out a quota window of
any length and resume with what it had left, and the Evidence Record carries
the arithmetic — consumed, remaining, and the reason — rather than leaving the
owner to infer it from timestamps. The cost is two columns on the Task and a
rule that the deadline and the pause are never both set, which the Task schema
refuses outright rather than trusting every writer to observe.

Stop and Administrative Suspension are now distinct in the store as well as in
the glossary: Suspension closes admission for everything and Stop ends one Task,
and both preserve worktrees and evidence and both reach an armed rollback
through the same independent controller. Reactivation after Suspension still
requires a Fresh Passkey Action; Stop and resume do not, because neither widens
authority — they spend or decline to spend a budget the Fresh Passkey Action
already granted.
