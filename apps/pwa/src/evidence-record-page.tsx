import type {
  PromotionEvidenceRecordProjection,
  TelephoneSessionEvidenceRecordProjection,
  VoiceAgentEvidenceRecordProjection,
} from "@voice-agent/contracts";

import { CallbackTaskPage } from "./callback-task-page.tsx";
import { PromotionTaskPage } from "./promotion-task-page.tsx";
import { TaskPage } from "./task-page.tsx";

export function EvidenceRecordPage({
  record,
}: {
  readonly record: VoiceAgentEvidenceRecordProjection;
}) {
  if (isPromotionRecord(record)) return <PromotionTaskPage record={record} />;
  if (isCallbackRecord(record)) return <CallbackTaskPage record={record} />;
  return <TaskPage record={record} />;
}

function isPromotionRecord(
  record: VoiceAgentEvidenceRecordProjection,
): record is PromotionEvidenceRecordProjection {
  return record.task.kind === "human-merge.promotion";
}

function isCallbackRecord(
  record: VoiceAgentEvidenceRecordProjection,
): record is TelephoneSessionEvidenceRecordProjection {
  return record.task.kind === "callback.handshake";
}
