import type {
  BountywellCompletionReports,
  createCallbackHandshakeRuntime,
  createTaskContinuityRuntime,
} from "@voice-agent/runtime";

/**
 * The agreed completion report for a recovered Bountywell Outage Drill: a
 * Completion Callback to the Registered Telephone, which falls back to a Silent
 * Notification when it goes unanswered. The drill runs only while a Telephone
 * Session carries the owner, so a missing Registered Telephone is a fault worth
 * failing on rather than a drill that concludes without telling anyone.
 */
export function createBountywellCompletionReports(dependencies: {
  readonly callbacks: Pick<
    ReturnType<typeof createCallbackHandshakeRuntime>,
    "findRegisteredTelephone"
  >;
  readonly continuity: Pick<
    ReturnType<typeof createTaskContinuityRuntime>,
    "requestCompletionCallback"
  >;
}): BountywellCompletionReports {
  return {
    async requestBountywellCompletionReport(input) {
      const telephone = await dependencies.callbacks.findRegisteredTelephone();
      if (telephone === undefined) {
        throw new Error("Registered Telephone is unavailable");
      }
      await dependencies.continuity.requestCompletionCallback({
        ...input,
        telephone,
        telephoneSessionId: `completion:${input.taskId}`,
      });
    },
  };
}
