import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createCallbackHandshakeScenario } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("a registered caller completes one Callback Handshake only after human detection and DTMF 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-callback-"));
  temporaryDirectories.push(directory);
  const scenario = await createCallbackHandshakeScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: [
      "handshake-001",
      "telephone-session-001",
      "callback-001",
      "event-inbound-001",
      "event-notice-001",
      "event-callback-001",
      "effect-notice-001",
      "effect-callback-001",
      "event-machine-001",
      "effect-dtmf-prompt-001",
      "event-dtmf-001",
      "event-outcome-001",
      "event-authorized-001",
      "effect-confirmation-001",
    ],
    now: "2026-08-16T14:00:00.000Z",
    registeredTelephone: {
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    },
  });

  try {
    const inbound = await scenario.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "delivery-inbound-001",
      inboundTrunkId: "ST_inbound",
      providerCallId: "raw-inbound-provider-id",
    });

    expect(inbound).toMatchObject({
      disposition: "notice-and-callback",
      handshakeId: "handshake-001",
      actions: [
        {
          kind: "play-inbound-notice-and-end",
          text: "Thanks. I’ll call your registered telephone back now.",
        },
        {
          attempt: 1,
          destination: "+12155550123",
          from: "+12155550999",
          kind: "place-callback",
          livekitOutboundTrunkId: "ST_outbound",
          participantIdentity: "callback-001",
          roomName: "callback-handshake-handshake-001",
        },
      ],
    });

    const machine = await scenario.receiveProviderEvent("handshake-001", {
      attempt: 1,
      classification: "human",
      deliveryId: "delivery-machine-001",
      kind: "machine-detection",
      providerCallId: "raw-outbound-provider-id",
    });
    expect(machine.actions).toEqual([
      {
        effectId: "effect-dtmf-prompt-001",
        kind: "prompt-for-dtmf",
        text: "Press 1 to confirm you are the registered owner.",
      },
    ]);

    const dtmf = await scenario.receiveProviderEvent("handshake-001", {
      attempt: 1,
      deliveryId: "delivery-dtmf-001",
      digit: "1",
      kind: "dtmf",
      providerCallId: "raw-outbound-provider-id",
    });
    expect(dtmf.actions).toEqual([
      {
        effectId: "effect-confirmation-001",
        kind: "play-confirmation",
        text: "Telephone confirmed. Your secure session is ready.",
      },
    ]);

    const record = await scenario.readEvidenceRecord("handshake-001");
    expect(record).toMatchObject({
      session: {
        attempt: 1,
        authorizedAt: "2026-08-16T14:00:00.000Z",
        id: "telephone-session-001",
        outcome: "authorized",
      },
      task: {
        conclusion: "Telephone Session authorized.",
        id: "handshake-001",
        kind: "callback.handshake",
        status: "completed",
      },
    });
    expect(record?.evidence.map((event) => event.kind)).toEqual([
      "telephone.inbound.received",
      "telephone.inbound.notice",
      "telephone.callback.requested",
      "telephone.machine.detected",
      "telephone.dtmf.received",
      "telephone.callback.outcome",
      "telephone.session.authorized",
    ]);
    expect(JSON.stringify(record)).not.toContain("+12155550123");
    expect(JSON.stringify(record)).not.toContain("raw-inbound-provider-id");
    expect(JSON.stringify(record)).not.toContain("raw-outbound-provider-id");

    await expect(scenario.readTaskPage("handshake-001")).resolves.toMatchObject({
      html: "",
      statusCode: 401,
    });
    const ownerPage = await scenario.readTaskPage(
      "handshake-001",
      "scenario-trusted-session",
    );
    expect(ownerPage.statusCode).toBe(200);
    expect(ownerPage.html).toContain("Telephone Session authorized.");
    expect(ownerPage.html).toContain("Sanitized evidence timeline");
    expect(ownerPage.html).toContain(
      "Human detection and DTMF 1 authorized the Telephone Session.",
    );
    expect(ownerPage.html).not.toContain("+12155550123");
    expect(ownerPage.html).not.toContain("raw-inbound-provider-id");
    expect(ownerPage.html).not.toContain("raw-outbound-provider-id");
    await expect(scenario.readOperationalMetrics()).resolves.toEqual({
      attempts: 1,
      handshakes: { authorized: 1, failed: 0, pending: 0 },
    });
    const metrics = await scenario.readMetrics();
    expect(metrics).toContain(
      'voice_agent_callback_handshakes{outcome="authorized"} 1',
    );
    expect(metrics).toContain("voice_agent_callback_attempts 1");

    const providerFailure = {
      details: {
        failure: "timeout" as const,
        provider: "assemblyai",
        stage: "stt" as const,
        timeoutMs: 5_000,
      },
      id: "authorized-session-stt-timeout",
      kind: "telephone.provider.failure" as const,
      occurredAt: "2026-08-16T14:01:00.000Z",
      summary: "A speech provider exceeded its bounded timeout.",
    };
    await scenario.appendTelephoneSessionEvidence(
      "handshake-001",
      providerFailure,
    );
    await scenario.appendTelephoneSessionEvidence(
      "handshake-001",
      providerFailure,
    );
    await scenario.requestTelephoneSessionFailureNotification(
      "handshake-001",
      {
        failureEventId: providerFailure.id,
        occurredAt: providerFailure.occurredAt,
      },
    );
    const failedProviderRecord =
      await scenario.readEvidenceRecord("handshake-001");
    expect(
      failedProviderRecord?.evidence.slice(-2).map((event) => event.kind),
    ).toEqual(["telephone.provider.failure", "notification.requested"]);
    expect(
      failedProviderRecord?.evidence.filter(
        (event) => event.id === providerFailure.id,
      ),
    ).toHaveLength(1);
    const providerFailurePage = await scenario.readTaskPage(
      "handshake-001",
      "scenario-trusted-session",
    );
    expect(providerFailurePage.html).toContain("Speech provider failure");
    expect(providerFailurePage.html).toContain("Silent Notification requested");
  } finally {
    await scenario.close();
  }
});

