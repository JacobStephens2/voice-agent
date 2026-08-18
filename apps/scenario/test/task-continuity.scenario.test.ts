import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTaskContinuityScenario } from "../src/task-continuity.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("accepted background work and its Completion Callback survive call and process loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-continuity-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "tasks.sqlite");
  const interrupted = await createTaskContinuityScenario({
    databasePath,
    ids: [
      "task-continuity",
      "work-operation",
      "task-event",
      "operation-event",
      "completion-report",
      "completion-operation",
      "completion-requested-event",
    ],
    now: "2026-08-17T14:00:00.000Z",
  });

  const accepted = await interrupted.acceptTask("request-continuity");
  const disconnect = await interrupted.requestCompletionCallback({
    requestId: "completion-request-continuity",
    taskId: accepted.task.id,
    telephoneSessionId: "telephone-session-original",
  });

  expect(disconnect).toEqual({
    disposition: "disconnect",
    text: "I’ll keep working and call your registered telephone once this task finishes.",
  });
  expect((await interrupted.readTask(accepted.task.id))?.task.status).toBe(
    "pending",
  );
  await interrupted.close();

  const resumed = await createTaskContinuityScenario({
    databasePath,
    ids: ["observed-event", "operation-completed-event", "task-completed-event"],
    now: "2026-08-17T14:00:01.000Z",
  });
  try {
    const completed = await resumed.processNextTask();
    expect(completed?.task.id).toBe(accepted.task.id);
    const action = await resumed.processNextReport();
    expect(action).toMatchObject({
      kind: "place-completion-callback",
      operationId: "completion-operation",
      taskId: accepted.task.id,
      telephoneSessionId: "telephone-session-original",
    });
    expect((await resumed.readTask(accepted.task.id))?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "completion.callback.requested" }),
      ]),
    );
  } finally {
    await resumed.close();
  }
});

test("a missed Completion Callback leaves one generic voicemail and falls back to one generic email", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-missed-callback-"));
  temporaryDirectories.push(directory);
  const scenario = await createTaskContinuityScenario({
    databasePath: join(directory, "tasks.sqlite"),
    ids: [
      "task-missed",
      "work-operation-missed",
      "task-event-missed",
      "work-event-missed",
      "report-missed",
      "callback-operation-missed",
      "callback-request-event-missed",
      "observed-event-missed",
      "work-completed-event-missed",
      "task-completed-event-missed",
      "callback-outcome-event-missed",
      "callback-completed-event-missed",
      "notification-operation-missed",
      "notification-request-event-missed",
      "notification-sent-event-missed",
      "notification-completed-event-missed",
    ],
    now: "2026-08-17T15:00:00.000Z",
  });

  try {
    const accepted = await scenario.acceptTask("request-missed");
    await scenario.requestCompletionCallback({
      requestId: "completion-request-missed",
      taskId: accepted.task.id,
      telephoneSessionId: "telephone-session-missed",
    });
    await scenario.processNextTask();
    const callback = await scenario.processNextReport();
    if (callback?.kind !== "place-completion-callback") {
      throw new Error("Completion Callback was not dispatched");
    }

    const firstOutcome = await scenario.receiveCompletionCallbackEvent({
      deliveryId: "provider-delivery-missed",
      operationId: callback.operationId,
      outcome: "voicemail",
    });
    expect(firstOutcome.actions).toEqual([
      {
        effectId: "callback-operation-missed:voicemail",
        kind: "play-completion-voicemail-and-end",
        text: "Your Voice Agent task has finished. Open the secure app for details.",
      },
    ]);
    expect(
      await scenario.receiveCompletionCallbackEvent({
        deliveryId: "provider-delivery-missed",
        operationId: callback.operationId,
        outcome: "voicemail",
      }),
    ).toEqual({ actions: [] });

    const notification = await scenario.processNextReport();
    expect(notification).toEqual({
      clickTracking: false,
      evidenceRecordUrl: `https://voice.stephens.page/?task=${accepted.task.id}`,
      from: "Voice Agent <tasks@notify.stephens.page>",
      idempotencyKey: "notification-operation-missed",
      kind: "send-silent-notification",
      openTracking: false,
      operationId: "notification-operation-missed",
      subject: "Voice Agent task update",
      taskId: accepted.task.id,
      text: `A Voice Agent task reached a terminal state. View it securely at https://voice.stephens.page/?task=${accepted.task.id}`,
      to: "owner@example.com",
    });
    expect(await scenario.processNextReport()).toBeUndefined();

    await scenario.recordNotificationDelivery({
      deliveryId: "resend-delivery-missed",
      operationId: "notification-operation-missed",
      providerMessageId: "resend-message-missed",
    });
    await scenario.recordNotificationDelivery({
      deliveryId: "resend-delivery-missed",
      operationId: "notification-operation-missed",
      providerMessageId: "resend-message-missed",
    });
    const record = await scenario.readTask(accepted.task.id);
    expect(
      record?.evidence.filter((event) => event.kind === "notification.sent"),
    ).toHaveLength(1);
    const metrics = await scenario.readMetrics();
    expect(metrics).toContain(
      'voice_agent_notifications{outcome="requested"} 1',
    );
    expect(metrics).toContain(
      'voice_agent_notifications{outcome="sent"} 1',
    );
    expect(metrics).not.toContain("owner@example.com");
  } finally {
    await scenario.close();
  }
});

