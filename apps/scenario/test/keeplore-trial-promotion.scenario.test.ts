import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  createHumanMergePromotionScenario,
  createKeeploreButtonTrialScenario,
  signHumanMergeWebhook,
  type FixtureGitHubEvent,
  type KeeploreButtonTrialScenario,
} from "@voice-agent/scenario";
import type {
  KeeploreDelegationBrief,
  KeeploreDelegationRecord,
  KeeploreDelegationResult,
  KeeploreProductionAppearanceObservation,
  KeeplorePromotionAttemptRecord,
  KeeploreRegistration,
  KeeploreWorktree,
} from "@voice-agent/contracts";
import { keeploreProductionEvidenceRoot } from "@voice-agent/contracts";
import {
  chooseKeeploreTrialCompletionNotice,
  decideKeeploreWorktreeLifecycle,
  evaluateKeeploreProductionAppearance,
} from "@voice-agent/policy";
import { projectKeeploreButtonTrialEvidenceRecord } from "@voice-agent/runtime";

const temporaryDirectories: string[] = [];
const now = "2026-08-25T14:00:00.000Z";
const sourceCommit = "1111111111111111111111111111111111111111";
const resultCommit = "2222222222222222222222222222222222222222";
const mergeCommit = "3333333333333333333333333333333333333333";
const previousCommit = "4444444444444444444444444444444444444444";
const webhookSecret = "keeplore-trial-webhook-secret";
const evidenceRecordUrl =
  "https://voice.stephens.page/?task=task-button-trial";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a Human Merge that production verifies concludes the trial in one Evidence Record", async () => {
  const delegation = await deliveredDelegation();
  const appearance = productionAppearance();

  const record = projectKeeploreButtonTrialEvidenceRecord({
    appearance,
    attempts: [promotedAttempt()],
    delegation,
    mergeCommit,
    notice: chooseKeeploreTrialCompletionNotice({
      callback: { outcome: "authorized" },
      evidenceRecordUrl,
    }),
    worktree: {
      ...decideKeeploreWorktreeLifecycle({
        pullRequestState: "merged",
        result: requireResult(delegation),
      }),
      observedAt: "2026-08-25T15:10:00.000Z",
    },
  });

  expect(record.task).toEqual({
    conclusion: "Keeplore Button Trial is complete and verified in production.",
    createdAt: now,
    id: "task-button-trial",
    kind: "keeplore.button-trial",
    status: "completed",
    updatedAt: "2026-08-25T15:10:00.000Z",
  });
  // Everything the owner needs to follow the trial hangs off this one record.
  expect(record.trial.request.requestId).toBe(
    "telephone:turn-conclusion-confirm",
  );
  expect(record.trial.delegation).toMatchObject({
    branch: "codex/keeplore-button-delegation-button-trial",
    changedFiles: ["ui/style.css"],
    commits: [resultCommit],
    pullRequestUrl: "https://github.com/JacobStephens2/keeplore/pull/101",
    status: "completed",
  });
  expect(record.trial.merge).toEqual({
    actor: "JacobStephens2",
    branch: "main",
    commit: mergeCommit,
    mergedAt: "2026-08-25T15:00:00.000Z",
    repository: "JacobStephens2/keeplore",
    source: "webhook",
  });
  expect(record.trial.release).toEqual({
    commit: mergeCommit,
    id: `keeplore-production-${mergeCommit}`,
    path: `/opt/keeplore/releases/${mergeCommit}`,
  });
  expect(record.trial.verification.appearance).toEqual({
    failures: [],
    outcome: "passed",
  });
  expect(record.trial.verification.health).toEqual({
    actualStatus: 200,
    expectedStatus: 200,
    outcome: "healthy",
  });
  expect(record.trial.rollback).toEqual({ performed: false });
  expect(record.trial.notice).toEqual({
    evidenceRecordUrl,
    kind: "completion-callback",
    outcome: "authorized",
  });
  expect(record.trial.promotion).toEqual({
    checks: [{ conclusion: "success", name: "keeplore-verification" }],
    contractRevision: 2,
  });
  expect(record.evidence.map((event) => event.kind)).toEqual([
    "request.confirmed",
    "delegation.published",
    "merge.accepted",
    "checks.recorded",
    "release.built",
    "release.verified",
    "worktree.removed",
    "notice.delivered",
    "trial.concluded",
  ]);
  expect(record.evidence.map((event) => event.sequence)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
});