test("an unanswered callback retries once after 30 seconds then requests one generic Silent Notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-retry-"));
  temporaryDirectories.push(directory);
  const scenario = await createCallbackHandshakeScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: Array.from({ length: 24 }, (_, index) => `retry-id-${index + 1}`),
    now: "2026-08-16T15:00:00.000Z",
    registeredTelephone: {
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    },
  });

  try {
    const inbound = await scenario.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "retry-inbound",
      inboundTrunkId: "ST_inbound",
      providerCallId: "retry-inbound-call",
    });
    const handshakeId = inbound.handshakeId;
    expect(handshakeId).toBe("retry-id-1");

    await scenario.receiveProviderEvent(handshakeId!, {
      attempt: 1,
      deliveryId: "retry-ended-1",
      kind: "ended",
      outcome: "unanswered",
      providerCallId: "retry-outbound-call-1",
    });

    await scenario.registerTelephone({
      livekitInboundTrunkId: "ST_new_inbound",
      livekitOutboundTrunkId: "ST_new_outbound",
      telephoneNumber: "+12675550123",
      telnyxNumber: "+12675550999",
    });

    scenario.setTime("2026-08-16T15:00:29.999Z");
    expect(await scenario.processDueRetries()).toEqual([]);

    scenario.setTime("2026-08-16T15:00:30.000Z");
    const retry = await scenario.processDueRetries();
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({
      handshakeId,
      result: {
        actions: [
          {
            attempt: 2,
            destination: "+12155550123",
            from: "+12155550999",
            kind: "place-callback",
            livekitOutboundTrunkId: "ST_outbound",
          },
        ],
      },
    });
    expect(await scenario.processDueRetries()).toEqual([]);

    const exhausted = await scenario.receiveProviderEvent(handshakeId!, {
      attempt: 2,
      deliveryId: "retry-ended-2",
      kind: "ended",
      outcome: "unanswered",
      providerCallId: "retry-outbound-call-2",
    });
    expect(exhausted.actions.map((action) => action.kind)).toEqual([
      "end-call",
      "request-silent-notification",
    ]);

    const record = await scenario.readEvidenceRecord(handshakeId!);
    expect(record).toMatchObject({
      session: { attempt: 2, outcome: "failed" },
      task: {
        conclusion: "Callback Handshake failed.",
        status: "completed",
      },
    });
    expect(
      record?.evidence.filter((event) => event.kind === "telephone.callback.requested"),
    ).toHaveLength(2);
    expect(
      record?.evidence.filter((event) => event.kind === "notification.requested"),
    ).toHaveLength(1);
  } finally {
    await scenario.close();
  }
});

