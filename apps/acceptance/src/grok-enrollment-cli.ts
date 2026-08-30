import {
  appendGrokEnrollmentEvent,
  createGrokEnrollmentRecord,
  evaluateGrokEnrollment,
  markGrokEnrollmentAccepted,
  parseGrokEnrollmentRecord,
  type GrokEnrollmentRecord,
} from "@voice-agent/contracts";
import {
  parseOptions,
  requireOnlyOptions,
  requiredBooleanOption,
  requiredIntegerOption,
  requiredOption,
} from "./cli-options.ts";
import {
  createRecordFile,
  readRecordFile,
  updateRecordFile,
} from "./record-file.ts";

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

if (command === "init") {
  requireOnlyOptions(options, ["campaign-id", "record"]);
  const recordPath = requiredOption(options, "record");
  await createRecordFile(
    recordPath,
    createGrokEnrollmentRecord({
      campaignId: requiredOption(options, "campaign-id"),
    }),
  );
  process.stdout.write(`Initialized ${recordPath}\n`);
} else if (command === "record-runner-pin") {
  requireOnlyOptions(options, [
    "configuration-path",
    "digest",
    "record",
    "recorded-at",
    "version",
  ]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendGrokEnrollmentEvent(record, {
      configurationPath: requiredOption(options, "configuration-path"),
      digest: requiredOption(options, "digest"),
      kind: "runner-pinned",
      recordedAt: requiredOption(options, "recorded-at"),
      selfUpdateDisabled: true,
      version: requiredOption(options, "version"),
    }));
} else if (command === "record-enrollment") {
  requireOnlyOptions(options, ["code-retention-disabled", "record", "recorded-at"]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendGrokEnrollmentEvent(record, {
      apiKeyAbsent: true,
      authenticationRoute: "subscription-oauth",
      codeRetentionDisabled: requiredBooleanOption(
        options,
        "code-retention-disabled",
      ),
      kind: "subscription-enrolled",
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else if (command === "record-contract-run") {
  requireOnlyOptions(options, [
    "configuration-path",
    "digest",
    "model",
    "record",
    "recorded-at",
    "session",
    "stop-reason",
    "usage-incomplete",
    "version",
  ]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendGrokEnrollmentEvent(record, {
      authenticationRoute: "subscription-oauth",
      kind: "contract-run",
      model: requiredOption(options, "model"),
      recordedAt: requiredOption(options, "recorded-at"),
      runner: {
        configurationPath: requiredOption(options, "configuration-path"),
        digest: requiredOption(options, "digest"),
        version: requiredOption(options, "version"),
      },
      sessionId: requiredOption(options, "session"),
      stopReason: requiredOption(options, "stop-reason"),
      usageIncomplete: requiredBooleanOption(options, "usage-incomplete"),
    }));
} else if (command === "record-custody-probe") {
  requireOnlyOptions(options, [
    "canary-secrets-found",
    "readable-boundary-paths",
    "record",
    "recorded-at",
  ]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendGrokEnrollmentEvent(record, {
      canarySecretsFound: requiredIntegerOption(options, "canary-secrets-found"),
      kind: "custody-probe",
      readableBoundaryPaths: requiredIntegerOption(
        options,
        "readable-boundary-paths",
      ),
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else if (command === "record-failure-drill") {
  requireOnlyOptions(options, [
    "condition",
    "fell-back",
    "outcome",
    "record",
    "recorded-at",
  ]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendGrokEnrollmentEvent(record, {
      condition: requiredOption(options, "condition"),
      fellBackToAnotherProvider: requiredBooleanOption(options, "fell-back"),
      kind: "failure-drill",
      outcome: requiredOption(options, "outcome"),
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else if (command === "record-stop-drill") {
  requireOnlyOptions(options, [
    "commits-preserved",
    "destructive-git-commands",
    "record",
    "recorded-at",
    "unfinished-work-preserved",
  ]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendGrokEnrollmentEvent(record, {
      commitsPreserved: requiredBooleanOption(options, "commits-preserved"),
      destructiveGitCommands: requiredIntegerOption(
        options,
        "destructive-git-commands",
      ),
      kind: "stop-drill",
      recordedAt: requiredOption(options, "recorded-at"),
      unfinishedWorkPreserved: requiredBooleanOption(
        options,
        "unfinished-work-preserved",
      ),
    }));
} else if (command === "status") {
  requireOnlyOptions(options, ["record"]);
  const evaluation = evaluateGrokEnrollment(
    await readRecord(requiredOption(options, "record")),
  );
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (!evaluation.ready) process.exitCode = 1;
} else if (command === "accept") {
  requireOnlyOptions(options, ["record", "recorded-at"]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    markGrokEnrollmentAccepted(record, {
      recordedAt: requiredOption(options, "recorded-at"),
    }));
} else {
  throw new Error(
    "Usage: grok-enrollment-cli.ts <init|record-runner-pin|record-enrollment|record-contract-run|record-custody-probe|record-failure-drill|record-stop-drill|status|accept> [options]",
  );
}

async function readRecord(recordPath: string): Promise<GrokEnrollmentRecord> {
  return readRecordFile(recordPath, parseGrokEnrollmentRecord);
}

async function updateRecord(
  recordPath: string,
  update: (record: GrokEnrollmentRecord) => GrokEnrollmentRecord,
): Promise<void> {
  await updateRecordFile(recordPath, parseGrokEnrollmentRecord, update);
}
