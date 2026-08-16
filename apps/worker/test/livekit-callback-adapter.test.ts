import { expect, test } from "vitest";

import { createLiveKitCallbackAdapter } from "../src/livekit-callback-adapter.ts";

test("the LiveKit adapter dials the stored Telnyx route once with stable callback identities", async () => {
  const dispatches: Array<{
    readonly agentName: string;
    readonly metadata: string;
    readonly roomName: string;
  }> = [];
  const calls: Array<{
    readonly destination: string;
    readonly options: unknown;
    readonly roomName: string;
    readonly trunkId: string;
  }> = [];
  let participantExists = false;
  const adapter = createLiveKitCallbackAdapter({
    agentName: "voice-agent-telephone",
    dispatch: {
      async createDispatch(roomName, agentName, options) {
        dispatches.push({
          agentName,
          metadata: options.metadata,
          roomName,
        });
      },
      async listDispatch() {
        return dispatches;
      },
    },
    rooms: {
      async findParticipant() {
        return participantExists
          ? {
              participantIdentity: "callback-operation-001",
              sipCallId: "provider-call-001",
            }
          : undefined;
      },
    },
    sip: {
      async createSipParticipant(trunkId, destination, roomName, options) {
        calls.push({ destination, options, roomName, trunkId });
        participantExists = true;
        return {
          participantIdentity: "callback-operation-001",
          sipCallId: "provider-call-001",
        };
      },
    },
  });
  const action = {
    attempt: 1 as const,
    destination: "+12155550123",
    effectId: "callback-effect-001",
    from: "+12155550999",
    kind: "place-callback" as const,
    livekitOutboundTrunkId: "ST_outbound",
    participantIdentity: "callback-operation-001",
    roomName: "callback-handshake-handshake-001",
  };

  await expect(adapter.placeCallback(action)).resolves.toEqual({
    participantIdentity: "callback-operation-001",
    sipCallId: "provider-call-001",
  });
  await expect(adapter.placeCallback(action)).resolves.toEqual({
    participantIdentity: "callback-operation-001",
    sipCallId: "provider-call-001",
  });

  expect(dispatches).toHaveLength(1);
  expect(JSON.parse(dispatches[0]!.metadata)).toEqual({
    attempt: 1,
    effectId: "callback-effect-001",
    handshakeId: "handshake-001",
    kind: "outbound-callback",
    participantIdentity: "callback-operation-001",
  });
  expect(calls).toEqual([
    {
      destination: "+12155550123",
      options: {
        fromNumber: "+12155550999",
        maxCallDuration: 120,
        participantAttributes: {
          "voice.callback.attempt": "1",
          "voice.callback.effectId": "callback-effect-001",
          "voice.callback.handshakeId": "handshake-001",
        },
        participantIdentity: "callback-operation-001",
        participantName: "Voice Agent authentication callback",
        ringingTimeout: 25,
        waitUntilAnswered: true,
      },
      roomName: "callback-handshake-handshake-001",
      trunkId: "ST_outbound",
    },
  ]);
});
