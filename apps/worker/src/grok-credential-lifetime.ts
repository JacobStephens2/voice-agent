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

/**
 * What the Auth Crossing said about the credential behind it.
 *
 * A lifetime and a bound, never a token. `remainingSeconds` is what the far
 * side reported; `requiredSeconds` is how long this run may take. The
 * credential has to cover all of it, because grok 1.0.13 does not renew one
 * part way through a run - observed.
 */
export interface GrokCredentialLifetime {
  /** Null when the answer carried no lifetime this contract could read. */
  readonly remainingSeconds: number | null;
  readonly requiredSeconds: number;
}

export interface GrokCredentialProbe extends GrokCredentialLifetime {
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
 * Every ending here is a pause. None of them is a defect in this system, and
 * each one is cleared by an attended action rather than by another provider -
 * a login that will not renew waits for a device authorization, and never for
 * a second billing route. ADR-0069 has the renewal this reads the result of.
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
  if (probe.exitCode !== 0) {
    return (
      refusals.get(probe.exitCode ?? -1) ??
      paused(
        "provider-authentication",
        "The custody identity refused to mint a subscription token; the task waits for the enrolled login to be restored.",
      )
    );
  }
  return describeInsufficientLifetime(probe);
}

/**
 * Refuse a run the credential cannot outlast.
 *
 * The runner spends the token it was handed until it fails: a headless run
 * whose credential expires part way through returns a 401 rather than asking
 * the Auth Crossing for another one, after spending model tokens on the
 * request that failed. Observed on grok 1.0.13. So the lifetime is checked
 * against the run's own bound before anything is spent - at the probe, and
 * again against what the crossing actually minted - and one ending covers
 * both, because it is one rule.
 *
 * The pause clears without an attended action: the login is renewed on expiry,
 * so the next probe after `expires_at` returns a full six hours.
 */
export function describeInsufficientLifetime(
  lifetime: GrokCredentialLifetime,
): GrokContractRunOutcome | null {
  if (lifetime.remainingSeconds === null) {
    return paused(
      "provider-contract-drift",
      "The Auth Crossing did not report a credential lifetime; the task waits for the crossing to be reviewed.",
    );
  }
  if (lifetime.remainingSeconds < lifetime.requiredSeconds) {
    return paused(
      "provider-authentication",
      "The subscription login expires before this run's time bound, and the runner does not renew one part way through; the task waits for the login to be renewed on expiry.",
    );
  }
  return null;
}

export interface GrokCredentialSeeding extends GrokCredentialLifetime {
  /** The minted entry's `auth_mode`, or null if there is no entry at all. */
  readonly authenticationMode: string | null;
  readonly exitCode: number | null;
  /** The login's own time bound elapsed. */
  readonly timedOut: boolean;
}

/**
 * Say why this run's own Grok home did not end up holding a credential.
 *
 * Headless mode never invokes the auth provider - not to sign in and not to
 * re-mint - so the crossing is made once, by a `grok login` into the run's own
 * home, before the model is spawned. Observed on grok 1.0.13. Every ending
 * here is a pause, for the same reason the probe's are: none of them is a
 * defect in this system and none is a reason to select another provider.
 *
 * A login whose provider command fails does not exit non-zero. It falls back
 * to an interactive device authorization and waits five minutes for a browser
 * nobody is driving, so the bound is what turns that into an ending, and a
 * login that ran out of time is read as a crossing that did not answer.
 */
/**
 * What `grok login` records for a credential an external provider returned.
 * Anything else in that field is a credential this crossing did not mint.
 */
const mintedAuthenticationMode = "external";

export function describeCredentialSeedingRefusal(
  seeding: GrokCredentialSeeding,
): GrokContractRunOutcome | null {
  if (seeding.timedOut) {
    return paused(
      "provider-authentication",
      "Signing this run's Grok home in through the token broker did not finish in time; the task waits rather than starting a run without a credential.",
    );
  }
  if (seeding.exitCode !== 0 || seeding.authenticationMode === null) {
    return paused(
      "provider-authentication",
      "This run's Grok home was not signed in through the Auth Crossing; the task waits for the crossing to answer.",
    );
  }
  if (seeding.authenticationMode !== mintedAuthenticationMode) {
    return paused(
      "provider-contract-drift",
      "This run's Grok home holds a credential the Auth Crossing did not mint; the task waits for the crossing to be reviewed.",
    );
  }
  return describeInsufficientLifetime(seeding);
}

function paused(
  reason: "provider-authentication" | "provider-contract-drift",
  detail: string,
): GrokContractRunOutcome {
  return { detail, evidence: null, reason, state: "paused" };
}
