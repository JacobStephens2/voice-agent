# Verify Keeplore appearance in production before a Promotion completes

Keeplore's Promotion Attempt verified one thing after switching Releases: that the health endpoint answered 200. That is enough to know Apache is serving the new Release and its shared runtime state is linked in. It is not enough to know the Release does what the merge was for. The Keeplore Button Trial changes a stylesheet; a Release that serves the *old* stylesheet answers 200 exactly as happily as one that serves the new one. Every visual measurement the trial made — matched height, padding, typography, and visual weight, content-based widths, an unchanged card view — was taken against a candidate inside a Delegated Worktree by the restricted runner, before any human had merged anything.

So the strongest claim the trial could make about production was an inference: a candidate measured well in a worktree, an authenticated human merged the commit that carried it, and the Release built from that commit answered 200. Nothing observed the running site. Issue #14 asks for the opposite — that slice three is accepted only after a real production verification succeeds following the Human Merge — and an inference cannot satisfy it.

A Promotion Attempt now measures production itself. After the atomic switch and the health check, the promoter runs its own browser against the authenticated production table view at both verification viewports and applies the same acceptance bar the Delegation's candidate was held to. The observation is judged by `evaluateKeeploreProductionAppearance` in `@voice-agent/policy` — the same `describeKeeploreControlMismatch` the Delegation gate uses, so the two cannot drift apart. A failed verdict is a failed Promotion Attempt: the retained Release is restored, the failure is recorded on the attempt, and nothing treats the feature as complete.

Three boundaries make the observation worth something.

The browser is the promoter's, not the Subagent's. It reads a root-owned session at `/var/lib/voice-agent/browser/keeplore-production.json`, enrolled by the attended wizard, and never `/var/lib/voice-codex/browser/keeplore.json`. A Delegation cannot supply the browser that judges its own change in production.

No stylesheet is injected. The Delegation's verifier adds candidate CSS to a loaded page because the candidate is not deployed anywhere; the production verifier adds none. What the Release serves is what gets measured. The one thing that touches the page is the content-width probe, which appends text to a control, re-measures, and restores the original — the check for content-based widths cannot be made without it, and the page is left as it was found.

Both verifiers measure through one module, `apps/worker/src/keeplore-table-measurement.ts`. Sharing `describeKeeploreControlMismatch` keeps the two acceptance *bars* aligned; sharing the selectors, the view toggle, the card projection, and the probe keeps the two *measurements* aligned, which is the half that would otherwise drift silently.

Card view is compared against the Release production served *before* the switch. The promoter captures that baseline before it switches and compares after, so "no card-view regression" is measured against the retained Release rather than against the candidate itself.

## Consequences

A control whose width does not follow its content is now recorded as `widthMode: "fixed"` rather than raising. The measurement used to throw, which meant a fixed-width control reached the promoter as "no verdict arrived" instead of as the width failure it was. Both acceptance gates already checked `widthMode`; that check was unreachable while the only producer hardcoded `"content"`, and is now live on both sides.

Appearance verification is declared per Deployment Contract revision, through `KEEPLORE_APPEARANCE_VERIFICATION` in the root-owned Keeplore registration, and is off by default. It has to be: the two controls are *supposed* to differ until this trial's change is merged, so a host that verified appearance unconditionally would roll back the onboarding merge and every unrelated Keeplore change. Turning it on is an attended step in `ops/acceptance/run-keeplore-button-trial-promotion.sh`, and leaving it on means every later Keeplore Promotion must keep the controls matched — which is the standing claim the trial makes, so that is the intended reading rather than a side effect.

The promoter now needs a Release with a working browser and an enrolled production session. A Promotion for a contract revision that asks for appearance verification fails closed if either is missing, or if no Release is currently serving to take a baseline from. Failing closed is deliberate: an unreadable verdict is recorded as a failed one, because the alternative is a Promotion that completes by not looking.

The trial's terminal Evidence Record is projected by `projectKeeploreButtonTrialEvidenceRecord`, which joins the Delegation in SQLite, the host's append-only Promotion Attempt journal, and the promoter's own appearance observation under the Durable Task the confirmed telephone request created. The `keeplore.onboarding` projection is unchanged and still describes the harmless onboarding merge; the trial does not reuse it, because a trial that ended in a rollback and an onboarding that ended in a rollback are not the same conclusion.

The required checks the Promotion gates on are the contexts the production branch's own rules name, read from the root-owned repository-policy journal the publisher already maintains; the configured `KEEPLORE_REQUIRED_CHECK` is the fallback only while no branch-rules observation exists. A configured name that drifted from the enforced rule would let a Release be built on a check nobody requires.

Slice three's acceptance record refuses a production verification for a commit no Human Merge is recorded for, and refuses acceptance while any of health, appearance, card view, both screenshots, or the absence of a rollback is missing. A failed verification stays in the history rather than being retried away; a later passing verification of the same merge supersedes it without erasing it.
