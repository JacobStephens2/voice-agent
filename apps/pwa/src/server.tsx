import { renderToStaticMarkup } from "react-dom/server";

import type {
  EvidenceRecordProjection,
  PromotionEvidenceRecordProjection,
  TelephoneSessionEvidenceRecordProjection,
  VoiceAgentEvidenceRecordProjection,
} from "@voice-agent/contracts";
import { CallbackTaskPage } from "./callback-task-page.tsx";
import { EvidenceRecordPage } from "./evidence-record-page.tsx";
import { PromotionTaskPage } from "./promotion-task-page.tsx";
import { TaskPage } from "./task-page.tsx";

export function renderTaskPage(record: EvidenceRecordProjection): string {
  return renderToStaticMarkup(<TaskPage record={record} />);
}

export function renderPromotionTaskPage(
  record: PromotionEvidenceRecordProjection,
): string {
  return renderToStaticMarkup(<PromotionTaskPage record={record} />);
}

export function renderCallbackTaskPage(
  record: TelephoneSessionEvidenceRecordProjection,
): string {
  return renderToStaticMarkup(<CallbackTaskPage record={record} />);
}

export function renderEvidenceRecordPage(
  record: VoiceAgentEvidenceRecordProjection,
): string {
  return renderToStaticMarkup(<EvidenceRecordPage record={record} />);
}