test("production that serves an unchanged stylesheet fails verification despite healthy status", () => {
  const observation = productionAppearance();
  const desktop = observation.computedStyles[0];
  if (desktop === undefined) throw new Error("desktop styles are required");

  const verdict = evaluateKeeploreProductionAppearance({
    ...observation,
    computedStyles: [
      {
        ...desktop,
        getRidOf: { ...desktop.getRidOf, height: "24px", paddingTop: "2px" },
      },
      ...observation.computedStyles.slice(1),
    ],
  });

  expect(verdict).toEqual({
    failures: [
      "desktop Keeplore table controls differ in height, paddingTop",
    ],
    outcome: "failed",
  });
});

test("a failed production appearance rolls back and never reads as complete", async () => {
  const delegation = await deliveredDelegation();
  const observation = productionAppearance();
  const failing: KeeploreProductionAppearanceObservation = {
    ...observation,
    cardView: {
      afterHash: "card-view-regressed",
      beforeHash: "card-view-baseline",
      unchanged: false,
    },
  };

  const record = projectKeeploreButtonTrialEvidenceRecord({
    appearance: failing,
    attempts: [rolledBackAttempt()],
    delegation,
    mergeCommit,
    notice: chooseKeeploreTrialCompletionNotice({
      callback: { outcome: "unanswered" },
      evidenceRecordUrl,
    }),
  });

  expect(record.task.conclusion).toBe(
    "Keeplore Button Trial was promoted and rolled back; production is unchanged.",
  );
  expect(record.task.status).toBe("failed");
  expect(record.trial.rollback).toEqual({
    attemptedReleaseCommit: mergeCommit,
    performed: true,
    restoredReleaseCommit: previousCommit,
  });
  expect(record.trial.verification.appearance).toEqual({
    failures: ["Card view regressed against the retained Release"],
    outcome: "failed",
  });
  // An unanswered call is reported as the generic email, not as a callback.
  expect(record.trial.notice).toEqual({
    evidenceRecordUrl,
    kind: "silent-notification",
    reason: "callback-unanswered",
  });
  expect(record.evidence.map((event) => event.kind)).toContain(
    "release.rolled-back",
  );
});

test("a preflight failure is not reported as a rollback", async () => {
  const delegation = await deliveredDelegation();

  // The host writes `restored: ""` on every failed attempt, including ones that
  // failed before anything switched. Production was never touched here.
  const record = projectKeeploreButtonTrialEvidenceRecord({
    attempts: [
      {
        ...promotedAttempt(),
        restored: "",
        result: "failed",
        stage: "preflight",
        verification: undefined,
      },
    ],
    delegation,
    mergeCommit,
  });

  expect(record.trial.rollback).toEqual({ performed: false });
  expect(record.task).toMatchObject({
    conclusion: "Keeplore Button Trial has not been promoted.",
    status: "pending",
  });
  expect(record.evidence.map((event) => event.kind)).not.toContain(
    "release.rolled-back",
  );
});

test("a fixed-width production control is named rather than swallowed", () => {
  const observation = productionAppearance();
  const desktop = observation.computedStyles[0];
  if (desktop === undefined) throw new Error("desktop styles are required");

  const verdict = evaluateKeeploreProductionAppearance({
    ...observation,
    computedStyles: [
      { ...desktop, getRidOf: { ...desktop.getRidOf, widthMode: "fixed" } },
      ...observation.computedStyles.slice(1),
    ],
  });

  expect(verdict).toEqual({
    failures: ["Production desktop table controls do not retain content widths"],
    outcome: "failed",
  });
});