test("an authenticated Completion Callback resumes the existing Durable Task once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-resumption-"));
  temporaryDirectories.push(directory);
  const scenario = await createTaskContinuityScenario({
    databasePath: join(directory, "tasks.sqlite"),
    ids: [
      "task-resumed",
      "work-operation-resumed",
      "task-event-resumed",
      "work-event-resumed",
      "report-resumed",
      "callback-operation-resumed",
      "callback-request-event-resumed",
      "observed-event-resumed",
      "work-completed-event-resumed",
      "task-completed-event-resumed",
      "callback-outcome-event-resumed",
      "callback-completed-event-resumed",
      "telephone-session-resumed",
      "completion-resumption-operation",
      "completion-resumption-accepted-event",
      "completion-resumption-completed-event",
      "resumed-failure-notification-operation",
    ],
    now: "2026-08-17T16:00:00.000Z",
  });

  try {
    const accepted = await scenario.acceptTask("request-resumed");
    await scenario.requestCompletionCallback({
      requestId: "completion-request-resumed",
      taskId: accepted.task.id,
      telephoneSessionId: "telephone-session-original-resumed",
    });
    await scenario.processNextTask();
    const callback = await scenario.processNextReport();
    if (callback?.kind !== "place-completion-callback") {
      throw new Error("Completion Callback was not dispatched");
    }
    const resumed = await scenario.receiveCompletionCallbackEvent({
      authentication: { answer: "human", digit: "1" },
      deliveryId: "provider-delivery-resumed",
      operationId: callback.operationId,
      outcome: "authorized",
    });

    expect(resumed.actions).toEqual([
      {
        effectId: "completion-resumption-operation",
        kind: "resume-existing-task",
        taskId: accepted.task.id,
        telephoneSessionId: "telephone-session-resumed",
      },
    ]);
    expect(
      await scenario.claimImmediateCompletionResumption({
        operationId: "completion-resumption-operation",
        taskId: accepted.task.id,
      }),
    ).toBe(true);
    expect(
      await scenario.claimImmediateCompletionResumption({
        operationId: "completion-resumption-operation",
        taskId: accepted.task.id,
      }),
    ).toBe(false);
    expect(
      await scenario.receiveCompletionCallbackEvent({
        authentication: { answer: "human", digit: "1" },
        deliveryId: "provider-delivery-resumed",
        operationId: callback.operationId,
        outcome: "authorized",
      }),
    ).toEqual({ actions: [] });
    await scenario.recordCompletionResumption({
      operationId: "completion-resumption-operation",
    });
    expect(
      await scenario.receiveCompletionCallbackEvent({
        authentication: { answer: "human", digit: "1" },
        deliveryId: "provider-delivery-resumed",
        operationId: callback.operationId,
        outcome: "authorized",
      }),
    ).toEqual({ actions: [] });
    expect(await scenario.processNextReport()).toBeUndefined();
    await scenario.requestSessionFailureNotification({
      callbackOperationId: callback.operationId,
      failureEventId: "resumed-provider-failure",
    });
    expect(await scenario.processNextReport()).toMatchObject({
      kind: "send-silent-notification",
      operationId: "resumed-failure-notification-operation",
      taskId: accepted.task.id,
    });
    expect((await scenario.readTask(accepted.task.id))?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            resumedTelephoneSessionId: "telephone-session-resumed",
          }),
          kind: "completion.callback.outcome",
        }),
      ]),
    );
    expect(
      (await scenario.readTask(accepted.task.id))?.evidence.filter(
        (event) => event.kind === "completion.callback.outcome",
      ),
    ).toHaveLength(1);
  } finally {
    await scenario.close();
  }
});

