import { Resend } from "resend";

import {
  completionReportOperationSchema,
  type CompletionReportOperation,
} from "@voice-agent/contracts";

type SilentNotificationOperation = Extract<
  CompletionReportOperation,
  { kind: "send-silent-notification" }
>;

interface ResendEmailClient {
  readonly domains: {
    get(domainId: string): Promise<{
      readonly data: {
        readonly click_tracking?: boolean;
        readonly name: string;
        readonly open_tracking?: boolean;
        readonly status: string;
      } | null;
      readonly error: unknown | null;
    }>;
  };
  readonly emails: {
    send(
      payload: {
        readonly from: string;
        readonly subject: string;
        readonly text: string;
        readonly to: string[];
      },
      options: { readonly idempotencyKey: string },
    ): Promise<{
      readonly data: { readonly id: string } | null;
      readonly error: unknown | null;
    }>;
  };
}

export interface SilentNotificationAdapter {
  send(operation: SilentNotificationOperation): Promise<{
    readonly providerMessageId: string;
  }>;
}

export function createProductionResendSilentNotificationAdapter(
  input: {
    readonly apiKey: string;
    readonly domainId: string;
    readonly notificationSubdomain: string;
  },
): SilentNotificationAdapter {
  const resend = new Resend(input.apiKey);
  return createResendSilentNotificationAdapter({
    domains: {
      get: (domainId) => resend.domains.get(domainId),
    },
    emails: {
      send: (payload, options) => resend.emails.send(payload, options),
    },
  }, {
    domainId: input.domainId,
    notificationSubdomain: input.notificationSubdomain,
  });
}

export function createResendSilentNotificationAdapter(
  client: ResendEmailClient,
  configuration: {
    readonly domainId: string;
    readonly notificationSubdomain: string;
  },
): SilentNotificationAdapter {
  return {
    async send(untrustedOperation) {
      const operation = completionReportOperationSchema.parse(untrustedOperation);
      if (operation.kind !== "send-silent-notification") {
        throw new Error("Silent Notification Operation required");
      }
      const domain = await client.domains.get(configuration.domainId);
      if (
        domain.error !== null ||
        domain.data === null ||
        domain.data.status !== "verified" ||
        domain.data.name !== configuration.notificationSubdomain ||
        domain.data.open_tracking !== false ||
        domain.data.click_tracking !== false
      ) {
        throw new Error(
          "Resend notification subdomain must be verified with tracking disabled",
        );
      }
      const result = await client.emails.send(
        {
          from: operation.from,
          subject: operation.subject,
          text: operation.text,
          to: [operation.to],
        },
        { idempotencyKey: operation.idempotencyKey },
      );
      if (result.error !== null || result.data === null) {
        throw new Error("Resend Silent Notification failed");
      }
      return { providerMessageId: result.data.id };
    },
  };
}
