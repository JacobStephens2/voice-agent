import { expect, test } from "vitest";

import type { CompletionReportOperation } from "@voice-agent/contracts";

import { createResendSilentNotificationAdapter } from "../src/resend-silent-notification.ts";

test("Resend receives generic content and the durable notification Operation idempotency key", async () => {
  const requests: unknown[] = [];
  const adapter = createResendSilentNotificationAdapter({
    domains: {
      async get(domainId) {
        requests.push({ domainId });
        return {
          data: {
            click_tracking: false,
            name: "notify.stephens.page",
            open_tracking: false,
            status: "verified",
          },
          error: null,
        };
      },
    },
    emails: {
      async send(payload, options) {
        requests.push({ options, payload });
        return { data: { id: "resend-message-001" }, error: null };
      },
    },
  }, {
    domainId: "resend-domain-001",
    notificationSubdomain: "notify.stephens.page",
  });
  const action: Extract<
    CompletionReportOperation,
    { kind: "send-silent-notification" }
  > = {
    clickTracking: false,
    evidenceRecordUrl: "https://voice.stephens.page/?task=opaque-task-locator",
    from: "Voice Agent <tasks@notify.stephens.page>",
    idempotencyKey: "notification-operation-001",
    kind: "send-silent-notification",
    openTracking: false,
    operationId: "notification-operation-001",
    subject: "Voice Agent task update",
    taskId: "opaque-task-locator",
    text: "A Voice Agent task reached a terminal state. View it securely at https://voice.stephens.page/?task=opaque-task-locator",
    to: "owner@example.com",
  };

  await expect(adapter.send(action)).resolves.toEqual({
    providerMessageId: "resend-message-001",
  });
  expect(requests).toEqual([
    { domainId: "resend-domain-001" },
    {
      options: { idempotencyKey: "notification-operation-001" },
      payload: {
        from: "Voice Agent <tasks@notify.stephens.page>",
        subject: "Voice Agent task update",
        text: action.text,
        to: ["owner@example.com"],
      },
    },
  ]);
  expect(JSON.stringify(requests)).not.toContain("healthy");
});
