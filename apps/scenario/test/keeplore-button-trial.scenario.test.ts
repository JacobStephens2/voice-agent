import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import {
  createKeeploreButtonTrialScenario,
  type KeeploreButtonTrialScenario,
} from "@voice-agent/scenario";
import {
  registeredCodebaseIdSchema,
  type KeeploreDelegationBrief,
  type KeeploreDelegationFailure,
  type KeeploreDelegationResult,
  type KeeploreRegistration,
  type KeeploreWorktree,
} from "@voice-agent/contracts";
import { createSqliteKeeploreDelegationStore } from "@voice-agent/sqlite-store";

const temporaryDirectories: string[] = [];
const now = "2026-08-22T14:00:00.000Z";
const sourceCommit = "1111111111111111111111111111111111111111";
const resultCommit = "2222222222222222222222222222222222222222";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test.each([
  [
    "split words",
    "Get rid of button match remove. And keep lore's table view.",
  ],
  [
    "phonetic substitution",
    "Next to get rid of button match remove in KeepLoors table view.",
  ],
  [
    "truncated target and scope",
    "Make of the Get Rid of button match the remove. make of the get rid of button match the remove.",
  ],
])("a Keeplore STT %s still receives the Keeplore confirmation", async (
  _variant,
  transcript,
) => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return successfulResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-stt");

  const requested = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-stt",
    transcript,
    turnId: "turn-stt-request",
  });

  expect(requested.actions).toEqual([
    {
      confirmationId: "turn-stt-request:confirmation",
      interruptible: true,
      kind: "request-task-confirmation",
      text:
        "Please confirm this state-changing task: Keeplore production — make table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight, while retaining content-based widths and leaving card view unchanged.",
    },
  ]);

  const confirmed = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-stt",
    transcript: "Yes.",
    turnId: "turn-stt-confirm",
  });

  expect(confirmed.actions).toEqual([
    {
      interruptible: true,
      kind: "offer-completion-callback",
      responseId: "turn-stt-confirm:delegation-response",
      taskId: "task-button-trial",
      text:
        "The Keeplore Button Trial is confirmed and delegated to restricted Codex on a non-production branch. Nothing will be merged or deployed. I can disconnect and call your registered telephone when it finishes. Would you like that?",
    },
  ]);
  expect(await scenario.listDelegations()).toHaveLength(1);
});

test.each([
  ["duplicated yes", "Yes. yes"],
  ["correctness statement", "That is correct."],
  ["confirmation statement", "I confirm."],
  ["dashed confirmation", "I confirm - Yes"],
  ["em-dashed confirmation", "I confirm—yes"],
  ["reordered confirmation", "yes, I confirm"],
  ["contracted correctness statement", "That's correct."],
  ["repeated affirmative fragments", "Yeah. Yes. Yes, please."],
  ["filled affirmative", "Well, okay — go ahead."],
])("an observed STT %s confirms the pending Keeplore task", async (
  _variant,
  transcript,
) => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return successfulResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-confirmation");
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-confirmation",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-confirmation-request",
  });

  const confirmed = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-confirmation",
    transcript,
    turnId: "turn-confirmation-response",
  });

  expect(confirmed.actions).toEqual([
    {
      interruptible: true,
      kind: "offer-completion-callback",
      responseId: "turn-confirmation-response:delegation-response",
      taskId: "task-button-trial",
      text:
        "The Keeplore Button Trial is confirmed and delegated to restricted Codex on a non-production branch. Nothing will be merged or deployed. I can disconnect and call your registered telephone when it finishes. Would you like that?",
    },
  ]);
  expect(await scenario.listDelegations()).toHaveLength(1);
});

test.each([
  "Yes, but only if you also change card view.",
  "I do not confirm.",
  "Yes — no, do not do that.",
  "That is not correct.",
  "Correct, unless it touches card view.",
])("qualified or negative speech does not confirm the Keeplore task", async (
  transcript,
) => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return successfulResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-rejected");
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-rejected",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-rejected-request",
  });

  const rejected = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-rejected",
    transcript,
    turnId: "turn-rejected-response",
  });

  expect(rejected.actions).toEqual([
    {
      interruptible: true,
      kind: "speak-guidance",
      responseId: "turn-rejected-response:guidance",
      text: "Okay. I did not confirm that state-changing task.",
    },
  ]);
  expect(await scenario.listDelegations()).toEqual([]);
});

