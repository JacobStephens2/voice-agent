import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  evidenceRecordProjectionSchema,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";
import { TaskPage } from "./task-page.tsx";
import "./styles.css";

function App() {
  const [record, setRecord] = useState<EvidenceRecordProjection>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get("task");
    if (taskId === null) {
      setError("Choose a Durable Task to inspect.");
      return;
    }

    void fetch(`/api/tasks/${encodeURIComponent(taskId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("The Durable Task could not be loaded.");
        return evidenceRecordProjectionSchema.parse(await response.json());
      })
      .then(setRecord)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "The task could not be loaded.");
      });
  }, []);

  if (error !== undefined) return <main className="message">{error}</main>;
  if (record === undefined) return <main className="message">Loading Evidence Record…</main>;
  return <TaskPage record={record} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("PWA root element is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