test("a late conflicting callback delivery returns the terminal authorized result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-terminal-callback-"));
  temporaryDirectories.push(directory);
  const scenario = await createTaskContinuityScenario({
    databasePath: join(directory, "tasks.sqlite"),
    ids: [
      "task-terminal-callback",
      "work-terminal-callback",
      "task-event-terminal-callback",
      "work-event-terminal-callback",
      "report-terminal-callback",
      "callback-terminal-callback",
      "callback-request-terminal-callback",
      "observed-terminal-callback",
      "work-completed-terminal-callback",
      "task-completed-terminal-callback",
      "outcome-terminal-callback",
      "callback-completed-terminal-callback",
      "telephone-session-terminal-callback",
      "resumption-terminal-callback",
      "resumption-accepted-terminal-callback",
      "resumption-completed-terminal-callback",
      "discarded-late-outcome",
      "discarded-late-completion",
      "discarded-late-notification",
      "discarded-late-notification-request",
    ],
    now: "2026-08-17T16:40:00.000Z",
  });

  try {
    const accepted = await scenario.acceptTask("request-terminal-callback");
    await scenario.requestCompletionCallback({
      requestId: "completion-request-terminal-callback",
      taskId: accepted.task.id,
      telephoneSessionId: "telephone-session-original-terminal-callback",
    });
    await scenario.processNextTask();
    const callback = await scenario.processNextReport();
    if (callback?.kind !== "place-completion-callback") {
      throw new Error("Completion Callback was not dispatched");
    }
    await scenario.receiveCompletionCallbackEvent({
      authentication: { answer: "human", digit: "1" },
      deliveryId: "authorized-terminal-delivery",
      operationId: callback.operationId,
      outcome: "authorized",
    });

    const lateFailure = {
      authentication: { answer: "human" as const, digit: "2" },
      deliveryId: "late-conflicting-delivery",
      operationId: callback.operationId,
      outcome: "failed" as const,
    };
    await expect(
      scenario.receiveCompletionCallbackEvent(lateFailure),
    ).resolves.toEqual({ actions: [] });
    await expect(
      scenario.receiveCompletionCallbackEvent(lateFailure),
    ).resolves.toEqual({ actions: [] });
    await scenario.recordCompletionResumption({
      operationId: "resumption-terminal-callback",
    });

    const record = await scenario.readTask(accepted.task.id);
    expect(
      record?.evidence.filter(
        (event) => event.kind === "completion.callback.outcome",
      ),
    ).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ outcome: "authorized" }),
      }),
    ]);
    expect(
      record?.evidence.filter((event) => event.kind === "notification.requested"),
    ).toHaveLength(0);
    expect(await scenario.processNextReport()).toBeUndefined();
  } finally {
    await scenario.close();
  }
});

