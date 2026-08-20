import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  createBountywellOutageScenario,
  type BountywellOutageScenario,
} from "../src/bountywell-outage.ts";

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

async function openScenario(
  prefix: string,
  now: string,
): Promise<BountywellOutageScenario> {
  const directory = await mkdtemp(join(tmpdir(), `voice-agent-${prefix}-`));
  temporaryDirectories.push(directory);
  return createBountywellOutageScenario({
    databasePath: join(directory, "tasks.sqlite"),
    ids: nextIds(prefix, 60),
    now,
  });
}

function countCommands(
  scenario: BountywellOutageScenario,
  action: "install-timer" | "remove-timer" | "start" | "stop",
): number {
  return scenario.hostCommands.filter((command) => command.action === action)
    .length;
}

function onlyRegisteredUnit(scenario: BountywellOutageScenario): boolean {
  return scenario.hostCommands.every(
    (command) => command.unit === "bountywell-api.service",
  );
}

async function prepareDrill(scenario: BountywellOutageScenario): Promise<void> {
  await scenario.registerBountywell();
  await scenario.grantRestart({ source: "fresh-passkey" });
  await scenario.armRecoveryTimer();
  await scenario.proveRecoveryTimer();
  await scenario.captureBaseline();
}

describe("Bountywell drill Interventions are durable Operations", () => {
  test("arming replays its recorded result across restart without a second timer", async () => {
    const scenario = await openScenario("drill-arm", "2026-08-19T09:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await scenario.grantRestart({ source: "fresh-passkey" });
      expect(await scenario.armRecoveryTimer()).toEqual({
        armed: true,
        delaySeconds: 600,
        unit: "bountywell-api.service",
      });
      const installs = countCommands(scenario, "install-timer");

      await scenario.restart({ ids: nextIds("drill-arm-retry", 60) });

      expect(await scenario.armRecoveryTimer()).toEqual({
        armed: true,
        delaySeconds: 600,
        unit: "bountywell-api.service",
      });
      expect(countCommands(scenario, "install-timer")).toBe(installs);
      expect(onlyRegisteredUnit(scenario)).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("proof replays from its Evidence Event and does not fire the timer again", async () => {
    const scenario = await openScenario("drill-prove", "2026-08-19T10:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await scenario.grantRestart({ source: "fresh-passkey" });
      await scenario.armRecoveryTimer();
      expect(await scenario.proveRecoveryTimer()).toEqual({
        capable: true,
        delaySeconds: 600,
        unit: "bountywell-api.service",
      });
      const startsAfterProof = countCommands(scenario, "start");
      const installsAfterProof = countCommands(scenario, "install-timer");

      await scenario.restart({ ids: nextIds("drill-prove-retry", 60) });

      expect(await scenario.proveRecoveryTimer()).toEqual({
        capable: true,
        delaySeconds: 600,
        unit: "bountywell-api.service",
      });
      expect(countCommands(scenario, "start")).toBe(startsAfterProof);
      expect(countCommands(scenario, "install-timer")).toBe(installsAfterProof);
      expect(scenario.timer.armed).toBe(true);
      expect(onlyRegisteredUnit(scenario)).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("a restart before inject still shows an armed, proven timer and the baseline", async () => {
    const scenario = await openScenario("drill-restart", "2026-08-19T11:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await scenario.grantRestart({ source: "fresh-passkey" });
      await scenario.armRecoveryTimer();
      await scenario.proveRecoveryTimer();
      await scenario.captureBaseline();

      await scenario.restart({ ids: nextIds("drill-restart-resumed", 60) });

      expect(await scenario.captureBaseline()).toEqual({
        authenticationBoundary: 401,
        publicHealth: 200,
        serviceActive: true,
      });
      const injected = await scenario.injectFault({ ownerAvailable: true });
      await scenario.present();
      const record = await scenario.recover(injected.requestId);
      const phases = record.evidence
        .filter((event) => event.kind === "timer.lifecycle")
        .map((event) => event.details.phase);
      expect(phases).toEqual(["armed", "proven", "removed"]);
      expect(record.task.conclusion).toBe("Bountywell API was recovered.");
      expect(onlyRegisteredUnit(scenario)).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("a duplicate inject replays the drill without stopping the unit again", async () => {
    const scenario = await openScenario("drill-stop", "2026-08-19T12:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await scenario.grantRestart({ source: "fresh-passkey" });
      await scenario.armRecoveryTimer();
      await scenario.proveRecoveryTimer();
      await scenario.captureBaseline();
      const injected = await scenario.injectFault({ ownerAvailable: true });
      expect(countCommands(scenario, "stop")).toBe(1);

      await scenario.restart({ ids: nextIds("drill-stop-retry", 60) });

      expect(await scenario.injectFault({ ownerAvailable: true })).toEqual(injected);
      expect(countCommands(scenario, "stop")).toBe(1);
      expect(onlyRegisteredUnit(scenario)).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("a crash after arming leaves one armed timer and one armed Evidence Event", async () => {
    const scenario = await openScenario("drill-arm-crash", "2026-08-19T14:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await scenario.grantRestart({ source: "fresh-passkey" });
      scenario.setCrashAfter("install-timer");
      await expect(scenario.armRecoveryTimer()).rejects.toThrow(
        "The Agent Host connection was lost after install-timer",
      );

      await scenario.restart({ ids: nextIds("drill-arm-crash-retry", 60) });

      expect(await scenario.armRecoveryTimer()).toEqual({
        armed: true,
        delaySeconds: 600,
        unit: "bountywell-api.service",
      });
      // Arming reconciles against the Agent Host, so the interrupted acceptance
      // resumes without installing the timer a second time.
      expect(countCommands(scenario, "install-timer")).toBe(1);
      await scenario.proveRecoveryTimer();
      await scenario.captureBaseline();
      const injected = await scenario.injectFault({ ownerAvailable: true });
      await scenario.present();
      const record = await scenario.recover(injected.requestId);
      const phases = record.evidence
        .filter((event) => event.kind === "timer.lifecycle")
        .map((event) => event.details.phase);
      expect(phases).toEqual(["armed", "proven", "removed"]);
      expect(onlyRegisteredUnit(scenario)).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("a crash after stopping reports the fault once and never stops a recovered unit", async () => {
    const scenario = await openScenario("drill-stop-crash", "2026-08-19T15:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await scenario.grantRestart({ source: "fresh-passkey" });
      await scenario.armRecoveryTimer();
      await scenario.proveRecoveryTimer();
      await scenario.captureBaseline();
      scenario.setCrashAfter("stop");
      await expect(
        scenario.injectFault({ ownerAvailable: true }),
      ).rejects.toThrow("The Agent Host connection was lost after stop");

      await scenario.restart({ ids: nextIds("drill-stop-crash-retry", 60) });

      const injected = await scenario.injectFault({ ownerAvailable: true });
      await scenario.present();
      const record = await scenario.recover(injected.requestId);
      expect(record.task.conclusion).toBe("Bountywell API was recovered.");
      expect(
        record.evidence.filter((event) => event.kind === "fault.reported"),
      ).toHaveLength(1);
      const stopsAfterRecovery = countCommands(scenario, "stop");

      // The recovered drill is closed, so a later request opens a fresh drill
      // rather than stopping the unit that was just brought back.
      await expect(
        scenario.injectFault({ ownerAvailable: true }),
      ).rejects.toThrow("Recovery timer is not armed");
      expect(countCommands(scenario, "stop")).toBe(stopsAfterRecovery);
      expect(onlyRegisteredUnit(scenario)).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("an inject interrupted after the stop completes still recovers", async () => {
    // Starve one inject of identifiers just after its stop Operation completes,
    // so the process dies between the recorded fault and the diagnosis
    // Operation. The identifier budget is probed on throwaway drills rather
    // than hand-counted, so it survives a change in identifier use.
    let scenario: BountywellOutageScenario | undefined;
    let stopsBeforeResume = 0;
    for (const budget of [3, 4, 5, 6, 7, 8]) {
      const candidate = await openScenario(
        `drill-half-inject-${budget}`,
        "2026-08-19T16:00:00.000Z",
      );
      await prepareDrill(candidate);
      await candidate.restart({ ids: nextIds(`cut-${budget}`, budget) });
      await candidate.injectFault({ ownerAvailable: true }).catch(() => undefined);
      const kinds = new Set(
        (await candidate.readOpenDrill())?.evidence.map((event) => event.kind),
      );
      if (kinds.has("fault.reported") && !kinds.has("task.accepted")) {
        scenario = candidate;
        stopsBeforeResume = countCommands(candidate, "stop");
        break;
      }
      await candidate.close();
    }
    if (scenario === undefined) {
      throw new Error("No identifier budget interrupted the inject after its stop");
    }

    try {
      await scenario.restart({ ids: nextIds("drill-half-inject-resumed", 60) });

      const injected = await scenario.injectFault({ ownerAvailable: true });
      expect(countCommands(scenario, "stop")).toBe(stopsBeforeResume);
      await scenario.present();
      const record = await scenario.recover(injected.requestId);
      expect(record.task.conclusion).toBe("Bountywell API was recovered.");
      expect(
        record.evidence.filter((event) => event.kind === "fault.reported"),
      ).toHaveLength(1);
      expect(
        record.evidence.filter((event) => event.kind === "task.accepted"),
      ).toHaveLength(1);
      expect(onlyRegisteredUnit(scenario)).toBe(true);
    } finally {
      await scenario.close();
    }
  });

  test("an unregistered Bountywell cannot be armed, proven, or stopped", async () => {
    const scenario = await openScenario("drill-policy", "2026-08-19T17:00:00.000Z");
    try {
      await expect(scenario.armRecoveryTimer()).rejects.toThrow(
        "Bountywell is not registered for the guarded outage drill.",
      );
      await expect(scenario.proveRecoveryTimer()).rejects.toThrow(
        "Bountywell is not registered for the guarded outage drill.",
      );
      await expect(
        scenario.injectFault({ ownerAvailable: true }),
      ).rejects.toThrow("Bountywell is not registered for the guarded outage drill.");
      expect(scenario.hostCommands).toEqual([]);

      await scenario.registerBountywell();
      const armed = await scenario.armRecoveryTimer();
      expect(armed.armed).toBe(true);
      const drill = await scenario.readOpenDrill();
      expect(
        drill?.evidence.find((event) => event.kind === "policy.decided")?.details,
      ).toMatchObject({
        capability: "bountywell.outage.drill",
        decision: "allow",
      });
    } finally {
      await scenario.close();
    }
  });

  test("a drill being prepared never advertises a fault it has not injected", async () => {
    const scenario = await openScenario("drill-summary", "2026-08-19T18:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await scenario.grantRestart({ source: "fresh-passkey" });
      await scenario.armRecoveryTimer();
      expect((await scenario.readOpenDrill())?.task).toMatchObject({
        conclusion: "Bountywell Outage Drill preparation is pending.",
        question: "Is the guarded Bountywell Outage Drill ready?",
        status: "pending",
      });

      await scenario.proveRecoveryTimer();
      await scenario.restart({ ids: nextIds("drill-summary-resumed", 60) });

      expect((await scenario.readOpenDrill())?.task).toMatchObject({
        conclusion: "Bountywell Outage Drill is armed and ready.",
        question: "Is the guarded Bountywell Outage Drill ready?",
        status: "pending",
      });

      const injected = await scenario.injectFault({ ownerAvailable: true });
      expect((await scenario.readOpenDrill())?.task).toMatchObject({
        conclusion: "Bountywell outage recovery is pending.",
        question: "Bountywell's API appears unavailable.",
        status: "pending",
      });

      await scenario.present();
      const record = await scenario.recover(injected.requestId);
      expect(record.task).toMatchObject({
        conclusion: "Bountywell API was recovered.",
        question: "Bountywell's API appears unavailable.",
        status: "completed",
      });
    } finally {
      await scenario.close();
    }
  });

  test("the drill refuses to inject behind a timer that is not armed", async () => {
    const scenario = await openScenario("drill-unarmed", "2026-08-19T13:00:00.000Z");
    try {
      await scenario.registerBountywell();
      await expect(scenario.proveRecoveryTimer()).rejects.toThrow(
        "Recovery timer is not armed",
      );
      await expect(
        scenario.injectFault({ ownerAvailable: true }),
      ).rejects.toThrow("Recovery timer is not armed");
      expect(countCommands(scenario, "stop")).toBe(0);

      await scenario.armRecoveryTimer();
      const injected = await scenario.injectFault({ ownerAvailable: true });
      expect(injected.report).toBe("Bountywell's API appears unavailable.");
      expect(countCommands(scenario, "stop")).toBe(1);
    } finally {
      await scenario.close();
    }
  });
});
