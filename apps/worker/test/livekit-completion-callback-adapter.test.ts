import { expect, test } from "vitest";

import { createLiveKitCompletionCallbackAdapter } from "../src/livekit-completion-callback-adapter.ts";

test("the completion adapter dispatches one callback with the Durable Task identity", async () => {
  const dispatches: unknown[] = [];
  const calls: unknown[] = [];
  const claims = new Set<string>();
  const adapter = createLiveKitCompletionCallbackAdapter({
    agentName: "voice-agent-telephone",
    dispatch: {
      async createDispatch(roomName, agentName, options) {
        dispatches.push({ agentName, metadata: options.metadata, roomName });
      },
    },
    placementClaims: {
      async claimCompletionCallbackPlacement(effectId) {
        if (claims.has(effectId)) return false;
        claims.add(effectId);
        return true;
      },
    },
    sip: {
      async createSipParticipant(trunkId, destination, roomName, options) {
        calls.push({ destination, options, roomName, trunkId });
        return {
          participantIdentity: options.participantIdentity,
          sipCallId: "provider-completion-call",
        };
      },
    },
  });

  const action = {
    destination: "+12025550123",
    effectId: "completion-operation-001",
    from: "+12025550124",
    kind: "place-completion-callback" as const,
    livekitOutboundTrunkId: "livekit-outbound",
    operationId: "completion-operation-001",
    taskId: "task-001",
    telephoneSessionId: "telephone-session-original",
  };
  await expect(adapter.placeCallback(action)).resolves.toMatchObject({
    sipCallId: "provider-completion-call",
  });
  await expect(adapter.placeCallback(action)).rejects.toThrow(
    "Completion Callback placement was already claimed",
  );
  await expect(
    adapter.resumeCallback({
      callbackOperationId: "completion-operation-001",
      effectId: "completion-resumption-001",
      kind: "resume-completion-callback",
      operationId: "completion-resumption-001",
      taskId: "task-001",
      telephoneSessionId: "telephone-session-resumed",
    }),
  ).resolves.toBeUndefined();
  await expect(
    adapter.resumeCallback({
      callbackOperationId: "completion-operation-001",
      effectId: "completion-resumption-001",
      kind: "resume-completion-callback",
      operationId: "completion-resumption-001",
      taskId: "task-001",
      telephoneSessionId: "telephone-session-resumed",
    }),
  ).rejects.toThrow("Completion Callback resumption was already claimed");
  expect(dispatches).toEqual([
    {
      agentName: "voice-agent-telephone",
      metadata: JSON.stringify({
        effectId: "completion-operation-001",
        kind: "completion-callback",
        operationId: "completion-operation-001",
        participantIdentity: "completion-operation-001",
        taskId: "task-001",
        telephoneSessionId: "telephone-session-original",
      }),
      roomName: "completion-callback-task-001",
    },
    {
      agentName: "voice-agent-telephone",
      metadata: JSON.stringify({
        effectId: "completion-resumption-001",
        kind: "completion-resumption",
        operationId: "completion-operation-001",
        participantIdentity: "completion-operation-001",
        resumptionOperationId: "completion-resumption-001",
        taskId: "task-001",
        telephoneSessionId: "telephone-session-resumed",
      }),
      roomName: "completion-callback-task-001",
    },
  ]);
  expect(calls).toHaveLength(1);
});
