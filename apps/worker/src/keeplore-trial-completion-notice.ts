/**
 * Deliver the Keeplore Button Trial's terminal notice to the owner.
 *
 * The Completion Callback machinery in `task-continuity` runs while a
 * Telephone Session is live: the owner asks for a call during the call, and a
 * Silent Notification is its fallback. The trial finishes long after that call
 * ends — a Human Merge, a Promotion, and a production verification later — so
 * its terminal notice has no live session to hang off.
 *
 * This sends that notice. The callback outcome is read from what the Durable
 * Task actually recorded, never asserted by an operator: a Completion Callback
 * is claimed only when a `completion.callback.outcome` event says it reached
 * and authorized the owner, and every other ending gets the generic email. The
 * email carries the authenticated Evidence Record link and no operational
 * evidence, and its idempotency key is the task's own identity, so re-running
 * the attended wizard does not send a second one.
 */
import {
  completionReportOperationSchema,
  keeploreTrialCompletionNoticeSchema,
} from "@voice-agent/contracts";
import { chooseKeeploreTrialCompletionNotice } from "@voice-agent/policy";
import {
  createSqliteDurableTaskStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";

import { createProductionResendSilentNotificationAdapter } from "./resend-silent-notification.ts";

const databasePath =
  process.env.VOICE_AGENT_DATABASE_PATH ??
  "/var/lib/voice-agent/voice-agent.sqlite";
const evidenceOrigin =
  process.env.VOICE_AGENT_EVIDENCE_ORIGIN ?? "https://voice.stephens.page";
const taskId = process.env.KEEPLORE_TRIAL_TASK_ID;
if (taskId === undefined || taskId.length === 0) {
  process.stderr.write("KEEPLORE_TRIAL_TASK_ID is required.\n");
  process.exit(2);
}

const tasks = createSqliteDurableTaskStore(databasePath);
const continuity = createSqliteTaskContinuityStore(databasePath);
try {
  const record = await tasks.findByTaskId(taskId);
  if (record === undefined) {
    process.stderr.write(`Durable Task ${taskId} is unavailable.\n`);
    process.exitCode = 1;
  } else {
    const evidenceRecordUrl = `${evidenceOrigin}/?task=${encodeURIComponent(taskId)}`;
    const outcome = readRecordedCallbackOutcome(record.evidence);
    const notice = chooseKeeploreTrialCompletionNotice({
      callback: { outcome },
      evidenceRecordUrl,
    });
    if (notice.kind === "silent-notification") {
      const preference = await continuity.findNotificationPreference();
      if (preference === undefined) {
        process.stderr.write(
          "No notification preference is configured; the owner cannot be notified.\n",
        );
        process.exitCode = 1;
      } else {
        const operation = completionReportOperationSchema.parse({
          clickTracking: false,
          evidenceRecordUrl,
          from: preference.from,
          idempotencyKey: `keeplore-trial:${taskId}`,
          kind: "send-silent-notification",
          openTracking: false,
          operationId: `keeplore-trial-notice:${taskId}`,
          subject: "Voice Agent task update",
          taskId,
          text: `A Voice Agent task reached a terminal state. View it securely at ${evidenceRecordUrl}`,
          to: preference.email,
        });
        if (operation.kind !== "send-silent-notification") {
          throw new Error("The trial notice is not a Silent Notification");
        }
        const sent = await createProductionResendSilentNotificationAdapter({
          apiKey: requireEnvironment("RESEND_API_KEY"),
          domainId: requireEnvironment("RESEND_DOMAIN_ID"),
          notificationSubdomain: preference.notificationSubdomain,
        }).send(operation);
        await tasks.appendEvidence({
          event: {
            details: { operationId: operation.operationId },
            id: `${taskId}:trial-notice`,
            kind: "notification.sent",
            occurredAt: new Date().toISOString(),
            summary: `A Silent Notification linked the authenticated Evidence Record (${sent.providerMessageId}).`,
          },
          taskId,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    process.stdout.write(
      `${JSON.stringify(keeploreTrialCompletionNoticeSchema.parse(notice))}\n`,
    );
  }
} finally {
  tasks.close();
  continuity.close();
}

/**
 * Only a recorded `authorized` outcome is a Completion Callback the owner
 * received. An absent outcome means no callback was ever placed for this task.
 */
function readRecordedCallbackOutcome(
  evidence: readonly { readonly details: unknown; readonly kind: string }[],
): "authorized" | "failed" | "not-requested" | "unanswered" | "voicemail" {
  const outcomes = evidence
    .filter((event) => event.kind === "completion.callback.outcome")
    .map((event) => (event.details as { readonly outcome?: unknown }).outcome);
  const latest = outcomes.at(-1);
  if (
    latest === "authorized" ||
    latest === "failed" ||
    latest === "unanswered" ||
    latest === "voicemail"
  ) {
    return latest;
  }
  return "not-requested";
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required to send the trial's Silent Notification`);
  }
  return value;
}