test("unrecognized speech leaves the same Task Confirmation pending", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return successfulResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-ambiguous");
  const requested = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-ambiguous",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-ambiguous-request",
  });
  expect(requested.actions).toMatchObject([
    { kind: "request-task-confirmation" },
  ]);

  const unclear = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-ambiguous",
    transcript: "Sorry, the line broke up there.",
    turnId: "turn-ambiguous-unclear",
  });
  expect(unclear.actions).toEqual([
    {
      interruptible: true,
      kind: "speak-guidance",
      responseId: "turn-ambiguous-unclear:guidance",
      text:
        "I did not catch that. The same Task Confirmation is still pending. Please say yes to confirm it or no to decline it.",
    },
  ]);
  expect(await scenario.listDelegations()).toEqual([]);

  const confirmed = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-ambiguous",
    transcript: "I confirm—yes",
    turnId: "turn-ambiguous-confirm",
  });
  expect(confirmed.actions).toEqual([
    {
      interruptible: true,
      kind: "offer-completion-callback",
      responseId: "turn-ambiguous-confirm:delegation-response",
      taskId: "task-button-trial",
      text:
        "The Keeplore Button Trial is confirmed and delegated to restricted Codex on a non-production branch. Nothing will be merged or deployed. I can disconnect and call your registered telephone when it finishes. Would you like that?",
    },
  ]);
  expect(await scenario.listDelegations()).toHaveLength(1);
});

test("a redelivered confirmation turn cannot create a second Delegation", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return successfulResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-duplicate");
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-duplicate",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-duplicate-request",
  });
  const confirmed = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-duplicate",
    transcript: "Yes, I confirm.",
    turnId: "turn-duplicate-confirm",
  });
  expect(confirmed.actions).toMatchObject([
    { kind: "offer-completion-callback" },
  ]);

  const redelivered = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-duplicate",
    transcript: "Yes, I confirm.",
    turnId: "turn-duplicate-confirm",
  });

  expect(redelivered.actions).toEqual([]);
  expect(await scenario.listDelegations()).toHaveLength(1);
  const record = await scenario.getDelegation("task-button-trial");
  expect(record?.delegation.brief.durableTask.requestId).toBe(
    "telephone:turn-duplicate-confirm",
  );
});

test.each([
  "Make the Get Rid Of button larger.",
  "Make the Remove button larger.",
])("one trial control alone cannot create a Keeplore Delegation", async (
  transcript,
) => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return successfulResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-incomplete");

  const requested = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-incomplete",
    transcript,
    turnId: "turn-incomplete-request",
  });
  expect(requested.actions).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining("Keeplore production"),
      }),
    ]),
  );

  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-incomplete",
    transcript: "Yes.",
    turnId: "turn-incomplete-confirm",
  });
  expect(await scenario.listDelegations()).toEqual([]);
});

