import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createCallbackHandshakeRuntime } from "@voice-agent/runtime";
import { createSqliteCallbackHandshakeStore } from "@voice-agent/sqlite-store";

test("callback placement claims survive restart and are atomically unique", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-placement-claim-"));
  const databasePath = join(directory, "voice-agent.sqlite");
  const identifiers = [
    "handshake-001",
    "telephone-session-001",
    "callback-operation-001",
    "event-inbound-001",
    "event-notice-001",
    "event-callback-001",
    "effect-notice-001",
    "effect-callback-001",
  ];
  const firstStore = createSqliteCallbackHandshakeStore(databasePath);
  const runtime = createCallbackHandshakeRuntime({
    nextId() {
      const identifier = identifiers.shift();
      if (identifier === undefined) throw new Error("Identifier fixture exhausted");
      return identifier;
    },
    now: () => "2026-08-17T12:00:00.000Z",
    store: firstStore,
  });

  try {
    await runtime.registerTelephone({
      livekitInboundTrunkId: "ST_inbound",
      livekitOutboundTrunkId: "ST_outbound",
      telephoneNumber: "+12155550123",
      telnyxNumber: "+12155550999",
    });
    const inbound = await runtime.receiveInbound({
      calledNumber: "+12155550999",
      callerNumber: "+12155550123",
      deliveryId: "delivery-inbound-001",
      inboundTrunkId: "ST_inbound",
      providerCallId: "provider-inbound-001",
    });
    const callback = inbound.actions.find(
      (action) => action.kind === "place-callback",
    );
    if (callback === undefined || inbound.handshakeId === undefined) {
      throw new Error("Accepted inbound call did not request a callback");
    }

    await expect(
      firstStore.claimCallbackPlacement(
        callback.effectId,
        inbound.handshakeId,
      ),
    ).resolves.toBe(true);
    await runtime.close();

    const restartedStore = createSqliteCallbackHandshakeStore(databasePath);
    const concurrentStore = createSqliteCallbackHandshakeStore(databasePath);
    try {
      await expect(
        restartedStore.claimCallbackPlacement(
          callback.effectId,
          inbound.handshakeId,
        ),
      ).resolves.toBe(false);
      await expect(
        Promise.all([
          restartedStore.claimCallbackPlacement(
            "effect-callback-concurrent",
            inbound.handshakeId,
          ),
          concurrentStore.claimCallbackPlacement(
            "effect-callback-concurrent",
            inbound.handshakeId,
          ),
        ]),
      ).resolves.toEqual(expect.arrayContaining([true, false]));
    } finally {
      await restartedStore.close();
      await concurrentStore.close();
    }
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
  }
});
