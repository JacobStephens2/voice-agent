import { renderToStaticMarkup } from "react-dom/server";

import type {
  EvidenceRecordProjection,
  PromotionEvidenceRecordProjection,
} from "@voice-agent/contracts";
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