test("worker restart reconstructs an authorized resumption without another telephone call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-resumption-restart-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "tasks.sqlite");
  const interrupted = await createTaskContinuityScenario({
    databasePath,
    ids: [
      "task-resumption-restart",
      "work-resumption-restart",
      "task-event-resumption-restart",
      "work-event-resumption-restart",
      "report-resumption-restart",
      "callback-resumption-restart",
      "callback-request-resumption-restart",
      "observed-resumption-restart",
      "work-complete-resumption-restart",
      "task-complete-resumption-restart",
      "callback-outcome-resumption-restart",
      "callback-complete-resumption-restart",
      "telephone-session-resumption-restart",
      "operation-resumption-restart",
      "operation-resumption-restart-accepted",
      "operation-resumption-restart-completed",
    ],
    now: "2026-08-17T16:45:00.000Z",
  });
  const accepted = await interrupted.acceptTask("request-resumption-restart");
  await interrupted.requestCompletionCallback({
    requestId: "completion-request-resumption-restart",
    taskId: accepted.task.id,
    telephoneSessionId: "telephone-session-original-restart",
  });
  await interrupted.processNextTask();
  const callback = await interrupted.processNextReport();
  if (callback?.kind !== "place-completion-callback") {
    throw new Error("Completion Callback was not dispatched");
  }
  await interrupted.receiveCompletionCallbackEvent({
    authentication: { answer: "human", digit: "1" },
    deliveryId: "authorized-before-worker-crash",
    operationId: callback.operationId,
    outcome: "authorized",
  });
  await interrupted.close();

  const restarted = await createTaskContinuityScenario({
    databasePath,
    ids: [],
    now: "2026-08-17T16:45:16.000Z",
  });
  try {
    const recovery = await restarted.processNextReport();
    expect(recovery).toEqual({
      callbackOperationId: "callback-resumption-restart",
      effectId: "operation-resumption-restart",
      kind: "resume-completion-callback",
      operationId: "operation-resumption-restart",
      taskId: accepted.task.id,
      telephoneSessionId: "telephone-session-resumption-restart",
    });
    if (recovery?.kind !== "resume-completion-callback") {
      throw new Error("Completion resumption was not reconstructed");
    }
    expect(
      await restarted.claimCompletionCallbackPlacement(
        recovery.effectId,
        recovery.taskId,
      ),
    ).toBe(true);
  } finally {
    await restarted.close();
  }

  const afterDispatchCrash = await createTaskContinuityScenario({
    databasePath,
    ids: [
      "resumption-recovery-notification",
      "resumption-recovery-notification-sent",
      "resumption-recovery-notification-completed",
    ],
    now: "2026-08-17T16:48:00.000Z",
  });
  try {
    const replayed = await afterDispatchCrash.processNextReport();
    if (replayed?.kind !== "resume-completion-callback") {
      throw new Error("Completion resumption was not replayed after its lease");
    }
    expect(
      await afterDispatchCrash.claimCompletionCallbackPlacement(
        replayed.effectId,
        replayed.taskId,
      ),
    ).toBe(false);
    await afterDispatchCrash.requestSessionFailureNotification({
      callbackOperationId: replayed.callbackOperationId,
      failureEventId: "resumption-recovery-dispatch-already-claimed",
    });
    const fallback = await afterDispatchCrash.processNextReport();
    expect(fallback).toMatchObject({
      kind: "send-silent-notification",
      operationId: "resumption-recovery-notification",
    });
    if (fallback?.kind !== "send-silent-notification") {
      throw new Error("Recovery fallback was not dispatched");
    }
    await afterDispatchCrash.recordNotificationDelivery({
      deliveryId: "resumption-recovery-notification-delivery",
      operationId: fallback.operationId,
      providerMessageId: "resumption-recovery-notification-provider-id",
    });
    expect(await afterDispatchCrash.processNextReport()).toBeUndefined();
  } finally {
    await afterDispatchCrash.close();
  }
});

