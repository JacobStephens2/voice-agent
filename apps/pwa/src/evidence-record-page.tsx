import type {
  KeeploreOnboardingEvidenceRecordProjection,
  PromotionEvidenceRecordProjection,
  TelephoneSessionEvidenceRecordProjection,
  VoiceAgentEvidenceRecordProjection,
} from "@voice-agent/contracts";

import { CallbackTaskPage } from "./callback-task-page.tsx";
import { KeeploreOnboardingTaskPage } from "./keeplore-onboarding-task-page.tsx";
import { PromotionTaskPage } from "./promotion-task-page.tsx";
import { TaskPage } from "./task-page.tsx";

export function EvidenceRecordPage({
  record,
}: {
  readonly record: VoiceAgentEvidenceRecordProjection;
}) {
  if (isPromotionRecord(record)) return <PromotionTaskPage record={record} />;
  if (isKeeploreOnboardingRecord(record)) {
    return <KeeploreOnboardingTaskPage record={record} />;
  }
  if (isCallbackRecord(record)) return <CallbackTaskPage record={record} />;
  return <TaskPage record={record} />;
}

function isPromotionRecord(
  record: VoiceAgentEvidenceRecordProjection,
): record is PromotionEvidenceRecordProjection {
  return record.task.kind === "human-merge.promotion";
}

function isKeeploreOnboardingRecord(
  record: VoiceAgentEvidenceRecordProjection,
): record is KeeploreOnboardingEvidenceRecordProjection {
  return record.task.kind === "keeplore.onboarding";
}

function isCallbackRecord(
  record: VoiceAgentEvidenceRecordProjection,
): record is TelephoneSessionEvidenceRecordProjection {
  return record.task.kind === "callback.handshake";
}
