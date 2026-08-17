import type { CallbackAction } from "@voice-agent/contracts";
import {
  AgentDispatchClient,
  RoomServiceClient,
  SipClient,
} from "livekit-server-sdk";

type PlaceCallbackAction = Extract<CallbackAction, { kind: "place-callback" }>;

export interface LiveKitCallbackCorrelation {
  readonly participantIdentity: string;
  readonly sipCallId: string;
}

export interface LiveKitCallbackAdapter {
  placeCallback(
    action: PlaceCallbackAction,
  ): Promise<LiveKitCallbackCorrelation>;
}

export interface LiveKitCallbackAdapterOptions {
  readonly agentName: string;
  readonly placementClaims: {
    claimCallbackPlacement(
      effectId: string,
      handshakeId: string,
    ): Promise<boolean>;
  };
  readonly dispatch: {
    createDispatch(
      roomName: string,
      agentName: string,
      options: { readonly metadata: string },
    ): Promise<unknown>;
    listDispatch(roomName: string): Promise<readonly { readonly metadata?: string }[]>;
  };
  readonly rooms: {
    findParticipant(
      roomName: string,
      participantIdentity: string,
    ): Promise<LiveKitCallbackCorrelation | undefined>;
  };
  readonly sip: {
    createSipParticipant(
      trunkId: string,
      destination: string,
      roomName: string,
      options: {
        readonly fromNumber: string;
        readonly maxCallDuration: number;
        readonly participantAttributes: Readonly<Record<string, string>>;
        readonly participantIdentity: string;
        readonly participantName: string;
        readonly ringingTimeout: number;
        readonly waitUntilAnswered: boolean;
      },
    ): Promise<LiveKitCallbackCorrelation>;
  };
}

export function createLiveKitCallbackAdapter(
  options: LiveKitCallbackAdapterOptions,
): LiveKitCallbackAdapter {
  return {
    async placeCallback(action) {
      const handshakeId = requireHandshakeId(action.roomName);
      const existingParticipant = await options.rooms.findParticipant(
        action.roomName,
        action.participantIdentity,
      );
      const placementClaimed =
        await options.placementClaims.claimCallbackPlacement(
          action.effectId,
          handshakeId,
        );
      if (existingParticipant !== undefined) return existingParticipant;
      if (!placementClaimed) {
        throw new Error("Callback placement was already claimed");
      }

      const metadata = {
        attempt: action.attempt,
        effectId: action.effectId,
        handshakeId,
        kind: "outbound-callback" as const,
        participantIdentity: action.participantIdentity,
        placementState: "claimed" as const,
      };
      let existingDispatches: readonly { readonly metadata?: string }[];
      try {
        existingDispatches = await options.dispatch.listDispatch(
          action.roomName,
        );
      } catch (error) {
        if (!isProviderNotFound(error)) throw error;
        existingDispatches = [];
      }
      const placementWasClaimed = existingDispatches.some(
        (dispatch) =>
          dispatch.metadata !== undefined &&
          isMatchingDispatch(dispatch.metadata, action.effectId),
      );
      if (placementWasClaimed) {
        throw new Error("Callback placement was already claimed");
      }
      await options.dispatch.createDispatch(
        action.roomName,
        options.agentName,
        { metadata: JSON.stringify(metadata) },
      );

      return options.sip.createSipParticipant(
        action.livekitOutboundTrunkId,
        action.destination,
        action.roomName,
        {
          fromNumber: action.from,
          maxCallDuration: 120,
          participantAttributes: {
            "voice.callback.attempt": String(action.attempt),
            "voice.callback.effectId": action.effectId,
            "voice.callback.handshakeId": handshakeId,
          },
          participantIdentity: action.participantIdentity,
          participantName: "Voice Agent authentication callback",
          ringingTimeout: 25,
          waitUntilAnswered: true,
        },
      );
    },
  };
}

export function createProductionLiveKitCallbackAdapter(input: {
  readonly agentName: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly placementClaims: LiveKitCallbackAdapterOptions["placementClaims"];
  readonly url: string;
}): LiveKitCallbackAdapter {
  const dispatch = new AgentDispatchClient(
    input.url,
    input.apiKey,
    input.apiSecret,
  );
  const rooms = new RoomServiceClient(
    input.url,
    input.apiKey,
    input.apiSecret,
  );
  const sip = new SipClient(input.url, input.apiKey, input.apiSecret);
  return createLiveKitCallbackAdapter({
    agentName: input.agentName,
    dispatch,
    placementClaims: input.placementClaims,
    rooms: {
      async findParticipant(roomName, participantIdentity) {
        try {
          const participant = await rooms.getParticipant(
            roomName,
            participantIdentity,
          );
          return {
            participantIdentity: participant.identity,
            sipCallId: participant.attributes["sip.callID"] ?? participant.sid,
          };
        } catch (error) {
          if (isProviderNotFound(error)) {
            return undefined;
          }
          throw error;
        }
      },
    },
    sip: {
      async createSipParticipant(trunkId, destination, roomName, options) {
        const participant = await sip.createSipParticipant(
          trunkId,
          destination,
          roomName,
          options,
        );
        return {
          participantIdentity: participant.participantIdentity,
          sipCallId: participant.sipCallId,
        };
      },
    },
  });
}

function requireHandshakeId(roomName: string): string {
  const prefix = "callback-handshake-";
  if (!roomName.startsWith(prefix) || roomName.length === prefix.length) {
    throw new Error("Callback room does not contain a durable handshake identity");
  }
  return roomName.slice(prefix.length);
}

function isMatchingDispatch(metadata: string, effectId: string): boolean {
  try {
    const parsed = JSON.parse(metadata) as { readonly effectId?: unknown };
    return parsed.effectId === effectId;
  } catch {
    return false;
  }
}

function isProviderNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "status" in error && error.status === 404
  );
}