test("resumption completion evidence is repaired after a post-commit crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-resumption-completion-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "tasks.sqlite");
  const interrupted = await createTaskContinuityScenario({
    databasePath,
    ids: [
      "task-resumption-completion",
      "work-resumption-completion",
      "task-event-resumption-completion",
      "work-event-resumption-completion",
      "report-resumption-completion",
      "callback-resumption-completion",
      "callback-request-resumption-completion",
      "observed-resumption-completion",
      "work-completed-resumption-completion",
      "task-completed-resumption-completion",
      "outcome-resumption-completion",
      "callback-completed-resumption-completion",
      "telephone-session-resumption-completion",
      "operation-resumption-completion",
      "operation-resumption-completion-accepted",
      "operation-resumption-completion-completed",
    ],
    now: "2026-08-17T16:50:00.000Z",
  });
  const accepted = await interrupted.acceptTask("request-resumption-completion");
  await interrupted.requestCompletionCallback({
    requestId: "completion-request-resumption-completion",
    taskId: accepted.task.id,
    telephoneSessionId: "telephone-session-original-resumption-completion",
  });
  await interrupted.processNextTask();
  const callback = await interrupted.processNextReport();
  if (callback?.kind !== "place-completion-callback") {
    throw new Error("Completion Callback was not dispatched");
  }
  await interrupted.receiveCompletionCallbackEvent({
    authentication: { answer: "human", digit: "1" },
    deliveryId: "authorized-resumption-completion",
    operationId: callback.operationId,
    outcome: "authorized",
  });
  expect(
    await interrupted.claimImmediateCompletionResumption({
      operationId: "operation-resumption-completion",
      taskId: accepted.task.id,
    }),
  ).toBe(true);
  await interrupted.close();

  const duringDirectResumption = await createTaskContinuityScenario({
    databasePath,
    ids: [],
    now: "2026-08-17T16:50:16.000Z",
  });
  expect(await duringDirectResumption.processNextReport()).toBeUndefined();
  await duringDirectResumption.completeCompletionResumptionWithoutEvidence(
    "operation-resumption-completion",
  );
  await duringDirectResumption.close();

  const afterCompletionCrash = await createTaskContinuityScenario({
    databasePath,
    ids: [],
    now: "2026-08-17T16:50:01.000Z",
  });
  try {
    await afterCompletionCrash.recordCompletionResumption({
      operationId: "operation-resumption-completion",
    });
    const record = await afterCompletionCrash.readTask(accepted.task.id);
    expect(
      record?.evidence.filter(
        (event) =>
          event.kind === "operation.completed" &&
          event.details.operationId === "operation-resumption-completion",
      ),
    ).toHaveLength(1);
    expect(await afterCompletionCrash.processNextReport()).toBeUndefined();
  } finally {
    await afterCompletionCrash.close();
  }
});

test("failed callback authentication records the observed human and rejected DTMF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-auth-evidence-"));
  temporaryDirectories.push(directory);
  const scenario = await createTaskContinuityScenario({
    databasePath: join(directory, "tasks.sqlite"),
    ids: [
      "task-auth-evidence",
      "work-auth-evidence",
      "task-event-auth-evidence",
      "work-event-auth-evidence",
      "report-auth-evidence",
      "callback-auth-evidence",
      "callback-request-auth-evidence",
      "observed-auth-evidence",
      "work-complete-auth-evidence",
      "task-complete-auth-evidence",
      "callback-outcome-auth-evidence",
      "callback-complete-auth-evidence",
      "notification-auth-evidence",
      "notification-request-auth-evidence",
    ],
    now: "2026-08-17T16:30:00.000Z",
  });
  try {
    const accepted = await scenario.acceptTask("request-auth-evidence");
    await scenario.requestCompletionCallback({
      requestId: "completion-request-auth-evidence",
      taskId: accepted.task.id,
      telephoneSessionId: "telephone-session-auth-evidence",
    });
    await scenario.processNextTask();
    const callback = await scenario.processNextReport();
    if (callback?.kind !== "place-completion-callback") {
      throw new Error("Completion Callback was not dispatched");
    }
    await scenario.receiveCompletionCallbackEvent({
      authentication: { answer: "human", digit: "2" },
      deliveryId: "failed-auth-delivery",
      operationId: callback.operationId,
      outcome: "failed",
    });
    expect((await scenario.readTask(accepted.task.id))?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            humanDetected: true,
            receivedDtmfOne: false,
          }),
          kind: "completion.callback.outcome",
        }),
      ]),
    );
  } finally {
    await scenario.close();
  }
});