test("an authenticated confirmed Keeplore Button Trial produces a bounded verified pull request", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return successfulResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-1");

  const requested = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-1",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-request",
  });

  expect(requested.actions).toEqual([
    {
      confirmationId: "turn-request:confirmation",
      interruptible: true,
      kind: "request-task-confirmation",
      text:
        "Please confirm this state-changing task: Keeplore production — make table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight, while retaining content-based widths and leaving card view unchanged.",
    },
  ]);
  expect(await scenario.listDelegations()).toEqual([]);

  const confirmed = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-1",
    transcript: "Yes.",
    turnId: "turn-confirm",
  });

  expect(confirmed.actions).toEqual([
    {
      interruptible: true,
      kind: "offer-completion-callback",
      responseId: "turn-confirm:delegation-response",
      taskId: "task-button-trial",
      text:
        "The Keeplore Button Trial is confirmed and delegated to restricted Codex on a non-production branch. Nothing will be merged or deployed. I can disconnect and call your registered telephone when it finishes. Would you like that?",
    },
  ]);

  const accepted = await scenario.getDelegation("task-button-trial");
  expect(accepted?.task).toMatchObject({
    conclusion: "Keeplore Button Trial is delegated.",
    id: "task-button-trial",
    kind: "keeplore.button-trial",
    status: "pending",
  });
  expect(accepted?.delegation.brief).toMatchObject({
    acceptanceCriteria: [
      "Table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight at both the desktop and mobile verification viewports.",
      "Both table-view controls retain content-based widths.",
      "Card view is visually unchanged.",
      "Declared automated verification and authenticated desktop and mobile visual verification pass.",
      "Only a non-production branch is pushed and a pull request is opened without merging or deploying.",
    ],
    boundedContext: {
      editablePaths: ["ui/style.css"],
      referencePaths: ["ui/artifacts/useby.php", "ui/artifacts/useby.js"],
      repositoryContentTrust: "untrusted-data-only",
    },
    capabilities: [
      "registered-source.read",
      "delegated-worktree.write",
      "verification.run",
      "authenticated-browser.verify",
      "verified-candidate.publish",
    ],
    delegationId: "delegation-button-trial",
    durableTask: {
      id: "task-button-trial",
      kind: "keeplore.button-trial",
    },
    goal:
      "Make Keeplore's table-view Get Rid Of control match the row-level Remove control without changing card view.",
    registeredCodebase: {
      registeredCodebaseId: registeredCodebaseIdSchema.parse(
        "keeplore-production",
      ),
      productionBranch: "main",
      provider: "codex",
      repository: "JacobStephens2/keeplore",
      revision: 1,
      sourceCommit,
      verificationCommand: "vendor/bin/phpunit",
    },
  });
  expect(accepted?.delegation.brief).not.toHaveProperty("rawTelephoneTranscript");

  const completed = await scenario.processNextDelegation();

  expect(completed?.task).toMatchObject({
    conclusion: "Keeplore Button Trial pull request is ready for Human Merge.",
    status: "completed",
  });
  expect(completed?.delegation.result).toMatchObject({
    branch: "codex/keeplore-button-delegation-button-trial",
    changedFiles: ["ui/style.css"],
    cleanup: { eligible: false, quarantineReason: null },
    commits: [resultCommit],
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
      cardView: {
        afterHash: "card-view-baseline",
        beforeHash: "card-view-baseline",
        unchanged: true,
      },
      screenshots: [
        {
          authenticated: true,
          path: "/var/lib/voice-agent-evidence/delegation-button-trial/desktop-table.png",
          viewport: { height: 900, name: "desktop", width: 1440 },
        },
        {
          authenticated: true,
          path: "/var/lib/voice-agent-evidence/delegation-button-trial/mobile-table.png",
          viewport: { height: 844, name: "mobile", width: 390 },
        },
      ],
    },
    worktree: {
      baseCommit: sourceCommit,
      dirty: false,
      path:
        "/var/lib/voice-agent-worktrees/keeplore/delegation-button-trial",
      state: "completed",
    },
  });

  const reported = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-1",
    transcript: "What is the status of the Keeplore Button Trial?",
    turnId: "turn-status",
  });
  expect(reported.actions).toEqual([
    {
      interruptible: true,
      kind: "speak-semantic-response",
      responseId: "turn-status:keeplore-status-response",
      taskId: "task-button-trial",
      text:
        "The Keeplore Button Trial is complete on branch codex/keeplore-button-delegation-button-trial with 1 commit. Its verified pull request is https://github.com/JacobStephens2/keeplore/pull/101. It has not been merged or deployed.",
    },
  ]);
});

