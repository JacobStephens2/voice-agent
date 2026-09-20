import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
  describeCredentialRefusal,
  describeCredentialSeedingRefusal,
  describeUnreachableAuthCrossing,
  grokCredentialProbeExitCodes,
} from "../src/grok-credential-lifetime.ts";

/** What a run asks the credential to cover: the executor's own time bound. */
const requiredSeconds = 30 * 60;
const answered = { remainingSeconds: 21_600, requiredSeconds };

test("a credential the custody identity could mint from lets the run proceed", () => {
  expect(
    describeCredentialRefusal({ ...answered, exitCode: 0, timedOut: false }),
  ).toBeNull();
});

test("an expired login the runner could not renew pauses the task naming expiry", () => {
  const outcome = describeCredentialRefusal({
    ...answered,
    exitCode: grokCredentialProbeExitCodes.expired,
    timedOut: false,
  });

  expect(outcome).toEqual({
    detail:
      "The enrolled subscription login expired and renewing it did not return a valid one; the task waits for a fresh device authorization.",
    evidence: null,
    reason: "provider-authentication",
    state: "paused",
  });
});

test("an unenrolled custody identity pauses for the same attended action", () => {
  expect(
    describeCredentialRefusal({
      ...answered,
      exitCode: grokCredentialProbeExitCodes.noCredential,
      timedOut: false,
    }),
  ).toMatchObject({
    detail: expect.stringContaining("No subscription login is enrolled"),
    reason: "provider-authentication",
    state: "paused",
  });
});

test("a credential that is not the subscription login pauses rather than being used", () => {
  expect(
    describeCredentialRefusal({
      ...answered,
      exitCode: grokCredentialProbeExitCodes.notSubscription,
      timedOut: false,
    }),
  ).toMatchObject({
    detail: expect.stringContaining("not the subscription login"),
    reason: "provider-authentication",
    state: "paused",
  });
});

test("another billing route reachable from the custody identity pauses as drift", () => {
  expect(
    describeCredentialRefusal({
      ...answered,
      exitCode: grokCredentialProbeExitCodes.otherRoutePresent,
      timedOut: false,
    }),
  ).toMatchObject({
    detail: expect.stringContaining("deployment key or API key"),
    reason: "provider-contract-drift",
    state: "paused",
  });
});

test("a crossing that did not reach the custody identity pauses as drift", () => {
  expect(
    describeCredentialRefusal({
      ...answered,
      exitCode: grokCredentialProbeExitCodes.wrongIdentity,
      timedOut: false,
    }),
  ).toMatchObject({
    detail: expect.stringContaining("custody identity"),
    reason: "provider-contract-drift",
    state: "paused",
  });
});

test("a probe that did not answer in time pauses rather than starting a run", () => {
  expect(
    describeCredentialRefusal({ ...answered, exitCode: null, timedOut: true }),
  ).toMatchObject({
    detail: expect.stringContaining("did not answer"),
    reason: "provider-authentication",
    state: "paused",
  });
});

test("an exit code this contract does not recognise still pauses", () => {
  expect(
    describeCredentialRefusal({ ...answered, exitCode: 1, timedOut: false }),
  ).toMatchObject({
    reason: "provider-authentication",
    state: "paused",
  });
});

test("an unexecutable broker is crossing drift, not a custody refusal", () => {
  expect(describeUnreachableAuthCrossing()).toEqual({
    detail:
      "The executor identity could not execute the token broker; the task waits for the Auth Crossing's executable and parent-directory modes to be restored.",
    evidence: null,
    reason: "provider-contract-drift",
    state: "paused",
  });
});

/**
 * The exit codes are a contract across two languages and the enrollment
 * prerequisite. The halves cannot import one another, so bind all three here:
 * otherwise a renumbering could make enrollment reject a reachable crossing
 * and make a Delegation pause for the wrong reason.
 */