test("stop prevents future work at the next safe boundary without deleting accepted evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-stop-"));
  temporaryDirectories.push(directory);
  const scenario = await createTaskContinuityScenario({
    databasePath: join(directory, "tasks.sqlite"),
    ids: [
      "task-stopped",
      "work-operation-stopped",
      "task-event-stopped",
      "work-event-stopped",
      "report-stopped",
      "callback-operation-stopped",
      "callback-request-event-stopped",
      "stop-operation",
      "stop-request-event",
      "stop-accepted-event",
      "stop-completed-event",
      "task-cancelled-event",
    ],
    now: "2026-08-17T17:00:00.000Z",
  });

  try {
    const accepted = await scenario.acceptTask("request-stopped");
    await scenario.requestCompletionCallback({
      requestId: "completion-request-stopped",
      taskId: accepted.task.id,
      telephoneSessionId: "telephone-session-stopped",
    });
    const stopped = await scenario.requestStop({
      requestId: "stop-request-stopped",
      taskId: accepted.task.id,
    });

    expect(stopped.task).toMatchObject({
      conclusion: "Bountywell inquiry cancelled.",
      id: accepted.task.id,
      status: "cancelled",
    });
    expect(await scenario.processNextTask()).toBeUndefined();
    expect(await scenario.processNextReport()).toMatchObject({
      kind: "place-completion-callback",
      taskId: accepted.task.id,
    });
    expect(stopped.evidence.map((event) => event.kind)).toEqual([
      "task.accepted",
      "operation.accepted",
      "completion.callback.requested",
      "task.cancellation.requested",
      "operation.accepted",
      "operation.completed",
      "task.cancelled",
    ]);
  } finally {
    await scenario.close();
  }
});

test("notification identity and preference changes require a Fresh Passkey Action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-preference-"));
  temporaryDirectories.push(directory);
  const scenario = await createTaskContinuityScenario({
    databasePath: join(directory, "tasks.sqlite"),
    ids: [],
    now: "2026-08-17T18:00:00.000Z",
  });

  try {
    const denied = await scenario.updateNotificationPreference({
      email: "new-owner@example.com",
      freshPasskey: false,
      from: "Voice Agent <tasks@notify.stephens.page>",
      notificationSubdomain: "notify.stephens.page",
    });
    expect(denied).toMatchObject({
      body: { error: "Fresh Passkey Action required" },
      statusCode: 403,
    });

    const updated = await scenario.updateNotificationPreference({
      email: "new-owner@example.com",
      freshPasskey: true,
      from: "Voice Agent <tasks@notify.stephens.page>",
      notificationSubdomain: "notify.stephens.page",
    });
    expect(updated).toEqual({
      body: {
        clickTracking: false,
        configuredAt: "2026-08-17T18:00:00.000Z",
        email: "new-owner@example.com",
        from: "Voice Agent <tasks@notify.stephens.page>",
        notificationSubdomain: "notify.stephens.page",
        openTracking: false,
        revision: 2,
      },
      statusCode: 200,
    });
    await expect(
      scenario.applyEvidenceLifecyclePolicy({ freshPasskey: false }),
    ).resolves.toMatchObject({
      body: { error: "Fresh Passkey Action required" },
      statusCode: 403,
    });
    await expect(
      scenario.applyEvidenceLifecyclePolicy({ freshPasskey: true }),
    ).resolves.toMatchObject({
      body: { cutoff: expect.stringMatching(/^2026-/u) },
      statusCode: 200,
    });
    await expect(scenario.runEvidenceLifecyclePolicy()).resolves.toMatchObject({
      cutoff: expect.stringMatching(/^2026-/u),
    });
  } finally {
    await scenario.close();
  }
});