test("a running Delegation resumes after worker restart with append-only evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-button-resume-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const acceptedScenario = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: ["task-button-trial", "delegation-button-trial"],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute() {
        throw new Error("The pre-restart runner must not execute");
      },
    },
    sourceCommit,
  });
  await confirmTrial(acceptedScenario, "restart");
  await acceptedScenario.close();

  const legacyDatabase = new Database(databasePath);
  const stored = legacyDatabase
    .prepare(
      "SELECT brief_json FROM keeplore_delegations WHERE task_id = ?",
    )
    .get("task-button-trial") as { readonly brief_json: string };
  const legacyBrief = JSON.parse(stored.brief_json) as {
    readonly registeredCodebase: Readonly<Record<string, unknown>>;
  };
  const {
    registeredCodebaseId,
    ...legacyRegisteredCodebase
  } = legacyBrief.registeredCodebase;
  legacyDatabase
    .prepare(
      "UPDATE keeplore_delegations SET brief_json = ? WHERE task_id = ?",
    )
    .run(
      JSON.stringify({
        ...legacyBrief,
        registeredCodebase: {
          ...legacyRegisteredCodebase,
          applicationId: registeredCodebaseId,
        },
      }),
      "task-button-trial",
    );
  legacyDatabase.close();

  const claimingStore = createSqliteKeeploreDelegationStore(databasePath);
  const claimed = await claimingStore.claimNext({ claimedAt: now });
  expect(claimed?.worktree.state).toBe("running");
  expect(claimed?.brief.registeredCodebase).toMatchObject({
    registeredCodebaseId: "keeplore-production",
  });
  expect(claimed?.brief.registeredCodebase).not.toHaveProperty(
    "applicationId",
  );
  claimingStore.close();

  const resumedScenario = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: [],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute({ brief, worktree }) {
        return successfulResult(brief, worktree);
      },
    },
    sourceCommit,
  });
  const completed = await resumedScenario.processNextDelegation();
  expect(completed?.task.status).toBe("completed");
  await resumedScenario.close();

  const database = new Database(databasePath, { readonly: true });
  const events = database
    .prepare(`
      SELECT kind FROM keeplore_delegation_events
      WHERE task_id = ? ORDER BY rowid
    `)
    .all("task-button-trial") as Array<{ readonly kind: string }>;
  database.close();
  expect(events.map((event) => event.kind)).toEqual([
    "accepted",
    "claimed",
    "resumed",
    "completed",
  ]);
});

test("work accepted by natural confirmation survives call loss and stays visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-button-call-loss-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const lostCall = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: ["task-button-trial", "delegation-button-trial"],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute() {
        throw new Error("The lost call must not execute the Delegation");
      },
    },
    sourceCommit,
  });
  await lostCall.authenticateTelephoneSession("telephone-session-lost");
  await lostCall.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-lost",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-lost-request",
  });
  const confirmed = await lostCall.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-lost",
    transcript: "I confirm—yes",
    turnId: "turn-lost-confirm",
  });
  expect(confirmed.actions).toMatchObject([
    { kind: "offer-completion-callback", taskId: "task-button-trial" },
  ]);
  // The call drops before the Subagent runs at all.
  await lostCall.close();

  const recovered = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: [],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute({ brief, worktree }) {
        return successfulResult(brief, worktree);
      },
    },
    sourceCommit,
  });
  const completed = await recovered.processNextDelegation();
  expect(completed?.task).toMatchObject({
    conclusion: "Keeplore Button Trial pull request is ready for Human Merge.",
    id: "task-button-trial",
    status: "completed",
  });
  expect(completed?.delegation.brief.durableTask.requestId).toBe(
    "telephone:turn-lost-confirm",
  );
  expect(JSON.stringify(completed?.delegation.brief)).not.toContain(
    "I confirm",
  );
  expect(JSON.stringify(completed?.delegation.brief)).not.toContain(
    "Get Rid Of button match Remove",
  );

  await recovered.authenticateTelephoneSession("telephone-session-recovered");
  const reported = await recovered.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-recovered",
    transcript: "What is the status of the Keeplore Button Trial?",
    turnId: "turn-recovered-status",
  });
  expect(reported.actions).toEqual([
    {
      interruptible: true,
      kind: "speak-semantic-response",
      responseId: "turn-recovered-status:keeplore-status-response",
      taskId: "task-button-trial",
      text:
        "The Keeplore Button Trial is complete on branch codex/keeplore-button-delegation-button-trial with 1 commit. Its verified pull request is https://github.com/JacobStephens2/keeplore/pull/101. It has not been merged or deployed.",
    },
  ]);
  await recovered.close();

  const database = new Database(databasePath, { readonly: true });
  const events = database
    .prepare(`
      SELECT kind FROM keeplore_delegation_events
      WHERE task_id = ? ORDER BY rowid
    `)
    .all("task-button-trial") as Array<{ readonly kind: string }>;
  database.close();
  expect(events.map((event) => event.kind)).toEqual([
    "accepted",
    "claimed",
    "completed",
  ]);
});