test("the helper, executor, and enrollment prerequisite agree on probe exit codes", async () => {
  const [helper, prerequisites] = await Promise.all([
    readFile(
      fileURLToPath(new URL("../../../ops/grok/grok-token-helper", import.meta.url)),
      "utf8",
    ),
    readFile(
      fileURLToPath(
        new URL(
          "../../../ops/acceptance/grok-enrollment-prerequisites.sh",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ]);

  expect(
    Object.fromEntries(
      [...helper.matchAll(/^readonly (EXIT_[A-Z_]+)=(\d+)$/gmu)].map(
        ([, name, code]) => [name, Number(code)],
      ),
    ),
  ).toEqual({
    EXIT_EXPIRED: grokCredentialProbeExitCodes.expired,
    EXIT_NO_CREDENTIAL: grokCredentialProbeExitCodes.noCredential,
    EXIT_NOT_SUBSCRIPTION: grokCredentialProbeExitCodes.notSubscription,
    EXIT_OTHER_ROUTE: grokCredentialProbeExitCodes.otherRoutePresent,
    EXIT_WRONG_IDENTITY: grokCredentialProbeExitCodes.wrongIdentity,
  });

  const reachablePattern = prerequisites.match(
    /^\s*((?:\d+\|)*\d+)\) return 0 ;;$/mu,
  );
  expect(reachablePattern).not.toBeNull();
  expect(reachablePattern?.[1]?.split("|").map(Number)).toEqual(
    [0, ...Object.values(grokCredentialProbeExitCodes)].sort((left, right) =>
      left - right,
    ),
  );
});

/**
 * The runner does not renew a credential part way through a run. A headless
 * run whose login expired mid-flight returned a 401 after spending 305 output
 * tokens on the request that failed, and the crossing was never asked for
 * another token. Observed on grok 1.0.13; see the addendum in
 * docs/research/grok-build-install-and-auth.md.
 */
test("a login that expires before the run's bound pauses before anything is spent", () => {
  expect(
    describeCredentialRefusal({
      exitCode: 0,
      remainingSeconds: 900,
      requiredSeconds,
      timedOut: false,
    }),
  ).toEqual({
    detail:
      "The subscription login expires before this run's time bound, and the runner does not renew one part way through; the task waits for the login to be renewed on expiry.",
    evidence: null,
    reason: "provider-authentication",
    state: "paused",
  });
});

test("an answer carrying no lifetime pauses as drift", () => {
  expect(
    describeCredentialRefusal({
      exitCode: 0,
      remainingSeconds: null,
      requiredSeconds,
      timedOut: false,
    }),
  ).toMatchObject({ reason: "provider-contract-drift", state: "paused" });
});

const seeded = {
  authenticationMode: "external",
  exitCode: 0,
  remainingSeconds: 21_600,
  requiredSeconds,
  timedOut: false,
};

test("a run home signed in through the broker proceeds", () => {
  expect(describeCredentialSeedingRefusal(seeded)).toBeNull();
});

/**
 * A provider command that exits non-zero does not fail the login: grok falls
 * back to an interactive device authorization and waits five minutes for a
 * browser nobody is driving. The bound is what makes that an ending.
 */
test("a login that waited for a browser pauses naming authentication", () => {
  expect(
    describeCredentialSeedingRefusal({
      ...seeded,
      exitCode: null,
      timedOut: true,
    }),
  ).toMatchObject({
    detail: expect.stringContaining("did not finish in time"),
    reason: "provider-authentication",
    state: "paused",
  });
});

test("a run home left holding no credential pauses rather than being spawned", () => {
  expect(
    describeCredentialSeedingRefusal({
      ...seeded,
      authenticationMode: null,
      remainingSeconds: null,
    }),
  ).toMatchObject({
    detail: expect.stringContaining("not signed in through the Auth Crossing"),
    reason: "provider-authentication",
    state: "paused",
  });
});

/**
 * `grok login` through the broker writes `auth_mode: "external"`. Anything
 * else in that field is a credential this crossing did not mint - a cached
 * device-OAuth login the executor identity should not have, for instance.
 */
test("a credential the broker did not mint pauses as drift", () => {
  expect(
    describeCredentialSeedingRefusal({ ...seeded, authenticationMode: "oidc" }),
  ).toMatchObject({ reason: "provider-contract-drift", state: "paused" });
});

test("a minted credential shorter than the run's bound pauses before the model", () => {
  expect(
    describeCredentialSeedingRefusal({ ...seeded, remainingSeconds: 60 }),
  ).toMatchObject({
    detail: expect.stringContaining("expires before this run's time bound"),
    reason: "provider-authentication",
    state: "paused",
  });
});
