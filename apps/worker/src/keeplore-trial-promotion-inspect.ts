/**
 * Print slice three's terminal Evidence Record for attended review.
 *
 * It joins the three durable sources the trial actually wrote — the Delegation
 * in SQLite, the host's append-only Promotion Attempt journal, and the
 * promoter's own production appearance observation — and reports nothing it
 * cannot read back through their contracts. An owner reading this sees the
 * whole trial or sees plainly which part is missing.
 */
import { readFile } from "node:fs/promises";

import {
  keeploreProductionAppearanceObservationSchema,
  keeploreProductionEvidenceRoot,
  type KeeploreProductionAppearanceObservation,
  type KeeploreTrialCompletionNotice,
} from "@voice-agent/contracts";
import { chooseKeeploreTrialCompletionNotice, decideKeeploreWorktreeLifecycle } from "@voice-agent/policy";
import {
  projectKeeploreButtonTrialEvidenceRecord,
  readPromotionAttempts,
} from "@voice-agent/runtime";
import { createSqliteKeeploreDelegationStore } from "@voice-agent/sqlite-store";

const databasePath =
  process.env.VOICE_AGENT_DATABASE_PATH ??
  "/var/lib/voice-agent/voice-agent.sqlite";
const journalPath =
  process.env.KEEPLORE_PROMOTION_JOURNAL ??
  "/var/lib/keeplore-promotions/attempts.jsonl";
const mergeCommit = process.env.KEEPLORE_MERGE_COMMIT;
if (mergeCommit !== undefined && !/^[0-9a-f]{40}$/u.test(mergeCommit)) {
  process.stderr.write("KEEPLORE_MERGE_COMMIT must be a 40-character commit.\n");
  process.exit(1);
}

const store = createSqliteKeeploreDelegationStore(databasePath);
try {
  const latest = (await store.list()).at(-1);
  if (latest === undefined) {
    process.stderr.write("No Keeplore Button Trial Delegation exists.\n");
    process.exitCode = 1;
  } else {
    const record = projectKeeploreButtonTrialEvidenceRecord({
      appearance: await readAppearance(mergeCommit),
      attempts: readPromotionAttempts(await readOptionalFile(journalPath)),
      delegation: latest,
      mergeCommit,
      notice: readNotice(),
      ...(latest.delegation.result === undefined
        ? {}
        : {
            worktree: {
              ...decideKeeploreWorktreeLifecycle({
                pullRequestState: readPullRequestState(),
                result: latest.delegation.result,
              }),
              observedAt: new Date().toISOString(),
            },
          }),
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    if (record.task.status !== "completed") process.exitCode = 1;
  }
} finally {
  store.close();
}

async function readAppearance(
  commit: string | undefined,
): Promise<KeeploreProductionAppearanceObservation | undefined> {
  if (commit === undefined) return undefined;
  const report = await readOptionalFile(
    `${keeploreProductionEvidenceRoot}${commit}/appearance.json`,
  );
  if (report === "") return undefined;
  const parsed = keeploreProductionAppearanceObservationSchema.safeParse(
    (JSON.parse(report) as { readonly observation?: unknown }).observation,
  );
  return parsed.success ? parsed.data : undefined;
}

function readNotice(): KeeploreTrialCompletionNotice | undefined {
  const outcome = process.env.KEEPLORE_COMPLETION_CALLBACK;
  const evidenceRecordUrl = process.env.VOICE_AGENT_EVIDENCE_RECORD_URL;
  if (outcome === undefined || evidenceRecordUrl === undefined) return undefined;
  if (
    outcome !== "authorized" &&
    outcome !== "failed" &&
    outcome !== "not-requested" &&
    outcome !== "unanswered" &&
    outcome !== "voicemail"
  ) {
    throw new Error("KEEPLORE_COMPLETION_CALLBACK names no known callback outcome");
  }
  return chooseKeeploreTrialCompletionNotice({
    callback: { outcome },
    evidenceRecordUrl,
  });
}

function readPullRequestState(): "closed" | "merged" | "open" {
  const state = process.env.KEEPLORE_PULL_REQUEST_STATE ?? "open";
  if (state !== "closed" && state !== "merged" && state !== "open") {
    throw new Error("KEEPLORE_PULL_REQUEST_STATE names no known pull-request state");
  }
  return state;
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
