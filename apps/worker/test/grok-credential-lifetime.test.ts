import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
  describeCredentialRefusal,
  grokCredentialProbeExitCodes,
} from "../src/grok-credential-lifetime.ts";

test("a credential the custody identity could mint from lets the run proceed", () => {
  expect(describeCredentialRefusal({ exitCode: 0, timedOut: false })).toBeNull();
});

test("an expired login the runner could not renew pauses the task naming expiry", () => {
  const outcome = describeCredentialRefusal({
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
  expect(describeCredentialRefusal({ exitCode: null, timedOut: true })).toMatchObject({
    detail: expect.stringContaining("did not answer"),
    reason: "provider-authentication",
    state: "paused",
  });
});

test("an exit code this contract does not recognise still pauses", () => {
  expect(describeCredentialRefusal({ exitCode: 1, timedOut: false })).toMatchObject({
    reason: "provider-authentication",
    state: "paused",
  });
});

/**
 * The exit codes are a contract across two languages, and the half that
 * produces them cannot import the half that reads them. Nothing else would
 * notice a renumbering until a Delegation paused for the wrong reason.
 */
test("the helper that produces these codes agrees with the module that reads them", async () => {
  const helper = await readFile(
    fileURLToPath(new URL("../../../ops/grok/grok-token-helper", import.meta.url)),
    "utf8",
  );

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
});