test("a re-promotion verifies the original Human Merge rather than recording a second merge", async () => {
  const delegation = await deliveredDelegation();

  // The merge was promoted before appearance verification existed, so its own
  // Promotion produced no verdict. The re-promotion steps production back to
  // the retained Release and promotes the same merge commit again.
  const record = projectKeeploreButtonTrialEvidenceRecord({
    appearance: productionAppearance(),
    attempts: [
      unverifiedPromotedAttempt(),
      steppedBackAttempt(),
      repromotedAttempt(),
    ],
    delegation,
    mergeCommit,
  });

  expect(record.task).toMatchObject({
    conclusion: "Keeplore Button Trial is complete and verified in production.",
    status: "completed",
  });
  // One merge, at the time the human actually merged, from the original
  // Promotion rather than from the attended re-promotion that verified it.
  expect(record.trial.merge).toMatchObject({
    commit: mergeCommit,
    mergedAt: "2026-08-25T15:00:00.000Z",
    source: "webhook",
  });
  expect(
    record.evidence.filter((event) => event.kind === "merge.accepted"),
  ).toHaveLength(1);
  // The Release the record names is the merge's, never the one production
  // served for the bounded window in between.
  expect(record.trial.release).toEqual({
    commit: mergeCommit,
    id: `keeplore-production-${mergeCommit}`,
    path: `/opt/keeplore/releases/${mergeCommit}`,
  });
  expect(record.trial.rollback).toEqual({ performed: false });
  const steppedBack = record.evidence.find(
    (event) => event.kind === "release.stepped-back",
  );
  expect(steppedBack?.details).toMatchObject({
    mergeCommit,
    retainedReleaseCommit: previousCommit,
  });
});

test("a re-promotion whose candidate fails restores the merge commit and stays incomplete", async () => {
  const delegation = await deliveredDelegation();

  const record = projectKeeploreButtonTrialEvidenceRecord({
    appearance: {
      ...productionAppearance(),
      cardView: {
        afterHash: "card-view-regressed",
        beforeHash: "card-view-baseline",
        unchanged: false,
      },
    },
    attempts: [
      unverifiedPromotedAttempt(),
      steppedBackAttempt(),
      {
        ...repromotedAttempt(),
        restored: previousCommit,
        result: "failed",
        stage: "appearance-verification",
        verification: {
          actualStatus: 200,
          appearance: {
            failures: ["Card view regressed against the retained Release"],
            outcome: "failed",
          },
          expectedStatus: 200,
        },
      },
      restoredAttempt(),
    ],
    delegation,
    mergeCommit,
  });

  // The restore switched production back to the merge commit and succeeded at
  // the promotion stage; that must never read as the merge having been
  // verified.
  expect(record.task).toMatchObject({
    conclusion:
      "Keeplore Button Trial was promoted and rolled back; production is unchanged.",
    status: "failed",
  });
  expect(record.trial.rollback).toEqual({
    attemptedReleaseCommit: mergeCommit,
    performed: true,
    restoredReleaseCommit: previousCommit,
  });
  expect(record.evidence.map((event) => event.kind)).toContain(
    "release.restored",
  );
  const restored = record.evidence.find(
    (event) => event.kind === "release.restored",
  );
  expect(restored?.details).toMatchObject({ restoredReleaseCommit: mergeCommit });
});

test("an unpromoted merge is pending rather than complete", async () => {
  const delegation = await deliveredDelegation();

  const record = projectKeeploreButtonTrialEvidenceRecord({
    attempts: [],
    delegation,
  });

  expect(record.task).toMatchObject({
    conclusion: "Keeplore Button Trial has not been promoted.",
    status: "pending",
  });
  expect(record.trial.release).toBeUndefined();
  expect(record.trial.verification.appearance).toBeUndefined();
});