test("crashes before and after report effects retry the same durable identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-report-crash-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "tasks.sqlite");
  const interrupted = await createTaskContinuityScenario({
    databasePath,
    ids: [
      "task-crash",
      "work-operation-crash",
      "task-event-crash",
      "work-event-crash",
      "report-crash",
      "callback-operation-crash",
      "callback-request-event-crash",
      "observed-event-crash",
      "work-completed-event-crash",
      "task-completed-event-crash",
    ],
    now: "2026-08-17T19:00:00.000Z",
  });
  const accepted = await interrupted.acceptTask("request-crash");
  await interrupted.requestCompletionCallback({
    requestId: "completion-request-crash",
    taskId: accepted.task.id,
    telephoneSessionId: "telephone-session-crash",
  });
  await interrupted.processNextTask();
  const claimedBeforeEffect = await interrupted.processNextReport();
  if (claimedBeforeEffect?.kind !== "place-completion-callback") {
    throw new Error("Completion Callback effect was unavailable");
  }
  expect(
    await interrupted.claimCompletionCallbackPlacement(
      claimedBeforeEffect.effectId,
      claimedBeforeEffect.taskId,
    ),
  ).toBe(true);
  await interrupted.close();

  const afterCallbackCrash = await createTaskContinuityScenario({
    databasePath,
    ids: [
      "callback-outcome-event-crash",
      "callback-completed-event-crash",
      "notification-operation-crash",
      "notification-request-event-crash",
    ],
    now: "2026-08-17T19:02:31.000Z",
  });
  const retriedCallback = await afterCallbackCrash.processNextReport();
  expect(retriedCallback).toEqual(claimedBeforeEffect);
  if (retriedCallback?.kind !== "place-completion-callback") {
    throw new Error("Completion Callback retry was unavailable");
  }
  expect(
    await afterCallbackCrash.claimCompletionCallbackPlacement(
      retriedCallback.effectId,
      retriedCallback.taskId,
    ),
  ).toBe(false);
  await afterCallbackCrash.receiveCompletionCallbackEvent({
    deliveryId: "provider-delivery-crash",
    operationId: retriedCallback.operationId,
    outcome: "unanswered",
  });
  const sentBeforeRecording = await afterCallbackCrash.processNextReport();
  expect(sentBeforeRecording).toMatchObject({
    idempotencyKey: "notification-operation-crash",
    kind: "send-silent-notification",
  });
  if (sentBeforeRecording?.kind !== "send-silent-notification") {
    throw new Error("Silent Notification effect was unavailable");
  }
  const deliveredNotifications = new Map<string, string>();
  const send = (idempotencyKey: string) => {
    const existing = deliveredNotifications.get(idempotencyKey);
    if (existing !== undefined) return existing;
    const providerMessageId = "resend-message-crash";
    deliveredNotifications.set(idempotencyKey, providerMessageId);
    return providerMessageId;
  };
  expect(send(sentBeforeRecording.idempotencyKey)).toBe(
    "resend-message-crash",
  );
  await afterCallbackCrash.close();

  const afterEmailCrash = await createTaskContinuityScenario({
    databasePath,
    ids: ["notification-sent-event-crash", "notification-completed-event-crash"],
    now: "2026-08-17T19:03:02.000Z",
  });
  try {
    expect(await afterEmailCrash.processNextReport()).toEqual(
      sentBeforeRecording,
    );
    const providerMessageId = send(sentBeforeRecording.idempotencyKey);
    expect(deliveredNotifications.size).toBe(1);
    await afterEmailCrash.recordNotificationDelivery({
      deliveryId: "resend:notification-operation-crash",
      operationId: "notification-operation-crash",
      providerMessageId,
    });
    expect(await afterEmailCrash.processNextReport()).toBeUndefined();
  } finally {
    await afterEmailCrash.close();
  }
});
