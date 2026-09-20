import { expect, test } from "vitest";

import {
  appendGrokEnrollmentEvent,
  createGrokEnrollmentRecord,
  evaluateGrokEnrollment,
  grokContractFailureConditions,
  grokFailureDrillOutcomes,
  markGrokEnrollmentAccepted,
  type GrokEnrollmentRecord,
} from "@voice-agent/contracts";

const configurationPath = "/etc/voice-agent/grok/config.toml";
const digest = "a".repeat(64);
const version = "0.2.111";

test("a new enrollment is neither ready nor activated", () => {
  const evaluation = evaluateGrokEnrollment(
    createGrokEnrollmentRecord({ campaignId: "grok-enrollment" }),
  );

  expect(evaluation.activated).toBe(false);
  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toContain("No reviewed runner version and digest are pinned.");
});

test("a complete contract test is ready and can be accepted", () => {
  const record = provedEnrollment();

  expect(evaluateGrokEnrollment(record)).toMatchObject({
    activated: false,
    errors: [],
    pinnedRunner: { configurationPath, digest, version },
    ready: true,
  });
  expect(
    evaluateGrokEnrollment(
      markGrokEnrollmentAccepted(record, { recordedAt: "2026-08-30T12:00:00.000Z" }),
    ).activated,
  ).toBe(true);
});

test("an enrollment without a real subscription-backed run is not ready", () => {
  const evaluation = evaluateGrokEnrollment(
    provedEnrollment({ omit: ["contract-run"] }),
  );

  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toContain(
    "No Grok Build run has completed through subscription OAuth.",
  );
});

test("an enrollment that has not drilled every failure condition is not ready", () => {
  const evaluation = evaluateGrokEnrollment(
    provedEnrollment({ conditions: ["timeout", "quota-exhaustion"] }),
  );

  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toContain(
    "These failure conditions have not produced a durable pause or terminal state: authentication-failure, entitlement-failure, malformed-output, provider-contract-drift, signal-interruption, turn-limit.",
  );
});

test("a run recorded against another runner build cannot be appended", () => {
  expect(() =>
    appendGrokEnrollmentEvent(provedEnrollment({ omit: ["contract-run"] }), {
      authenticationRoute: "subscription-oauth",
      kind: "contract-run",
      model: "grok-4.6",
      recordedAt: "2026-08-29T23:00:00.000Z",
      runner: { configurationPath, digest: "b".repeat(64), version },
      sessionId: "ses-1",
      stopReason: "end_turn",
      usageIncomplete: false,
    }),
  ).toThrow("A contract run must be recorded against the pinned runner");
});

test("a custody probe that read a boundary store or found a canary is not ready", () => {
  const evaluation = evaluateGrokEnrollment(
    provedEnrollment({ readableBoundaryPaths: 1 }),
  );

  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toContain(
    "The model process reached the Credential Custody Boundary.",
  );
});

test("a custody probe that did not confirm the child canary is not ready", () => {
  const evaluation = evaluateGrokEnrollment(
    provedEnrollment({ childCouldNotListOrExecute: false }),
  );

  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toContain(
    "A model-selected Bubblewrap child listed or executed the Auth Crossing.",
  );
});

test("a custody probe that did not confirm the parent unit probe is not ready", () => {
  const evaluation = evaluateGrokEnrollment(
    provedEnrollment({ parentUnitProbeAnswered: false }),
  );

  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toContain(
    "The parent broker probe under the contract unit did not answer.",
  );
});

test("a drill that fell back to another provider is not ready", () => {
  const record = appendGrokEnrollmentEvent(
    provedEnrollment({ conditions: [] }),
    {
      condition: "quota-exhaustion",
      fellBackToAnotherProvider: true,
      kind: "failure-drill",
      outcome: "paused",
      recordedAt: "2026-08-29T23:00:00.000Z",
    },
  );

  expect(evaluateGrokEnrollment(record).errors).toContain(
    "A failure drill fell back to another provider or billing route.",
  );
});

test("a stop that discarded work is not ready", () => {
  const evaluation = evaluateGrokEnrollment(
    provedEnrollment({ destructiveGitCommands: 1 }),
  );

  expect(evaluation.ready).toBe(false);
  expect(evaluation.errors).toContain(
    "Stopping a run did not preserve completed commits and unfinished work.",
  );
});

