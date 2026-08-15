import { renderToStaticMarkup } from "react-dom/server";

import type { EvidenceRecordProjection } from "@voice-agent/contracts";
import { TaskPage } from "./task-page.tsx";

export function renderTaskPage(record: EvidenceRecordProjection): string {
  return renderToStaticMarkup(<TaskPage record={record} />);
}