test("a later authenticated Telephone Session can stop the durable Delegation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-button-reconnect-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const originatingScenario = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: ["task-button-trial", "delegation-button-trial"],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute() {
        throw new Error("A queued stopped Delegation must not execute");
      },
    },
    sourceCommit,
  });
  await confirmTrial(originatingScenario, "originating-call");
  await originatingScenario.close();

  const reconnectedScenario = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: [],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute() {
        throw new Error("A queued stopped Delegation must not execute");
      },
    },
    sourceCommit,
  });
  await reconnectedScenario.authenticateTelephoneSession("telephone-session-later");
  const stopped = await reconnectedScenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-later",
    transcript: "Stop",
    turnId: "turn-later-stop",
  });
  expect(stopped.actions).toEqual([
    {
      interruptible: true,
      kind: "speak-semantic-response",
      responseId: "turn-later-stop:stop-response",
      taskId: "task-button-trial",
      text:
        "I recorded the stop request. Restricted Codex will halt at its next safe boundary and preserve every completed commit and worktree change.",
    },
  ]);
  expect(
    (await reconnectedScenario.getDelegation("task-button-trial"))?.delegation
      .stopRequested,
  ).toBe(true);
  expect((await reconnectedScenario.processNextDelegation())?.task.status).toBe(
    "stopped",
  );
  await reconnectedScenario.close();
});

test("a spoken stop request preserves completed changes and quarantines a dirty worktree", async () => {
  let reportStarted: (() => void) | undefined;
  let allowStop: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    allowStop = resolve;
  });
  const scenario = await createScenario({
    async execute({ brief, stopRequested, worktree }) {
      reportStarted?.();
      await stopGate;
      expect(await stopRequested()).toBe(true);
      return stoppedResult(brief, worktree);
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-stop");
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-stop",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-stop-request",
  });
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-stop",
    transcript: "Yes",
    turnId: "turn-stop-confirm",
  });

  const processing = scenario.processNextDelegation();
  await started;
  const stopped = await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-stop",
    transcript: "Stop.",
    turnId: "turn-stop",
  });
  expect(stopped.actions).toEqual([
    {
      interruptible: true,
      kind: "speak-semantic-response",
      responseId: "turn-stop:stop-response",
      taskId: "task-button-trial",
      text:
        "I recorded the stop request. Restricted Codex will halt at its next safe boundary and preserve every completed commit and worktree change.",
    },
  ]);
  allowStop?.();

  const record = await processing;
  expect(record).toMatchObject({
    delegation: {
      result: {
        changedFiles: ["ui/style.css"],
        cleanup: {
          eligible: false,
          quarantineReason: "Stopped with uncommitted work",
        },
        commits: [resultCommit],
        pullRequest: { state: "none", url: null },
        status: "stopped",
        worktree: { dirty: true, state: "stopped" },
      },
      stopRequested: true,
    },
    task: {
      conclusion: "Keeplore Button Trial stopped with its worktree preserved.",
      status: "stopped",
    },
  });
  expect(await scenario.processNextDelegation()).toBeUndefined();
});

test("a stop request prevents queued Delegation work and retains its assigned worktree", async () => {
  const scenario = await createScenario({
    async execute() {
      throw new Error("A stopped queued Delegation must never reach Codex");
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-queued-stop");
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-queued-stop",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-queued-request",
  });
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-queued-stop",
    transcript: "Yes",
    turnId: "turn-queued-confirm",
  });
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-queued-stop",
    transcript: "Stop",
    turnId: "turn-queued-stop",
  });

  const stopped = await scenario.processNextDelegation();

  expect(stopped).toMatchObject({
    delegation: {
      result: {
        changedFiles: [],
        cleanup: {
          eligible: false,
          quarantineReason: "Stopped before execution; worktree retained",
        },
        commits: [],
        pullRequest: { state: "none", url: null },
        status: "stopped",
        worktree: { dirty: false, state: "stopped" },
      },
      stopRequested: true,
    },
    task: { status: "stopped" },
  });
});