test("unknown, malformed, spoofed-route, and rate-limited inbound calls receive no callback or information", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-inbound-policy-"));
  temporaryDirectories.push(directory);
  const scenario = await createCallbackHandshakeScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: Array.from({ length: 24 }, (_, index) => `policy-id-${index + 1}`),
    maximumAcceptedInWindow: 1,
    now: "2026-08-16T16:00:00.000Z",
    registeredTelephone: {
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    },
  });
  const rejected = { actions: [], disposition: "reject" };

  try {
    await expect(
      scenario.receiveInbound({
        calledNumber: "+12155550999",
        callerNumber: "+12155550000",
        deliveryId: "unknown-caller",
        inboundTrunkId: "ST_inbound",
        providerCallId: "unknown-call",
      }),
    ).resolves.toEqual(rejected);
    await expect(
      scenario.receiveInbound({
        calledNumber: "+12155550999",
        callerNumber: "not-a-number",
        deliveryId: "malformed-caller",
        inboundTrunkId: "ST_inbound",
        providerCallId: "malformed-call",
      }),
    ).resolves.toEqual(rejected);
    await expect(
      scenario.receiveInbound({
        calledNumber: "+12155550999",
        callerNumber: "+12155550123",
        deliveryId: "spoofed-route",
        inboundTrunkId: "ST_attacker",
        providerCallId: "spoofed-call",
      }),
    ).resolves.toEqual(rejected);

    const accepted = await scenario.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "accepted-once",
      inboundTrunkId: "ST_inbound",
      providerCallId: "accepted-call",
    });
    expect(accepted.disposition).toBe("notice-and-callback");

    const limited = await scenario.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "rate-limited",
      inboundTrunkId: "ST_inbound",
      providerCallId: "limited-call",
    });
    expect(limited).toEqual(rejected);
    await expect(
      scenario.receiveInbound({
        calledNumber: "+12155550999",
        callerNumber: "+12155550123",
        deliveryId: "rate-limited",
        inboundTrunkId: "ST_inbound",
        providerCallId: "limited-call",
      }),
    ).resolves.toEqual(rejected);
  } finally {
    await scenario.close();
  }
});

test("reordered and duplicate provider events attach to one authorized Telephone Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-reordered-"));
  temporaryDirectories.push(directory);
  const scenario = await createCallbackHandshakeScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: Array.from({ length: 16 }, (_, index) => `reordered-id-${index + 1}`),
    now: "2026-08-16T17:00:00.000Z",
    registeredTelephone: {
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    },
  });

  try {
    const inbound = await scenario.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "reordered-inbound",
      inboundTrunkId: "ST_inbound",
      providerCallId: "reordered-inbound-call",
    });
    const handshakeId = inbound.handshakeId!;
    await expect(
      scenario.receiveInbound({
        calledNumber: "+12155550999",
        callerNumber: "+12155550123",
        deliveryId: "reordered-inbound",
        inboundTrunkId: "ST_inbound",
        providerCallId: "reordered-inbound-call",
      }),
    ).resolves.toEqual({
      actions: [
        {
          effectId: inbound.actions[0]!.effectId,
          kind: "play-inbound-notice-and-end",
          text: "Thanks. I’ll call your registered telephone back now.",
        },
      ],
      disposition: "notice-and-callback",
      handshakeId,
    });

    const earlyDtmf = await scenario.receiveProviderEvent(handshakeId, {
      attempt: 1,
      deliveryId: "reordered-dtmf",
      digit: "1",
      kind: "dtmf",
      providerCallId: "reordered-outbound-call",
    });
    expect(earlyDtmf.actions).toEqual([]);

    const human = await scenario.receiveProviderEvent(handshakeId, {
      attempt: 1,
      classification: "human",
      deliveryId: "reordered-machine",
      kind: "machine-detection",
      providerCallId: "reordered-outbound-call",
    });
    expect(human.actions.map((action) => action.kind)).toEqual([
      "play-confirmation",
    ]);
    await expect(
      scenario.receiveProviderEvent(handshakeId, {
        attempt: 1,
        classification: "human",
        deliveryId: "reordered-machine",
        kind: "machine-detection",
        providerCallId: "reordered-outbound-call",
      }),
    ).resolves.toEqual(human);

    const record = await scenario.readEvidenceRecord(handshakeId);
    expect(
      record?.evidence.filter(
        (event) => event.kind === "telephone.session.authorized",
      ),
    ).toHaveLength(1);
    expect(record?.session.id).toBe("reordered-id-2");
  } finally {
    await scenario.close();
  }
});

