import type { GrokContractRunOutcome } from "@voice-agent/contracts";

/**
 * What the token broker's probe means, as an exit code.
 *
 * The credential lives with another identity, so the only thing that crosses
 * back is a status. A code rather than a sentence is deliberate: the executor
 * authors the ending in this system's own words, and the helper's standard
 * error - which may name a file path or a scope - never reaches a Delegation
 * record. `ops/grok/grok-token-helper` exits with exactly these values.
 */
export const grokCredentialProbeExitCodes = {
  /** The enrolled login had expired and renewing it did not produce a valid one. */
  expired: 12,
  /** The custody identity holds no credential at all. */
  noCredential: 10,
  /** What it holds is not the subscription device-OAuth login. */
  notSubscription: 11,
  /** A deployment key or API key route was reachable where only the subscription may be. */
  otherRoutePresent: 13,
  /** The crossing did not land on the custody identity. */
  wrongIdentity: 14,
} as const;

export interface GrokCredentialProbe {
  readonly exitCode: number | null;
  /** The probe's own time bound elapsed, so no code was returned. */
  readonly timedOut: boolean;
}

const refusals = new Map<number, GrokContractRunOutcome>([
  [
    grokCredentialProbeExitCodes.expired,
    paused(
      "provider-authentication",
      "The enrolled subscription login expired and renewing it did not return a valid one; the task waits for a fresh device authorization.",
    ),
  ],
  [
    grokCredentialProbeExitCodes.noCredential,
    paused(
      "provider-authentication",
      "No subscription login is enrolled for the custody identity; the task waits for a device authorization.",
    ),
  ],
  [
    grokCredentialProbeExitCodes.notSubscription,
    paused(
      "provider-authentication",
      "The enrolled credential is not the subscription login this contract runs on; the task waits rather than using another route.",
    ),
  ],
  [
    grokCredentialProbeExitCodes.otherRoutePresent,
    paused(
      "provider-contract-drift",
      "A deployment key or API key route is reachable where only the subscription login may be; the task waits for that route to be removed.",
    ),
  ],
  [
    grokCredentialProbeExitCodes.wrongIdentity,
    paused(
      "provider-contract-drift",
      "The token broker did not reach the custody identity; the task waits for the crossing to be reviewed.",
    ),
  ],
]);

/**
 * Say why the enrolled credential cannot serve this run, before it starts.
 *
 * The subscription login lasts about six hours, and the runner renews it only
 * once it has actually expired. Asking the custody identity for a token before
 * the model is spawned is therefore what turns "expires during this run" into
 * "renewed before this run": the same probe that answers the question performs
 * the renewal. What it cannot renew ends the Delegation in a pause naming
 * expiry, rather than in a provider error partway through the work.
 *
 * Every ending here is a pause. None of them is a defect in this system, and
 * each one is cleared by an attended action rather than by another provider.
 */
export function describeCredentialRefusal(
  probe: GrokCredentialProbe,
): GrokContractRunOutcome | null {
  if (probe.timedOut) {
    return paused(
      "provider-authentication",
      "The custody identity did not answer for a subscription token in time; the task waits rather than starting a run without one.",
    );
  }
  if (probe.exitCode === 0) return null;
  return (
    refusals.get(probe.exitCode ?? -1) ??
    paused(
      "provider-authentication",
      "The custody identity refused to mint a subscription token; the task waits for the enrolled login to be restored.",
    )
  );
}

function paused(
  reason: "provider-authentication" | "provider-contract-drift",
  detail: string,
): GrokContractRunOutcome {
  return { detail, evidence: null, reason, state: "paused" };
}