test("an out-of-scope Subagent result is quarantined and cannot publish a pull request", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      const result = successfulResult(brief, worktree);
      return {
        ...result,
        changedFiles: ["ui/style.css", "private/environment_variables.php"],
        cleanup: {
          eligible: false,
          quarantineReason: "Subagent reported an out-of-scope edit",
        },
        pullRequest: { state: "none" as const, url: null },
        status: "failed" as const,
        worktree: { ...result.worktree, dirty: true, state: "failed" as const },
      };
    },
  });
  await scenario.authenticateTelephoneSession("telephone-session-hostile");
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-hostile",
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: "turn-hostile-request",
  });
  await scenario.receiveTelephoneTurn({
    telephoneSessionId: "telephone-session-hostile",
    transcript: "Yes",
    turnId: "turn-hostile-confirm",
  });

  const failed = await scenario.processNextDelegation();

  expect(failed).toMatchObject({
    delegation: {
      result: {
        changedFiles: ["ui/style.css", "private/environment_variables.php"],
        cleanup: {
          eligible: false,
          quarantineReason:
            "Delegation policy rejected the Subagent result; worktree quarantined",
        },
        pullRequest: { state: "none", url: null },
        risks: [
          "Delegation Result changed a path outside the table-only scope",
        ],
        status: "failed",
        worktree: { dirty: true, state: "failed" },
      },
    },
    task: {
      conclusion: "Keeplore Button Trial could not be verified.",
      status: "failed",
    },
  });
});

test("a Delegation that failed in the restricted sandbox records what ended it", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      return failedSandboxResult(brief, worktree);
    },
  });
  await confirmTrial(scenario, "sandbox");

  const failed = await scenario.processNextDelegation();

  expect(failed?.delegation.result?.failure).toEqual({
    evidencePaths: [
      "/var/lib/voice-agent-evidence/delegation-button-trial/restricted-runner-failure.json",
      "/var/lib/voice-agent-evidence/delegation-button-trial/model-workspace",
    ],
    kind: "sandbox-initialization",
    message:
      "Restricted Codex sandbox did not start; the runner exited with code 1",
    name: "RestrictedRunFailure",
  });
  expect(failed).toMatchObject({
    delegation: {
      result: {
        changedFiles: [],
        cleanup: {
          eligible: false,
          quarantineReason:
            "Delegated Worktree is incomplete or dirty and must be retained",
        },
        commits: [],
        pullRequest: { state: "none", url: null },
        status: "failed",
      },
    },
    task: {
      conclusion: "Keeplore Button Trial could not be verified.",
      status: "failed",
    },
  });
});

test("failure evidence outside the Delegation evidence directory is quarantined", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      const result = failedSandboxResult(brief, worktree);
      return {
        ...result,
        failure: {
          ...result.failure,
          evidencePaths: ["/var/lib/voice-codex/tmp/model-workspace"],
        },
      };
    },
  });
  await confirmTrial(scenario, "escaped-evidence");

  const failed = await scenario.processNextDelegation();

  expect(failed).toMatchObject({
    delegation: {
      result: {
        cleanup: {
          eligible: false,
          quarantineReason:
            "Delegation policy rejected the Subagent result; worktree quarantined",
        },
        risks: ["Delegation failure evidence escaped its evidence directory"],
        status: "failed",
      },
    },
    task: { status: "failed" },
  });
});

test("a result that reports another repository's pull request is quarantined", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      const result = successfulResult(brief, worktree);
      return {
        ...result,
        pullRequest: {
          state: "open" as const,
          url: "https://github.com/JacobStephens2/voice-agent/pull/13",
        },
      };
    },
  });
  await confirmTrial(scenario, "wrong-pr");

  const failed = await scenario.processNextDelegation();

  expect(failed).toMatchObject({
    delegation: {
      result: {
        cleanup: {
          eligible: false,
          quarantineReason:
            "Delegation policy rejected the Subagent result; worktree quarantined",
        },
        pullRequest: { state: "none", url: null },
        risks: ["Delegation Result names a pull request outside Keeplore"],
        status: "failed",
      },
    },
    task: { status: "failed" },
  });
});

