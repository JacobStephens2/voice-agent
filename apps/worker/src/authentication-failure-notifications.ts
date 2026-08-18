import { createHash } from "node:crypto";

import {
  createCallbackHandshakeRuntime,
  createTaskContinuityRuntime,
} from "@voice-agent/runtime";

import type { SilentNotificationAdapter } from "./resend-silent-notification.ts";

type CallbackRuntime = Pick<
  ReturnType<typeof createCallbackHandshakeRuntime>,
  | "appendTelephoneSessionEvidence"
  | "findPendingNotificationEvidenceRecords"
>;

type ContinuityRuntime = Pick<
  ReturnType<typeof createTaskContinuityRuntime>,
  "getNotificationPreference"
>;

export async function deliverPendingAuthenticationFailureNotifications(
  callback: CallbackRuntime,
  continuity: ContinuityRuntime,
  adapter: SilentNotificationAdapter,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  const preference = await continuity.getNotificationPreference();
  if (preference === undefined) return 0;
  let delivered = 0;
  for (const record of await callback.findPendingNotificationEvidenceRecords()) {
    const handshakeId = record.task.id;
    const sentOperationIds = new Set(
      record.evidence
        .filter((event) => event.kind === "notification.sent")
        .map((event) => event.details.operationId),
    );
    for (const event of record.evidence) {
      if (
        event.kind !== "notification.requested" ||
        sentOperationIds.has(event.details.operationId)
      ) {
        continue;
      }
      const correlation = createHash("sha256")
        .update(`${handshakeId}:${event.details.operationId}`)
        .digest("hex")
        .slice(0, 32);
      await adapter.send({
        clickTracking: false,
        evidenceRecordUrl: `https://voice.stephens.page/?task=${encodeURIComponent(handshakeId)}`,
        from: preference.from,
        idempotencyKey: `telephone-failure:${correlation}`,
        kind: "send-silent-notification",
        openTracking: false,
        operationId: event.details.operationId,
        subject: "Voice Agent task update",
        taskId: handshakeId,
        text: "A Voice Agent telephone session ended at a safe failure boundary. Open the secure app for details.",
        to: preference.email,
      });
      await callback.appendTelephoneSessionEvidence(handshakeId, {
        details: { operationId: event.details.operationId },
        id: `notification-sent:${correlation}`,
        kind: "notification.sent",
        occurredAt: now(),
        summary: "A generic Silent Notification was delivered.",
      });
      sentOperationIds.add(event.details.operationId);
      delivered += 1;
    }
  }
  return delivered;
}
