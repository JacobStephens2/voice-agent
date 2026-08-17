import { expect, test } from "vitest";

import { createLiveKitCallbackAdapter } from "../src/livekit-callback-adapter.ts";

const callbackAction = {
  attempt: 1 as const,
  destination: "+12155550123",
  effectId: "callback-effect-001",
  from: "+12155550999",
  kind: "place-callback" as const,
  livekitOutboundTrunkId: "ST_outbound",
  participantIdentity: "callback-operation-001",
  roomName: "callback-handshake-handshake-001",
};

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
  const placementClaims = new Set<string>();
  const adapter = createLiveKitCallbackAdapter({
    agentName: "voice-agent-telephone",
    placementClaims: {
      async claimCallbackPlacement(effectId) {
        if (placementClaims.has(effectId)) return false;
        placementClaims.add(effectId);
        return true;
      },
    },
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
  await expect(adapter.placeCallback(callbackAction)).resolves.toEqual({
    participantIdentity: "callback-operation-001",
    sipCallId: "provider-call-001",
  });
  await expect(adapter.placeCallback(callbackAction)).resolves.toEqual({
    participantIdentity: "callback-operation-001",
    sipCallId: "provider-call-001",
  });

  expect(dispatches).toHaveLength(1);
  expect(placementClaims).toEqual(new Set(["callback-effect-001"]));
  expect(JSON.parse(dispatches[0]!.metadata)).toEqual({
    attempt: 1,
    effectId: "callback-effect-001",
    handshakeId: "handshake-001",
    kind: "outbound-callback",
    participantIdentity: "callback-operation-001",
    placementState: "claimed",
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

test("a missing callback room is treated as having no existing dispatch", async () => {
  let callbackCalls = 0;
  let dispatches = 0;
  let roomExists = false;
  const adapter = createLiveKitCallbackAdapter({
    agentName: "voice-agent-telephone",
    placementClaims: {
      async claimCallbackPlacement() {
        return true;
      },
    },
    dispatch: {
      async createDispatch() {
        dispatches += 1;
        roomExists = true;
      },
      async listDispatch() {
        if (!roomExists) {
          throw Object.assign(new Error("requested room does not exist"), {
            status: 404,
          });
        }
        return [];
      },
    },
    rooms: {
      async findParticipant() {
        return undefined;
      },
    },
    sip: {
      async createSipParticipant() {
        callbackCalls += 1;
        return {
          participantIdentity: "callback-operation-001",
          sipCallId: "provider-call-001",
        };
      },
    },
  });

  await expect(adapter.placeCallback(callbackAction)).resolves.toEqual({
    participantIdentity: "callback-operation-001",
    sipCallId: "provider-call-001",
  });
  expect(dispatches).toBe(1);
  expect(callbackCalls).toBe(1);
});

test("a durable placement claim prevents replay after the callback room is deleted", async () => {
  let callbackCalls = 0;
  let dispatches = 0;
  let dispatchLookups = 0;
  const adapter = createLiveKitCallbackAdapter({
    agentName: "voice-agent-telephone",
    placementClaims: {
      async claimCallbackPlacement() {
        return false;
      },
    },
    dispatch: {
      async createDispatch() {
        dispatches += 1;
      },
      async listDispatch() {
        dispatchLookups += 1;
        throw Object.assign(new Error("requested room does not exist"), {
          status: 404,
        });
      },
    },
    rooms: {
      async findParticipant() {
        return undefined;
      },
    },
    sip: {
      async createSipParticipant() {
        callbackCalls += 1;
        return {
          participantIdentity: "callback-operation-001",
          sipCallId: "provider-call-001",
        };
      },
    },
  });

  await expect(adapter.placeCallback(callbackAction)).rejects.toThrow(
    "Callback placement was already claimed",
  );
  expect(dispatches).toBe(0);
  expect(dispatchLookups).toBe(0);
  expect(callbackCalls).toBe(0);
});