test("visual evidence outside the Delegation evidence directory is quarantined", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      const result = successfulResult(brief, worktree);
      return {
        ...result,
        verification: {
          ...result.verification,
          screenshots: result.verification.screenshots.map((screenshot) => ({
            ...screenshot,
            path: `/tmp/${screenshot.viewport.name}-table.png`,
          })),
        },
      };
    },
  });
  await confirmTrial(scenario, "wrong-evidence-path");

  const failed = await scenario.processNextDelegation();

  expect(failed).toMatchObject({
    delegation: {
      result: {
        pullRequest: { state: "none", url: null },
        risks: ["Delegation screenshot escaped its evidence directory"],
        status: "failed",
      },
    },
    task: { status: "failed" },
  });
});

test("a candidate that misses several matched properties is told all of them", async () => {
  const scenario = await createScenario({
    async execute({ brief, worktree }) {
      const result = successfulResult(brief, worktree);
      return {
        ...result,
        verification: {
          ...result.verification,
          // The shape a real Delegation produced: padding and typography that
          // read as a match but compute differently, and a shadow and colour
          // the candidate never touched.
          computedStyles: result.verification.computedStyles.map((entry) => ({
            ...entry,
            getRidOf: {
              ...entry.getRidOf,
              boxShadow: "rgba(25, 28, 30, 0.06) 0px 12px 32px 0px",
              fontSize: "13.6px",
              height: "51.1875px",
              paddingBottom: "6.4px",
              paddingTop: "6.4px",
            },
          })),
        },
      };
    },
  });
  await confirmTrial(scenario, "several-mismatched-properties");

  const failed = await scenario.processNextDelegation();

  // Naming only the alphabetically first mismatch sent a real diagnosis after
  // boxShadow while five other properties were also wrong.
  expect(failed).toMatchObject({
    delegation: {
      result: {
        pullRequest: { state: "none", url: null },
        risks: [
          "desktop Keeplore table controls differ in boxShadow, fontSize, height, paddingBottom, paddingTop",
        ],
        status: "failed",
      },
    },
    task: { status: "failed" },
  });
});

async function createScenario(
  runner: Parameters<typeof createKeeploreButtonTrialScenario>[0]["runner"],
): Promise<KeeploreButtonTrialScenario> {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-button-trial-"));
  temporaryDirectories.push(directory);
  return createKeeploreButtonTrialScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: ["task-button-trial", "delegation-button-trial"],
    now,
    registration: keeploreRegistration(),
    runner,
    sourceCommit,
  });
}

test("a Delegation Result stored before its failure account was recorded still lists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-button-legacy-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const scenario = await createKeeploreButtonTrialScenario({
    databasePath,
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
  await confirmTrial(scenario, "legacy-result");
  expect((await scenario.processNextDelegation())?.task.status).toBe(
    "completed",
  );
  await scenario.close();

  // Rows written before ADR-0051 carry no `failure` key at all.
  const database = new Database(databasePath);
  const stripped = database
    .prepare(
      "UPDATE keeplore_delegations SET result_json = json_remove(result_json, '$.failure')",
    )
    .run();
  expect(stripped.changes).toBe(1);
  database.close();

  const reopened = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: [],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute() {
        throw new Error("the runner is outside this repro");
      },
    },
    sourceCommit,
  });
  try {
    // Listing must not throw: the trial's inspection, and a status or Stop turn
    // on a live call, all project every stored Delegation.
    const records = await reopened.listDelegations();
    expect(records).toHaveLength(1);
    expect(records[0]?.delegation.result?.failure).toBeNull();
    expect(records[0]?.delegation.result?.status).toBe("completed");
  } finally {
    await reopened.close();
  }
});