test("speech, bad DTMF, and voicemail never authorize or receive commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-voicemail-"));
  temporaryDirectories.push(directory);
  const scenario = await createCallbackHandshakeScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: Array.from({ length: 24 }, (_, index) => `voicemail-id-${index + 1}`),
    now: "2026-08-16T18:00:00.000Z",
    registeredTelephone: {
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    },
  });

  try {
    const inbound = await scenario.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "voicemail-inbound",
      inboundTrunkId: "ST_inbound",
      providerCallId: "voicemail-inbound-call",
    });
    const handshakeId = inbound.handshakeId!;

    await expect(
      scenario.receiveProviderEvent(handshakeId, {
        attempt: 1,
        deliveryId: "voicemail-speech",
        kind: "speech",
        providerCallId: "voicemail-outbound-call",
      }),
    ).resolves.toEqual({ actions: [] });
    await expect(
      scenario.receiveProviderEvent(handshakeId, {
        attempt: 1,
        deliveryId: "voicemail-bad-dtmf",
        digit: "9",
        kind: "dtmf",
        providerCallId: "voicemail-outbound-call",
      }),
    ).resolves.toEqual({ actions: [] });

    const machine = await scenario.receiveProviderEvent(handshakeId, {
      attempt: 1,
      classification: "machine",
      deliveryId: "voicemail-machine",
      kind: "machine-detection",
      providerCallId: "voicemail-outbound-call",
    });
    expect(machine.actions.map((action) => action.kind)).toEqual([
      "end-call",
      "request-silent-notification",
    ]);
    expect(JSON.stringify(machine)).not.toContain("message");
    expect(JSON.stringify(machine)).not.toContain("command");

    const record = await scenario.readEvidenceRecord(handshakeId);
    expect(record?.session.outcome).toBe("failed");
    expect(
      record?.evidence.some(
        (event) => event.kind === "telephone.session.authorized",
      ),
    ).toBe(false);
    expect(
      record?.evidence.some(
        (event) =>
          event.kind === "telephone.callback.outcome" &&
          event.details.outcome === "voicemail",
      ),
    ).toBe(true);
  } finally {
    await scenario.close();
  }
});

test("Callback Handshake evidence expires from the authenticated record window after 90 days", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-callback-retention-"));
  temporaryDirectories.push(directory);
  const scenario = await createCallbackHandshakeScenario({
    databasePath: join(directory, "voice-agent.sqlite"),
    ids: Array.from({ length: 8 }, (_, index) => `expired-id-${index + 1}`),
    now: "2020-01-01T00:00:00.000Z",
    registeredTelephone: {
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    },
  });

  try {
    const inbound = await scenario.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "expired-inbound",
      inboundTrunkId: "ST_inbound",
      providerCallId: "expired-provider-call",
    });
    await expect(
      scenario.readEvidenceRecord(inbound.handshakeId!),
    ).resolves.toBeUndefined();
  } finally {
    await scenario.close();
  }
});