test("the Delegated Worktree survives review and is removed only once clean and merged", async () => {
  const delegation = await deliveredDelegation();
  const result = requireResult(delegation);

  expect(decideKeeploreWorktreeLifecycle({ pullRequestState: "open", result })).toEqual({
    decision: "retain",
    reason: "The Delegated Worktree's pull request is still open",
  });
  expect(decideKeeploreWorktreeLifecycle({ pullRequestState: "merged", result })).toEqual({
    decision: "remove",
    reason: "The pull request is merged and the completed worktree is clean",
  });
  expect(
    decideKeeploreWorktreeLifecycle({
      pullRequestState: "closed",
      result: {
        ...result,
        worktree: { ...result.worktree, dirty: true },
      },
    }),
  ).toEqual({
    decision: "retain",
    reason: "The Delegated Worktree is dirty and is never removed automatically",
  });
  expect(
    decideKeeploreWorktreeLifecycle({
      pullRequestState: "closed",
      result: {
        ...result,
        cleanup: { eligible: false, quarantineReason: "Publication was refused" },
      },
    }),
  ).toEqual({ decision: "retain", reason: "Publication was refused" });
});

test("the Subagent's own branch, pull request, and merge attempt reach no Promotion", async () => {
  const scenario = await createKeeplorePromotionScenario([
    "task-branch-push",
    "task-pull-request-opened",
    "task-bot-merge",
    "task-human-merge",
    "attempt-human-merge",
  ]);
  const branch = "codex/keeplore-button-delegation-button-trial";

  // The Administrative Publisher App pushes the assigned branch and opens the
  // pull request. Neither is a Human Merge, and the App cannot merge at all.
  const branchPush = await deliver(scenario, "delivery-branch-push", {
    ...keeploreHumanMerge(),
    branch,
    event: "push",
    merged: false,
    mergedBy: null,
  });
  const pullRequestOpened = await deliver(scenario, "delivery-pull-request", {
    ...keeploreHumanMerge(),
    action: "opened",
    merged: false,
    mergedBy: null,
  });
  const botMerge = await deliver(scenario, "delivery-bot-merge", {
    ...keeploreHumanMerge(),
    mergedBy: { login: "keeplore-publisher[bot]", type: "Bot" },
  });

  expect(
    [branchPush, pullRequestOpened, botMerge].map((result) => [
      result.outcome,
      result.record.promotion.denialReason,
    ]),
  ).toEqual([
    ["denied", "direct-push"],
    ["denied", "non-human-merge"],
    ["denied", "non-human-merge"],
  ]);
  expect((await scenario.inspect()).attempts).toEqual([]);

  // Only the owner's own merge enqueues one attempt, for that exact commit.
  const humanMerge = await deliver(scenario, "delivery-human-merge", keeploreHumanMerge());
  expect(humanMerge.outcome).toBe("accepted");
  expect(humanMerge.record.promotion.attempt).toMatchObject({
    mergeCommit,
    status: "queued",
  });
  expect(humanMerge.record.promotion.contract).toMatchObject({ revision: 1 });

  await scenario.close();
});

test("a duplicate webhook and a reconciliation of the same merge deploy once", async () => {
  const scenario = await createKeeplorePromotionScenario([
    "task-human-merge",
    "attempt-human-merge",
    "task-duplicate",
    "task-reconciliation",
  ]);
  const accepted = await deliver(scenario, "delivery-human-merge", keeploreHumanMerge());
  const duplicate = await deliver(scenario, "delivery-human-merge", keeploreHumanMerge());
  const reconciled = await scenario.reconcile([keeploreHumanMerge()]);

  expect(accepted.outcome).toBe("accepted");
  expect(duplicate.outcome).toBe("duplicate");
  expect(reconciled).toEqual([]);
  expect((await scenario.inspect()).attempts).toEqual([
    expect.objectContaining({ id: "attempt-human-merge", status: "queued" }),
  ]);

  await scenario.close();
});

async function createKeeplorePromotionScenario(ids: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-trial-promotion-"));
  temporaryDirectories.push(directory);
  return createHumanMergePromotionScenario({
    codebase: {
      applicationId: "keeplore-production",
      buildCommand: "composer install --no-dev",
      health: { expectedStatus: 200, path: "/health.php" },
      initialProductionCommit: previousCommit,
      liveCheckoutPath: "/var/www/keeplore.app",
      preflightCommand: "vendor/bin/phpunit",
      productionBranch: "main",
      releaseRoot: "/opt/keeplore/releases",
      repository: "JacobStephens2/keeplore",
      sourceCheckoutRoot: "/var/lib/keeplore-source",
    },
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: [...ids],
    now,
    webhookSecret,
  });
}