test("a Delegation Brief stored under the superseded criterion wording still lists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-button-criterion-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "voice-agent.sqlite");
  const scenario = await createKeeploreButtonTrialScenario({
    databasePath,
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
  await confirmTrial(scenario, "superseded-criterion");
  expect((await scenario.processNextDelegation())?.task.status).toBe(
    "completed",
  );
  await scenario.close();

  // Briefs accepted before the criterion named both verification viewports
  // carry the shorter wording.
  const database = new Database(databasePath);
  const rewritten = database
    .prepare(
      `UPDATE keeplore_delegations
       SET brief_json = json_set(brief_json, '$.acceptanceCriteria[0]', ?)`,
    )
    .run(
      "Table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight.",
    );
  expect(rewritten.changes).toBe(1);
  database.close();

  const reopened = await createKeeploreButtonTrialScenario({
    databasePath,
    ids: [],
    now,
    registration: keeploreRegistration(),
    runner: {
      async execute() {
        throw new Error("the runner is outside this repro");
      },
    },
    sourceCommit,
  });
  try {
    const records = await reopened.listDelegations();
    expect(records).toHaveLength(1);
    expect(records[0]?.delegation.brief.acceptanceCriteria[0]).toBe(
      "Table-view Get Rid Of and Remove controls match in height, vertical padding, typography, and visual weight.",
    );
  } finally {
    await reopened.close();
  }
});

async function confirmTrial(
  scenario: KeeploreButtonTrialScenario,
  suffix: string,
): Promise<void> {
  const telephoneSessionId = `telephone-session-${suffix}`;
  await scenario.authenticateTelephoneSession(telephoneSessionId);
  await scenario.receiveTelephoneTurn({
    telephoneSessionId,
    transcript:
      "Make the Get Rid Of button match Remove in Keeplore's table view.",
    turnId: `turn-${suffix}-request`,
  });
  await scenario.receiveTelephoneTurn({
    telephoneSessionId,
    transcript: "Yes",
    turnId: `turn-${suffix}-confirm`,
  });
}

function keeploreRegistration(): KeeploreRegistration {
  return {
    registeredCodebaseId: registeredCodebaseIdSchema.parse(
      "keeplore-production",
    ),
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
    branch: worktree.branch,
    changedFiles: ["ui/style.css"],
    cleanup: { eligible: false, quarantineReason: null },
    commits: [resultCommit],
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

function failedSandboxResult(
  brief: KeeploreDelegationBrief,
  worktree: KeeploreWorktree,
): KeeploreDelegationResult & { readonly failure: KeeploreDelegationFailure } {
  const evidenceDirectory = `/var/lib/voice-agent-evidence/${brief.delegationId}`;
  return {
    branch: worktree.branch,
    changedFiles: [],
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
        `${evidenceDirectory}/restricted-runner-failure.json`,
        `${evidenceDirectory}/model-workspace`,
      ],
      kind: "sandbox-initialization",
      message:
        "Restricted Codex sandbox did not start; the runner exited with code 1",
      name: "RestrictedRunFailure",
    },
    pullRequest: { state: "none", url: null },
    risks: [
      "Workspace sandbox prevented reading the two permitted reference files.",
    ],
    status: "failed",
    verification: {
      automated: [],
      cardView: {
        afterHash: "unavailable",
        beforeHash: "unavailable",
        unchanged: false,
      },
      computedStyles: [],
      screenshots: [],
    },
    worktree: { ...worktree, dirty: true, state: "failed" },
  };
}

function stoppedResult(
  brief: KeeploreDelegationBrief,
  worktree: KeeploreWorktree,
): KeeploreDelegationResult {
  return {
    branch: worktree.branch,
    changedFiles: ["ui/style.css"],
    cleanup: {
      eligible: false,
      quarantineReason: "Stopped with uncommitted work",
    },
    commits: [resultCommit],
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
    failure: null,
    pullRequest: { state: "none", url: null },
    risks: ["The preserved worktree contains uncommitted work."],
    status: "stopped",
    verification: {
      automated: [],
      cardView: {
        afterHash: "not-reverified-after-stop",
        beforeHash: "card-view-baseline",
        unchanged: false,
      },
      computedStyles: [],
      screenshots: [],
    },
    worktree: { ...worktree, dirty: true, state: "stopped" },
  };
}
