import { readFile } from "node:fs/promises";

import {
  administrativePolicyObservationFromAuthenticatedApi,
  appendAdministrativeAutonomyRestartEvent,
  createAdministrativeAutonomyRestartRecord,
  evaluateAdministrativeAutonomyRestartWitness,
  parseAdministrativeAutonomyRestartRecord,
  type AdministrativeAutonomyRestartRecord,
} from "./index.ts";
import {
  parseOptions,
  requireOnlyOptions,
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
  requireOnlyOptions(options, ["campaign-id", "record", "release-commit"]);
  const recordPath = requiredOption(options, "record");
  await createRecordFile(
    recordPath,
    createAdministrativeAutonomyRestartRecord({
      campaignId: requiredOption(options, "campaign-id"),
      releaseCommit: requiredOption(options, "release-commit"),
    }),
  );
} else if (command === "record-baseline") {
  requireOnlyOptions(options, ["record", "recorded-at", "status-file"]);
  const policy = await readPolicyStatus(requiredOption(options, "status-file"));
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendAdministrativeAutonomyRestartEvent(record, {
      apiAuthentication: "trusted-browser-session",
      apiPath: "/api/administrative-autonomy",
      kind: "administrative-policy-baseline-observed",
      policy,
      recordedAt: requiredOption(options, "recorded-at"),
    }),
  );
} else if (
  command === "record-service-restart" ||
  command === "record-host-reboot"
) {
  const hostReboot = command === "record-host-reboot";
  requireOnlyOptions(options, [
    "api-service",
    ...(hostReboot ? ["boot-identity-changed"] : []),
    "record",
    "recorded-at",
    "status-file",
    "worker-service",
  ]);
  const policy = await readPolicyStatus(requiredOption(options, "status-file"));
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendAdministrativeAutonomyRestartEvent(record, {
      ...(hostReboot
        ? {
            agentHostBootIdentityChanged: requiredOption(
              options,
              "boot-identity-changed",
            ),
          }
        : {}),
      apiService: requiredOption(options, "api-service"),
      kind: hostReboot
        ? "administrative-policy-host-reboot-observed"
        : "administrative-policy-service-restart-observed",
      policyApi: {
        apiAuthentication: "trusted-browser-session",
        apiPath: "/api/administrative-autonomy",
        outcome: "passed",
        policy,
      },
      recordedAt: requiredOption(options, "recorded-at"),
      workerService: requiredOption(options, "worker-service"),
    }),
  );
} else if (
  command === "record-service-restart-failure" ||
  command === "record-host-reboot-failure"
) {
  const hostReboot = command === "record-host-reboot-failure";
  requireOnlyOptions(options, [
    "api-service",
    ...(hostReboot ? ["boot-identity-changed"] : []),
    "failure",
    "record",
    "recorded-at",
    "worker-service",
  ]);
  await updateRecord(requiredOption(options, "record"), (record) =>
    appendAdministrativeAutonomyRestartEvent(record, {
      ...(hostReboot
        ? {
            agentHostBootIdentityChanged: requiredOption(
              options,
              "boot-identity-changed",
            ),
          }
        : {}),
      apiService: requiredOption(options, "api-service"),
      kind: hostReboot
        ? "administrative-policy-host-reboot-observed"
        : "administrative-policy-service-restart-observed",
      policyApi: {
        failure: requiredOption(options, "failure"),
        outcome: "failed",
      },
      recordedAt: requiredOption(options, "recorded-at"),
      workerService: requiredOption(options, "worker-service"),
    }),
  );
} else if (command === "arm-host-reboot") {
  requireOnlyOptions(options, ["record", "recorded-at"]);
  await updateRecord(requiredOption(options, "record"), (record) => {
    const baseline = record.events[0];
    if (baseline?.kind !== "administrative-policy-baseline-observed") {
      throw new Error("Record the authenticated policy baseline first");
    }
    return appendAdministrativeAutonomyRestartEvent(record, {
      expectedPolicy: baseline.policy,
      kind: "administrative-policy-host-reboot-armed",
      recordedAt: requiredOption(options, "recorded-at"),
    });
  });
} else if (command === "status") {
  requireOnlyOptions(options, ["record"]);
  const evaluation = evaluateAdministrativeAutonomyRestartWitness(
    await readRecord(requiredOption(options, "record")),
  );
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (!evaluation.ready) process.exitCode = 1;
} else {
  throw new Error(
    "Usage: administrative-autonomy-restart-cli.ts <init|record-baseline|record-service-restart|record-service-restart-failure|arm-host-reboot|record-host-reboot|record-host-reboot-failure|status> [options]",
  );
}

async function readPolicyStatus(statusPath: string) {
  return administrativePolicyObservationFromAuthenticatedApi(
    JSON.parse(await readFile(statusPath, "utf8")),
  );
}

async function readRecord(
  recordPath: string,
): Promise<AdministrativeAutonomyRestartRecord> {
  return readRecordFile(recordPath, parseAdministrativeAutonomyRestartRecord);
}

async function updateRecord(
  recordPath: string,
  update: (
    record: AdministrativeAutonomyRestartRecord,
  ) => AdministrativeAutonomyRestartRecord,
): Promise<void> {
  await updateRecordFile(
    recordPath,
    parseAdministrativeAutonomyRestartRecord,
    update,
  );
}