test("pinning a new runner build deactivates the provider until it passes again", () => {
  const accepted = markGrokEnrollmentAccepted(provedEnrollment(), {
    recordedAt: "2026-08-30T12:00:00.000Z",
  });

  const upgraded = appendGrokEnrollmentEvent(accepted, {
    configurationPath,
    digest: "c".repeat(64),
    kind: "runner-pinned",
    recordedAt: "2026-08-31T09:00:00.000Z",
    selfUpdateDisabled: true,
    version: "0.2.112",
  });

  expect(evaluateGrokEnrollment(upgraded)).toMatchObject({
    activated: false,
    pinnedRunner: {
      configurationPath,
      digest: "c".repeat(64),
      version: "0.2.112",
    },
    ready: false,
  });
  expect(evaluateGrokEnrollment(upgraded).errors).toContain(
    "No Grok Build run has completed through subscription OAuth.",
  );
});

test("a drill recorded as a state its condition cannot reach is refused", () => {
  expect(() =>
    appendGrokEnrollmentEvent(provedEnrollment({ conditions: [] }), {
      condition: "quota-exhaustion",
      fellBackToAnotherProvider: false,
      kind: "failure-drill",
      outcome: "failed",
      recordedAt: "2026-08-29T23:00:00.000Z",
    }),
  ).toThrow("A quota-exhaustion drill must end paused, not failed");
});

test("events are appended in recorded-time order", () => {
  expect(() =>
    appendGrokEnrollmentEvent(provedEnrollment(), {
      configurationPath,
      digest,
      kind: "runner-pinned",
      recordedAt: "2020-01-01T00:00:00.000Z",
      selfUpdateDisabled: true,
      version,
    }),
  ).toThrow("Enrollment Events must be appended in recorded-time order");
});

function provedEnrollment(options: {
  readonly childCouldNotListOrExecute?: boolean;
  readonly conditions?: readonly string[];
  readonly destructiveGitCommands?: number;
  readonly omit?: readonly string[];
  readonly parentUnitProbeAnswered?: boolean;
  readonly readableBoundaryPaths?: number;
} = {}): GrokEnrollmentRecord {
  const omitted = options.omit ?? [];
  let record = createGrokEnrollmentRecord({ campaignId: "grok-enrollment" });
  let clock = 0;
  const at = () =>
    new Date(Date.UTC(2026, 7, 29, 10, clock++)).toISOString().replace(".000Z", ".000Z");
  const append = (event: Record<string, unknown>) => {
    if (omitted.includes(String(event.kind))) return;
    record = appendGrokEnrollmentEvent(record, { ...event, recordedAt: at() });
  };
  append({
    configurationPath,
    digest,
    kind: "runner-pinned",
    selfUpdateDisabled: true,
    version,
  });
  append({
    apiKeyAbsent: true,
    authenticationRoute: "subscription-oauth",
    codeRetentionDisabled: true,
    kind: "subscription-enrolled",
  });
  append({
    authenticationRoute: "subscription-oauth",
    kind: "contract-run",
    model: "grok-4.6",
    runner: { configurationPath, digest, version },
    sessionId: "ses-1",
    stopReason: "end_turn",
    usageIncomplete: false,
  });
  append({
    canarySecretsFound: 0,
    childCouldNotListOrExecute: options.childCouldNotListOrExecute ?? true,
    kind: "custody-probe",
    parentUnitProbeAnswered: options.parentUnitProbeAnswered ?? true,
    readableBoundaryPaths: options.readableBoundaryPaths ?? 0,
  });
  for (const condition of options.conditions ?? grokContractFailureConditions) {
    append({
      condition,
      fellBackToAnotherProvider: false,
      kind: "failure-drill",
      outcome:
        grokFailureDrillOutcomes[
          condition as keyof typeof grokFailureDrillOutcomes
        ],
    });
  }
  append({
    commitsPreserved: true,
    destructiveGitCommands: options.destructiveGitCommands ?? 0,
    kind: "stop-drill",
    unfinishedWorkPreserved: true,
  });
  return record;
}