function deliver(
  scenario: Awaited<ReturnType<typeof createHumanMergePromotionScenario>>,
  deliveryId: string,
  event: FixtureGitHubEvent,
) {
  return scenario.deliver({
    deliveryId,
    event,
    signature: signHumanMergeWebhook(webhookSecret, event),
  });
}

function keeploreHumanMerge(): FixtureGitHubEvent {
  return {
    action: "closed",
    beforeCommit: previousCommit,
    branch: "main",
    commit: mergeCommit,
    event: "pull_request",
    merged: true,
    mergedAt: "2026-08-25T15:00:00.000Z",
    mergedBy: { login: "JacobStephens2", type: "User" },
    repository: "JacobStephens2/keeplore",
  };
}

async function deliveredDelegation(): Promise<KeeploreDelegationRecord> {
  const scenario = await createScenario();
  await scenario.authenticateTelephoneSession("telephone-session-conclusion");
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-conclusion",
    transcript: "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-conclusion-request",
  });
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-conclusion",
    transcript: "Yes",
    turnId: "turn-conclusion-confirm",
  });
  const record = await scenario.processNextDelegation();
  await scenario.close();
  if (record === undefined) throw new Error("The trial produced no Delegation");
  return record;
}

function requireResult(record: KeeploreDelegationRecord): KeeploreDelegationResult {
  const { result } = record.delegation;
  if (result === undefined) throw new Error("The Delegation produced no result");
  return result;
}

async function createScenario(): Promise<KeeploreButtonTrialScenario> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-trial-promotion-"));
  temporaryDirectories.push(directory);
  return createKeeploreButtonTrialScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: ["task-button-trial", "delegation-button-trial"],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute({ brief, worktree }) {
        return successfulResult(brief, worktree);
      },
    },
    sourceCommit,
  });
}

function promotedAttempt(): KeeplorePromotionAttemptRecord {
  return {
    application: "keeplore-production",
    attemptedAt: "2026-08-25T15:05:00.000Z",
    checks: [{ conclusion: "success", name: "keeplore-verification" }],
    commit: mergeCommit,
    contractRevision: 2,
    merge: {
      actor: "JacobStephens2",
      mergedAt: "2026-08-25T15:00:00.000Z",
      source: "webhook",
    },
    previous: previousCommit,
    release: {
      id: `keeplore-production-${mergeCommit}`,
      path: `/opt/keeplore/releases/${mergeCommit}`,
    },
    restored: "",
    result: "succeeded",
    stage: "promotion",
    verification: {
      actualStatus: 200,
      appearance: { failures: [], outcome: "passed" },
      expectedStatus: 200,
    },
  };
}

/**
 * The trial's own merge as it was actually promoted: before appearance
 * verification existed, so health passed and no verdict was ever produced.
 */
function unverifiedPromotedAttempt(): KeeplorePromotionAttemptRecord {
  return {
    ...promotedAttempt(),
    contractRevision: 1,
    verification: { actualStatus: 200, expectedStatus: 200 },
  };
}

function steppedBackAttempt(): KeeplorePromotionAttemptRecord {
  return {
    application: "keeplore-production",
    attemptedAt: "2026-08-25T16:00:00.000Z",
    commit: previousCommit,
    contractRevision: 2,
    previous: mergeCommit,
    release: {
      id: `keeplore-production-${previousCommit}`,
      path: `/opt/keeplore/releases/${previousCommit}`,
    },
    repromotion: { kind: "step-back", mergeCommit },
    restored: "",
    result: "succeeded",
    stage: "promotion",
    verification: { actualStatus: 200, expectedStatus: 200 },
  };
}

function repromotedAttempt(): KeeplorePromotionAttemptRecord {
  return {
    ...promotedAttempt(),
    attemptedAt: "2026-08-25T16:04:00.000Z",
    merge: {
      actor: "JacobStephens2",
      mergedAt: "2026-08-25T15:00:00.000Z",
      source: "attended",
    },
    repromotion: { kind: "candidate", mergeCommit },
  };
}

