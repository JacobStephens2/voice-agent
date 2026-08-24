import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createKeeploreButtonTrialScenario,
  type KeeploreButtonTrialScenario,
} from "@voice-agent/scenario";
import { createTaskContinuityRuntime } from "@voice-agent/runtime";
import {
  createSqliteDurableTaskStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";
import type {
  KeeploreDelegationBrief,
  KeeploreDelegationResult,
  KeeploreRegistration,
  KeeploreWorktree,
} from "@voice-agent/contracts";

const temporaryDirectories: string[] = [];
const now = "2026-08-24T20:31:00.000Z";
const sourceCommit = "1111111111111111111111111111111111111111";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a confirmed Delegation's terminal outcome reaches the caller who never asks again", async () => {
  const databasePath = join(await temporaryDirectory(), "voice-agent.sqlite");
  const scenario = await createScenario(databasePath);
  await scenario.authenticateTelephoneSession("telephone-session-report");

  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-report",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-report-request",
  });

  // Confirming the Delegation must arrange the report, not merely promise one.
  const confirmed = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-report",
    transcript: "Yes.",
    turnId: "turn-report-confirm",
  });
  expect(confirmed.actions).toEqual([
    {
      interruptible: true,
      kind: "offer-completion-callback",
      responseId: "turn-report-confirm:delegation-response",
      taskId: "task-button-trial",
      text:
        "The Keeplore Button Trial is confirmed and delegated to restricted Codex on a non-production branch. Nothing will be merged or deployed. I can disconnect and call your registered telephone when it finishes. Would you like that?",
    },
  ]);

  const accepted = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-report",
    transcript: "Yes, please.",
    turnId: "turn-report-callback",
  });
  expect(accepted.actions).toEqual([
    {
      interruptible: false,
      kind: "request-completion-callback-and-disconnect",
      requestId: "completion-callback:turn-report-callback",
      taskId: "task-button-trial",
      telephoneSessionId: "telephone-session-report",
    },
  ]);

  // The worker turns that action into a Completion Callback request and the
  // call ends, exactly as the live session does.
  const continuity = await createContinuity(databasePath);
  await continuity.runtime.requestCompletionCallback({
    requestId: "completion-callback:turn-report-callback",
    taskId: "task-button-trial",
    telephone: registeredTelephone(),
    telephoneSessionId: "telephone-session-report",
  });

  // The Delegation then fails on a real acceptance criterion, as `cafd2243` did.
  const terminal = await scenario.processNextDelegation();
  expect(terminal?.task).toMatchObject({
    conclusion: "Keeplore Button Trial could not be verified.",
    status: "failed",
  });

  // The caller says nothing further, and is still called back with the outcome.
  await expect(continuity.runtime.processNextReport()).resolves.toMatchObject({
    kind: "place-completion-callback",
    taskId: "task-button-trial",
  });
  await continuity.close();
});

async function createContinuity(databasePath: string): Promise<{
  readonly close: () => Promise<void>;
  readonly runtime: ReturnType<typeof createTaskContinuityRuntime>;
}> {
  const taskStore = createSqliteDurableTaskStore(databasePath);
  const continuityStore = createSqliteTaskContinuityStore(databasePath);
  const ids = ["report-1", "operation-1", "event-1"];
  const runtime = createTaskContinuityRuntime({
    nextId: () => ids.shift() ?? "spare",
    now: () => now,
    store: continuityStore,
    tasks: taskStore,
  });
  await runtime.configureNotification({
    email: "owner@example.com",
    from: "Voice Agent <tasks@notify.stephens.page>",
    notificationSubdomain: "notify.stephens.page",
  });
  return {
    async close() {
      await runtime.close();
      await taskStore.close();
    },
    runtime,
  };
}

function registeredTelephone() {
  return {
    livekitInboundTrunkId: "livekit-inbound",
    livekitOutboundTrunkId: "livekit-outbound",
    registeredAt: now,
    revision: 1,
    telephoneNumber: "+15555550100",
    telnyxNumber: "+15555550111",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-outcome-report-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createScenario(
  databasePath: string,
): Promise<KeeploreButtonTrialScenario> {
  return createKeeploreButtonTrialScenario({
    databasePath,
    ids: ["task-button-trial", "delegation-button-trial"],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute({ brief, worktree }) {
        return mobileHeightFailure(brief, worktree);
      },
    },
    sourceCommit,
  });
}

function keeploreRegistration(): KeeploreRegistration {
  return {
    applicationId: "keeplore-production",
    deploymentBoundaries: {
      liveCheckoutPath: "/var/www/keeplore.app",
      releaseRoot: "/opt/keeplore/releases",
      retainedReleases: 2,
      sharedRoot: "/opt/keeplore/shared",
      sourceMirrorPath: "/var/lib/keeplore-source/repository.git",
    },
    permittedSubagentProvider: "codex",
    productionBranch: "main",
    readScope: [
      "**/*.php",
      "**/*.js",
      "**/*.css",
      "!**/environment_variables.php",
    ],
    registeredAt: "2026-08-21T12:00:00.000Z",
    registeredBy: "fresh-passkey-action",
    repository: "JacobStephens2/keeplore",
    revision: 1,
    verification: {
      checkName: "keeplore-verification",
      command: "vendor/bin/phpunit",
    },
    worktreeRoot: "/var/lib/voice-agent-worktrees/keeplore",
  };
}

/** The real `cafd2243` outcome: verification ran and the mobile check failed. */
function mobileHeightFailure(
  brief: KeeploreDelegationBrief,
  worktree: KeeploreWorktree,
): KeeploreDelegationResult {
  return {
    branch: worktree.branch,
    changedFiles: ["ui/style.css"],
    cleanup: {
      eligible: false,
      quarantineReason:
        "Delegated Worktree is incomplete or dirty and must be retained",
    },
    commits: [],
    completedAt: now,
    delegationId: brief.delegationId,
    environment: {
      dockerSocket: false,
      identity: "voice-codex",
      operationsBroker: false,
      productionDirectoryWrite: false,
      productionSecrets: false,
      providerLogin: "separate-eligible-subscription",
      sudo: false,
    },
    failure: {
      evidencePaths: [
        `/var/lib/voice-agent-evidence/${brief.delegationId}/restricted-runner-failure.json`,
      ],
      kind: "delegation-execution",
      message: "mobile Keeplore controls differ in height",
      name: "RestrictedRunFailure",
    },
    pullRequest: { state: "none", url: null },
    risks: ["Mobile table-view controls still differ in height."],
    status: "failed",
    verification: {
      automated: [
        {
          command: "vendor/bin/phpunit",
          outcome: "passed",
          summary: "Keeplore verification passed.",
        },
      ],
      cardView: {
        afterHash: "card-view-baseline",
        beforeHash: "card-view-baseline",
        unchanged: true,
      },
      computedStyles: [],
      screenshots: [],
    },
    worktree: { ...worktree, dirty: true, state: "failed" },
  };
}
