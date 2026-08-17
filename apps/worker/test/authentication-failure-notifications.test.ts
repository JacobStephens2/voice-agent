import {
  telephoneEvidenceEventSchema,
  telephoneSessionEvidenceRecordProjectionSchema,
} from "@voice-agent/contracts";
import { describe, expect, test, vi } from "vitest";

import { deliverPendingAuthenticationFailureNotifications } from "../src/authentication-failure-notifications.ts";

describe("authentication failure notification outbox", () => {
  test("retries durable requested evidence and records delivery", async () => {
    let record = telephoneSessionEvidenceRecordProjectionSchema.parse({
      evidence: [
        {
          details: { operationId: "notification-operation-1" },
          id: "notification-requested-1",
          kind: "notification.requested",
          occurredAt: "2026-08-17T12:00:00.000Z",
          sequence: 1,
          summary: "A generic Silent Notification was requested.",
        },
      ],
      session: { attempt: 1, id: "telephone-session-1", outcome: "failed" },
      task: {
        conclusion: "Callback Handshake failed.",
        createdAt: "2026-08-17T12:00:00.000Z",
        id: "handshake-1",
        kind: "callback.handshake",
        question: "Authenticate a Telephone Session.",
        status: "completed",
        updatedAt: "2026-08-17T12:00:00.000Z",
      },
    });
    const callback = {
      async appendTelephoneSessionEvidence(_handshakeId: string, event: unknown) {
        record = {
          ...record,
          evidence: [
            ...record.evidence,
            telephoneEvidenceEventSchema.parse({
              ...(event as object),
              sequence: record.evidence.length + 1,
            }),
          ],
        };
        return record;
      },
      async listEvidenceRecords() {
        return [record.task];
      },
      async readEvidenceRecord() {
        return record;
      },
    };
    const continuity = {
      async getNotificationPreference() {
        return {
          clickTracking: false as const,
          configuredAt: "2026-08-17T11:00:00.000Z",
          email: "owner@example.com",
          from: "Voice Agent <updates@example.com>",
          notificationSubdomain: "example.com",
          openTracking: false as const,
          revision: 1,
        };
      },
    };
    let fail = true;
    const send = vi.fn(async () => {
      if (fail) throw new Error("injected provider failure");
      return { providerMessageId: "message-1" };
    });

    await expect(
      deliverPendingAuthenticationFailureNotifications(
        callback,
        continuity,
        { send },
      ),
    ).rejects.toThrow("injected provider failure");
    fail = false;
    await expect(
      deliverPendingAuthenticationFailureNotifications(
        callback,
        continuity,
        { send },
        () => "2026-08-17T12:00:05.000Z",
      ),
    ).resolves.toBe(1);
    await expect(
      deliverPendingAuthenticationFailureNotifications(
        callback,
        continuity,
        { send },
      ),
    ).resolves.toBe(0);

    expect(send).toHaveBeenCalledTimes(2);
    expect(record.evidence.map((event) => event.kind)).toEqual([
      "notification.requested",
      "notification.sent",
    ]);
  });
});