function restoredAttempt(): KeeplorePromotionAttemptRecord {
  return {
    ...promotedAttempt(),
    attemptedAt: "2026-08-25T16:09:00.000Z",
    merge: undefined,
    previous: previousCommit,
    repromotion: { kind: "restore", mergeCommit },
    verification: { actualStatus: 200, expectedStatus: 200 },
  };
}

function rolledBackAttempt(): KeeplorePromotionAttemptRecord {
  return {
    ...promotedAttempt(),
    restored: previousCommit,
    result: "failed",
    stage: "appearance-verification",
    verification: {
      actualStatus: 200,
      appearance: {
        failures: ["Card view regressed against the retained Release"],
        outcome: "failed",
      },
      expectedStatus: 200,
    },
  };
}

function productionAppearance(): KeeploreProductionAppearanceObservation {
  const matchedStyle = {
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderRadius: "8px",
    borderRightWidth: "0px",
    borderTopWidth: "0px",
    boxShadow: "rgba(80, 95, 118, 0.3) 0px 0px 0px 1px inset",
    color: "rgb(80, 95, 118)",
    fontFamily: "Inter, sans-serif",
    fontSize: "13.12px",
    fontWeight: "600",
    height: "32px",
    letterSpacing: "normal",
    lineHeight: "19.68px",
    paddingBottom: "5.6px",
    paddingTop: "5.6px",
    textTransform: "none",
    widthMode: "content" as const,
  };
  return {
    cardView: {
      afterHash: "card-view-baseline",
      beforeHash: "card-view-baseline",
      unchanged: true,
    },
    computedStyles: [
      {
        getRidOf: { ...matchedStyle, width: "91.2344px" },
        remove: { ...matchedStyle, width: "70.5469px" },
        viewport: "desktop",
      },
      {
        getRidOf: { ...matchedStyle, width: "91.2344px" },
        remove: { ...matchedStyle, width: "70.5469px" },
        viewport: "mobile",
      },
    ],
    health: { actualStatus: 200, expectedStatus: 200 },
    observedAt: "2026-08-25T15:06:00.000Z",
    releaseCommit: mergeCommit,
    screenshots: [
      {
        authenticated: true,
        path: `${keeploreProductionEvidenceRoot}${mergeCommit}/desktop-table.png`,
        viewport: { height: 900, name: "desktop", width: 1440 },
      },
      {
        authenticated: true,
        path: `${keeploreProductionEvidenceRoot}${mergeCommit}/mobile-table.png`,
        viewport: { height: 844, name: "mobile", width: 390 },
      },
    ],
  };
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
    readScope: ["**/*.php", "**/*.js", "**/*.css", "!**/environment_variables.php"],
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

function successfulResult(
  brief: KeeploreDelegationBrief,
  worktree: KeeploreWorktree,
): KeeploreDelegationResult {
  const appearance = productionAppearance();
  return {
    branch: worktree.branch,
    changedFiles: ["ui/style.css"],
    cleanup: { eligible: false, quarantineReason: null },
    commits: [resultCommit],
    completedAt: "2026-08-25T14:30:00.000Z",
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
    failure: null,
    pullRequest: {
      state: "open",
      url: "https://github.com/JacobStephens2/keeplore/pull/101",
    },
    risks: [],
    status: "completed",
    verification: {
      automated: [
        {
          command: "vendor/bin/phpunit",
          outcome: "passed",
          summary: "Keeplore verification passed.",
        },
      ],
      cardView: appearance.cardView,
      computedStyles: appearance.computedStyles,
      screenshots: [
        {
          authenticated: true,
          path: `/var/lib/voice-agent-evidence/${brief.delegationId}/desktop-table.png`,
          viewport: { height: 900, name: "desktop", width: 1440 },
        },
        {
          authenticated: true,
          path: `/var/lib/voice-agent-evidence/${brief.delegationId}/mobile-table.png`,
          viewport: { height: 844, name: "mobile", width: 390 },
        },
      ],
    },
    worktree: { ...worktree, dirty: false, state: "completed" },
  };
}
