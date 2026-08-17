import type { CompletionReportOperation } from "@voice-agent/contracts";
import { AgentDispatchClient, SipClient } from "livekit-server-sdk";

type CompletionCallbackOperation = Extract<
  CompletionReportOperation,
  { kind: "place-completion-callback" }
>;
type CompletionResumptionOperation = Extract<
  CompletionReportOperation,
  { kind: "resume-completion-callback" }
>;

export interface LiveKitCompletionCallbackAdapterOptions {
  readonly agentName: string;
  readonly dispatch: {
    createDispatch(
      roomName: string,
      agentName: string,
      options: { readonly metadata: string },
    ): Promise<unknown>;
  };
  readonly placementClaims: {
    claimCompletionCallbackPlacement(
      effectId: string,
      taskId: string,
    ): Promise<boolean>;
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
    ): Promise<{
      readonly participantIdentity: string;
      readonly sipCallId: string;
    }>;
  };
}

export interface LiveKitCompletionCallbackAdapter {
  placeCallback(operation: CompletionCallbackOperation): Promise<{
    readonly participantIdentity: string;
    readonly sipCallId: string;
  }>;
  resumeCallback(operation: CompletionResumptionOperation): Promise<void>;
}

export function createLiveKitCompletionCallbackAdapter(
  options: LiveKitCompletionCallbackAdapterOptions,
): LiveKitCompletionCallbackAdapter {
  return {
    async placeCallback(operation) {
      if (
        !(await options.placementClaims.claimCompletionCallbackPlacement(
          operation.effectId,
          operation.taskId,
        ))
      ) {
        throw new Error("Completion Callback placement was already claimed");
      }
      const participantIdentity = operation.operationId;
      const roomName = `completion-callback-${operation.taskId}`;
      await options.dispatch.createDispatch(roomName, options.agentName, {
        metadata: JSON.stringify({
          effectId: operation.effectId,
          kind: "completion-callback",
          operationId: operation.operationId,
          participantIdentity,
          taskId: operation.taskId,
          telephoneSessionId: operation.telephoneSessionId,
        }),
      });
      return options.sip.createSipParticipant(
        operation.livekitOutboundTrunkId,
        operation.destination,
        roomName,
        {
          fromNumber: operation.from,
          maxCallDuration: 120,
          participantAttributes: {
            "voice.completion.operationId": operation.operationId,
            "voice.completion.taskId": operation.taskId,
          },
          participantIdentity,
          participantName: "Voice Agent completion callback",
          ringingTimeout: 25,
          waitUntilAnswered: true,
        },
      );
    },
    async resumeCallback(operation) {
      if (
        !(await options.placementClaims.claimCompletionCallbackPlacement(
          operation.effectId,
          operation.taskId,
        ))
      ) {
        throw new Error("Completion Callback resumption was already claimed");
      }
      await options.dispatch.createDispatch(
        `completion-callback-${operation.taskId}`,
        options.agentName,
        {
          metadata: JSON.stringify({
            effectId: operation.effectId,
            kind: "completion-resumption",
            operationId: operation.callbackOperationId,
            participantIdentity: operation.callbackOperationId,
            resumptionOperationId: operation.operationId,
            taskId: operation.taskId,
            telephoneSessionId: operation.telephoneSessionId,
          }),
        },
      );
    },
  };
}

export function createProductionLiveKitCompletionCallbackAdapter(input: {
  readonly agentName: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly placementClaims: LiveKitCompletionCallbackAdapterOptions["placementClaims"];
  readonly url: string;
}): LiveKitCompletionCallbackAdapter {
  const dispatch = new AgentDispatchClient(
    input.url,
    input.apiKey,
    input.apiSecret,
  );
  const sip = new SipClient(input.url, input.apiKey, input.apiSecret);
  return createLiveKitCompletionCallbackAdapter({
    agentName: input.agentName,
    dispatch,
    placementClaims: input.placementClaims,
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
