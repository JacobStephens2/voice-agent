import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createBountywellOutageScenario } from "../src/bountywell-outage.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function nextIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

describe("Bountywell outage recovery scenario", () => {
  test("an inactive registered unit is diagnosed from observation and recovered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-outage-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellOutageScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: nextIds("outage", 40),
      now: "2026-08-18T12:00:00.000Z",
    });

    try {
      await scenario.registerBountywell();
      expect(await scenario.grantRestart({ source: "trusted-session" })).toEqual({
        decision: "denied",
        reason: "Fresh Passkey Action required",
      });
      expect(await scenario.grantRestart({ source: "voice" })).toEqual({
        decision: "denied",
        reason: "Voice cannot expand Bountywell service-control authority",
      });
      expect(await scenario.grantRestart({ source: "repository" })).toEqual({
        decision: "denied",
        reason: "Repository content cannot expand Bountywell service-control authority",
      });

      const granted = await scenario.grantRestart({ source: "fresh-passkey" });
      expect(granted).toMatchObject({
        decision: "granted",
        registration: {
          applicationId: "bountywell-production",
          revision: 2,
          serviceUnit: "bountywell-api.service",
        },
      });
      if (granted.decision !== "granted") {
        throw new Error("Expected restart authority to be granted");
      }
      expect(granted.registration.capabilities).toEqual([
        "bountywell.public-health.read",
        "bountywell.authentication-boundary.read",
        "bountywell.local-health.read",
        "bountywell.service-metadata.read",
        "bountywell.resource-evidence.read",
        "bountywell.service.restart",
      ]);

      const timer = await scenario.armRecoveryTimer();
      expect(timer).toEqual({
        armed: true,
        delaySeconds: 600,
        unit: "bountywell-api.service",
      });
      expect(await scenario.proveRecoveryTimer()).toEqual({
        capable: true,
        delaySeconds: 600,
        unit: "bountywell-api.service",
      });
      expect(scenario.timer.armed).toBe(true);

      expect(await scenario.captureBaseline()).toEqual({
        authenticationBoundary: 401,
        publicHealth: 200,
        serviceActive: true,
      });

      await expect(
        scenario.injectFault({ ownerAvailable: false }),
      ).rejects.toThrow("The live drill occurs only while the owner is available");

      const injected = await scenario.injectFault({ ownerAvailable: true });
      expect(injected.report).toBe("Bountywell's API appears unavailable.");
      expect(scenario.hostCommands.filter((command) => command.action === "stop")).toEqual([
        { action: "stop", unit: "bountywell-api.service" },
      ]);

      const record = await scenario.recover(injected.requestId);
      expect(record.task).toMatchObject({
        conclusion: "Bountywell API was recovered.",
        kind: "bountywell.outage.recovery",
        question: "Bountywell's API appears unavailable.",
        status: "completed",
      });

      const kinds = record.evidence.map((event) => event.kind);
      expect(kinds).toEqual(expect.arrayContaining([
        "fault.reported",
        "evidence.observed",
        "diagnosis.recorded",
        "policy.decided",
        "operation.accepted",
        "operation.completed",
        "timer.lifecycle",
        "task.completed",
      ]));

      const diagnosis = record.evidence.find(
        (event) => event.kind === "diagnosis.recorded",
      );
      expect(diagnosis?.details).toMatchObject({
        alreadyRecovered: false,
        basis: "observation",
        inactiveUnit: "bountywell-api.service",
      });
      expect(diagnosis?.summary).toContain("observation");
      expect(diagnosis?.summary).not.toContain("inference");

      const policy = record.evidence.find(
        (event) =>
          event.kind === "policy.decided" &&
          event.details.capability === "bountywell.service.restart",
      );
      expect(policy?.details).toMatchObject({
        capability: "bountywell.service.restart",
        decision: "allow",
      });
      expect(
        record.evidence.filter(
          (event) =>
            event.kind === "policy.decided" &&
            event.details.capability === "bountywell.outage.drill",
        ),
      ).not.toHaveLength(0);

      const timerEvents = record.evidence.filter(
        (event) => event.kind === "timer.lifecycle",
      );
      expect(timerEvents.map((event) => event.details.phase)).toEqual([
        "armed",
        "proven",
        "removed",
      ]);

      expect(JSON.stringify(record)).not.toContain("journalctl");
      expect(JSON.stringify(record)).not.toContain("password");
      expect(JSON.stringify(record)).not.toContain("/var/log");

      const startsBeforeReplay = scenario.hostCommands.filter(
        (command) => command.action === "start",
      );
      const replay = await scenario.recover(injected.requestId);
      expect(replay).toEqual(record);
      expect(
        scenario.hostCommands.filter((command) => command.action === "start"),
      ).toEqual(startsBeforeReplay);
      expect(scenario.timer.armed).toBe(false);
      expect(scenario.hostCommands.map((command) => command.unit).every(
        (unit) => unit === "bountywell-api.service",
      )).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("policy denies restart before restart authority is enrolled and leaves the timer armed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-outage-deny-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellOutageScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: nextIds("deny", 40),
      now: "2026-08-18T13:00:00.000Z",
    });

    try {
      await scenario.registerBountywell();
      await scenario.armRecoveryTimer();
      expect(await scenario.proveRecoveryTimer()).toMatchObject({ capable: true });
      await scenario.captureBaseline();
      const injected = await scenario.injectFault({ ownerAvailable: true });
      const startsBefore = scenario.hostCommands.filter(
        (command) => command.action === "start",
      ).length;

      const record = await scenario.recover(injected.requestId);
      expect(record.task.conclusion).toBe(
        "Bountywell API recovery could not be confirmed.",
      );
      const diagnosis = record.evidence.find(
        (event) => event.kind === "diagnosis.recorded",
      );
      expect(diagnosis?.details).toMatchObject({
        basis: "observation",
        inactiveUnit: "bountywell-api.service",
      });
      expect(
        record.evidence.find(
          (event) =>
            event.kind === "policy.decided" &&
            event.details.capability === "bountywell.service.restart",
        )?.details,
      ).toMatchObject({
        capability: "bountywell.service.restart",
        decision: "deny",
      });
      expect(
        record.evidence.some(
          (event) =>
            event.kind === "timer.lifecycle" && event.details.phase === "retained",
        ),
      ).toBe(true);
      expect(scenario.timer.armed).toBe(true);
      expect(
        scenario.hostCommands.filter((command) => command.action === "start"),
      ).toHaveLength(startsBefore);
      expect(
        scenario.hostCommands.some((command) => command.unit !== "bountywell-api.service"),
      ).toBe(false);
    } finally {
      await scenario.close();
    }
  });

  test("an already-recovered service is not restarted and still removes the timer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-outage-already-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellOutageScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: nextIds("already", 40),
      now: "2026-08-18T14:00:00.000Z",
    });

    try {
      await prepareAuthorizedDrill(scenario);
      const injected = await scenario.injectFault({ ownerAvailable: true });
      await scenario.restoreService();
      const startsBefore = scenario.hostCommands.filter(
        (command) => command.action === "start",
      ).length;

      const record = await scenario.recover(injected.requestId);
      expect(record.task.conclusion).toBe("Bountywell API was already recovered.");
      expect(
        record.evidence.find((event) => event.kind === "diagnosis.recorded")
          ?.details,
      ).toMatchObject({ alreadyRecovered: true, basis: "observation" });
      expect(
        scenario.hostCommands.filter((command) => command.action === "start"),
      ).toHaveLength(startsBefore);
      expect(scenario.timer.armed).toBe(false);
    } finally {
      await scenario.close();
    }
  });

  test("restart failure leaves the recovery timer armed and reports uncertainty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-outage-restart-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellOutageScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: nextIds("restart-fail", 40),
      now: "2026-08-18T15:00:00.000Z",
    });

    try {
      await prepareAuthorizedDrill(scenario);
      scenario.setStartFailure(true);
      const injected = await scenario.injectFault({ ownerAvailable: true });
      const record = await scenario.recover(injected.requestId);
      expect(record.task.conclusion).toBe(
        "Bountywell API recovery could not be confirmed.",
      );
      expect(scenario.timer.armed).toBe(true);
      expect(
        record.evidence.some(
          (event) =>
            event.kind === "timer.lifecycle" && event.details.phase === "retained",
        ),
      ).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("failed public verification after restart leaves the timer armed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-outage-verify-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellOutageScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: nextIds("verify-fail", 40),
      now: "2026-08-18T16:00:00.000Z",
    });

    try {
      await prepareAuthorizedDrill(scenario);
      scenario.setAfterStart({
        authenticationBoundary: 401,
        publicHealth: 500,
      });
      const injected = await scenario.injectFault({ ownerAvailable: true });
      const record = await scenario.recover(injected.requestId);
      expect(record.task.conclusion).toBe(
        "Bountywell API recovery could not be confirmed.",
      );
      expect(scenario.timer.armed).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("the independent timer starts only the registered unit after ten minutes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-outage-timer-"));
    temporaryDirectories.push(directory);
    const scenario = await createBountywellOutageScenario({
      databasePath: join(directory, "tasks.sqlite"),
      ids: nextIds("timer", 40),
      now: "2026-08-18T17:00:00.000Z",
    });

    try {
      await prepareAuthorizedDrill(scenario);
      await scenario.injectFault({ ownerAvailable: true });
      expect(scenario.timer.armed).toBe(true);
      await scenario.advanceMs(599_000);
      expect(scenario.timer.armed).toBe(true);
      await scenario.advanceMs(1_000);
      expect(scenario.timer.armed).toBe(false);
      expect(scenario.hostCommands.filter((command) => command.action === "start").at(-1)).toEqual({
        action: "start",
        unit: "bountywell-api.service",
      });
    } finally {
      await scenario.close();
    }
  });
});

async function prepareAuthorizedDrill(
  scenario: Awaited<ReturnType<typeof createBountywellOutageScenario>>,
): Promise<void> {
  await scenario.registerBountywell();
  await scenario.grantRestart({ source: "fresh-passkey" });
  await scenario.armRecoveryTimer();
  await scenario.proveRecoveryTimer();
  await scenario.captureBaseline();
}
