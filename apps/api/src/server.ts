import {
  createAuthenticationLifecycle,
  createNodeAuthenticationSecrets,
  createSimpleWebAuthnPasskeyAdapter,
} from "@voice-agent/auth";
import {
  createSqliteAuthenticationStore,
  createSqliteAdministrativeAutonomyStore,
  createSqliteAdministrativeRestartWitnessStore,
  createSqliteCallbackHandshakeStore,
  createSqliteDurableTaskStore,
  createSqliteKeeploreOnboardingStore,
  createSqliteTelephoneBoundaryStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  administrativeOperationClaimIdSchema,
  administrativeOperationIdSchema,
  administrativeRestartWitnessChallengeSchema,
  type AdministrativeRestartWitnessApiServiceInstanceFingerprint,
  administrativeTaskIdSchema,
  administrativeUnavailableExecutionManifest,
} from "@voice-agent/contracts";

import {
  createUnixSocketBountywellController,
  createUnixSocketBountywellObserver,
} from "@voice-agent/operations-broker";

import { createVoiceApi } from "./index.ts";
import {
  readDeploymentAuthorityUpgradeChallenge,
  requestDeploymentAuthorityUpgrade,
  writeNarrowRequest,
} from "./deployment-authority-challenge.ts";
import {
  createCallbackHandshakeRuntime,
  createAdministrativeAutonomyRuntime,
  createAdministrativeRestartWitnessRuntime,
  createDurableTaskRuntime,
  createKeeploreOnboardingControls,
  createNodeKeeploreLiveInspector,
  assessKeeploreRepositoryPolicy,
  keeplorePromotionTaskPrefix,
  projectKeeplorePromotionEvidence,
  readKeeploreRegistrationFile,
  createNodeRawAudioArtifactRemover,
  createNodeAdministrativeRestartWitnessHost,
  createNodeAdministrativeRestartWitnessWorkerHealth,
  registerNodeAdministrativeRestartWitnessServiceInstance,
  createTelephoneBoundaryRuntime,
  createTaskContinuityRuntime,
  formatTelephoneBoundaryPrometheusMetrics,
} from "@voice-agent/runtime";

const databasePath = process.env.VOICE_AGENT_DATABASE_PATH;
if (databasePath === undefined || databasePath.length === 0) {
  throw new Error("VOICE_AGENT_DATABASE_PATH is required");
}

const testMode = process.env.NODE_ENV === "test";
if (testMode && process.env.VOICE_AGENT_RESET_DATABASE === "1") {
  for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
    rmSync(path, { force: true });
  }
}
const origin = testMode
  ? (process.env.VOICE_AGENT_ORIGIN ?? "http://127.0.0.1:4173")
  : "https://voice.stephens.page";
const rpId = testMode ? new URL(origin).hostname : "voice.stephens.page";
const authenticationStore = createSqliteAuthenticationStore(databasePath);
const taskStore = createSqliteDurableTaskStore(databasePath);
// Issue #83's acceptance gate uses a fake provider, executor, and independent
// rollback activator at the scenario seam. ADR-0048 keeps real planning and
// effects behind Grok enrollment (#80),
// the Administrative Publisher App (#82), typed observation brokers (#90), and
// the Live Patch broker (#92). Production therefore binds activation to the
// unavailable manifest and reports that exact prerequisite through status.
const administrativeStore = createSqliteAdministrativeAutonomyStore(databasePath);
const administrativeRuntime = createAdministrativeAutonomyRuntime({
  executionManifest: administrativeUnavailableExecutionManifest,
  identifiers: {
    nextCapability: randomUUID,
    nextClaimId: () =>
      administrativeOperationClaimIdSchema.parse(
        `administrative-claim-${randomUUID()}`,
      ),
    nextEventId: randomUUID,
    nextOperationId: () =>
      administrativeOperationIdSchema.parse(
        `administrative-operation-${randomUUID()}`,
      ),
    nextTaskId: () =>
      administrativeTaskIdSchema.parse(`administrative-task-${randomUUID()}`),
  },
  now: () => new Date().toISOString(),
  store: administrativeStore,
});
await administrativeRuntime.reconcileOperations();
const administrativeRestartWitnessStore =
  createSqliteAdministrativeRestartWitnessStore(databasePath);
let apiServiceInstanceFingerprint:
  | AdministrativeRestartWitnessApiServiceInstanceFingerprint
  | undefined;
const administrativeRestartWitnessRuntime = testMode
  ? undefined
  : createAdministrativeRestartWitnessRuntime({
      host: createNodeAdministrativeRestartWitnessHost({
        readApiServiceInstanceFingerprint: () =>
          apiServiceInstanceFingerprint,
        services: administrativeRestartWitnessStore,
        workerHealth: createNodeAdministrativeRestartWitnessWorkerHealth({
          port: Number(requireEnvironment("VOICE_AGENT_WORKER_PORT")),
        }),
      }),
      identifiers: {
        nextChallenge: () =>
          administrativeRestartWitnessChallengeSchema.parse(
            `administrative-restart-challenge-${randomUUID()}`,
          ),
      },
      now: () => new Date().toISOString(),
      store: administrativeRestartWitnessStore,
    });
const telephoneBoundaryStore = createSqliteTelephoneBoundaryStore(databasePath);
const brokerSocketPath = process.env.VOICE_AGENT_BROKER_SOCKET_PATH;
const runtime = createDurableTaskRuntime({
  applicationRegistry: taskStore,
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  // This Personal Prototype serves one owner, so a live Telephone Session is
  // the owner's; the drill runs only while one is carrying them.
  ownerAvailability: {
    async countLiveTelephoneSessions() {
      return (await telephoneBoundaryStore.findActiveSessionIds()).length;
    },
  },
  ...(brokerSocketPath === undefined
    ? {}
    : {
        healthObserver: createUnixSocketBountywellObserver(brokerSocketPath),
        serviceController: createUnixSocketBountywellController(brokerSocketPath),
      }),
  store: taskStore,
});
const callbackStore = createSqliteCallbackHandshakeStore(databasePath);
const callbackRuntime = createCallbackHandshakeRuntime({
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: callbackStore,
});
const boundaries = createTelephoneBoundaryRuntime({
  evidence: {
    async append(telephoneSessionId, event) {
      await callbackRuntime.appendTelephoneSessionEvidenceBySessionId(
        telephoneSessionId,
        event,
      );
    },
  },
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  rawAudioArtifacts: createNodeRawAudioArtifactRemover(),
  rawAudioDebugDirectory:
    process.env.VOICE_AGENT_RAW_AUDIO_DEBUG_DIRECTORY ??
    "/var/lib/voice-agent/raw-audio-debug",
  store: telephoneBoundaryStore,
});
await boundaries.cleanupExpiredRawAudio();
const continuityRuntime = createTaskContinuityRuntime({
  administrativeEvidenceRetention: administrativeRuntime,
  callbackEvidenceRetention: callbackStore,
  evidenceOrigin: origin,
  nextId: randomUUID,
  now: () => new Date().toISOString(),
  store: createSqliteTaskContinuityStore(databasePath),
  tasks: taskStore,
});
const keeploreOnboardingStore = createSqliteKeeploreOnboardingStore(databasePath);
// The Keeplore boundaries come from the root-owned registration this process
// cannot write, never from its own environment (ADR-0011). Until that
// registration exists, the Keeplore surface is simply absent.
const keeploreControls = createKeeploreControls();

function createKeeploreControls() {
  let registration;
  try {
    registration = readKeeploreRegistrationFile(
      process.env.VOICE_AGENT_KEEPLORE_REGISTRATION_PATH,
    );
  } catch {
    return undefined;
  }
  return createKeeploreOnboardingControls({
    inspector: createNodeKeeploreLiveInspector({
      documentRoots: registration.documentRoots,
      liveCheckoutPath: registration.liveCheckoutPath,
      now: () => new Date().toISOString(),
      sharedPaths: registration.sharedPaths,
      verificationCommands: registration.verificationCommands,
    }),
    now: () => new Date().toISOString(),
    store: keeploreOnboardingStore,
  });
}
/**
 * One of the Agent Host's root-owned journals, read as untrusted append-only
 * events (ADR-0042). An unreadable journal is no evidence, never an error.
 */
function agentHostJournal(environmentVariable: string, defaultPath: string) {
  return {
    async read() {
      try {
        return await readFile(
          process.env[environmentVariable] ?? defaultPath,
          "utf8",
        );
      } catch {
        return "";
      }
    },
  };
}

const keeplorePromotionJournal = agentHostJournal(
  "VOICE_AGENT_KEEPLORE_ATTEMPTS_PATH",
  "/var/lib/keeplore-promotions/attempts.jsonl",
);
// What the Voice Agent's own GitHub authority could see of the production
// branch's rules and its App installation (ADR-0047).
const keeploreRepositoryPolicyJournal = agentHostJournal(
  "VOICE_AGENT_KEEPLORE_REPOSITORY_POLICY_PATH",
  "/var/lib/keeplore-promotions/repository-policy.jsonl",
);

async function readKeeploreEvidenceRecords() {
  if (keeploreControls === undefined) return [];
  // Record the observations first: the projection reads both assessments back
  // out of the durable store, so a stale collection would age the record.
  await assessKeeploreRepositoryPolicy({
    controls: keeploreControls,
    journal: keeploreRepositoryPolicyJournal,
    now: () => Date.now(),
  });
  return projectKeeplorePromotionEvidence({
    journal: keeplorePromotionJournal,
    store: keeploreOnboardingStore,
  });
}

const authentication = createAuthenticationLifecycle({
  now: () => new Date().toISOString(),
  ownerUserId: process.env.VOICE_AGENT_OWNER_ID ?? "personal-owner",
  passkeys: createSimpleWebAuthnPasskeyAdapter({
    origin,
    rpId,
    rpName: "Voice Agent",
  }),
  secrets: createNodeAuthenticationSecrets(),
  store: authenticationStore,
});
const deploymentAuthorityChallengePaths = {
  activeReleaseMarkerPath: "/opt/voice-agent/current/.voice-agent-release",
  challengePath:
    process.env.VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE_CHALLENGE_PATH ??
      "/var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.challenge",
  statePath:
    process.env.VOICE_AGENT_PROMOTION_STATE_PATH ??
      "/var/lib/voice-agent-promotions/state.tsv",
};

const api = createVoiceApi({
  administrativeControls: administrativeRuntime,
  additionalMetrics: async () => {
    const [promotionMetrics, probeMetrics, boundaryMetrics] = await Promise.all([
      readAdditionalMetrics(
        process.env.VOICE_AGENT_PROMOTION_METRICS_PATH ??
          "/var/lib/voice-agent-promotions/promotions.prom",
      ),
      readAdditionalMetrics(
        process.env.VOICE_AGENT_APPLICATION_PROBE_METRICS_PATH ??
          "/var/lib/voice-agent-probes/probes.prom",
      ),
      boundaries.readMetrics(),
    ]);
    return `${promotionMetrics}${probeMetrics}${formatTelephoneBoundaryPrometheusMetrics(
      boundaryMetrics,
    )}`;
  },
  authentication,
  boundaryControls: {
    async authorizeRawAudioDebug({ sessionId }) {
      const result = await boundaries.authorizeRawAudioDebug({
        actor: "owner",
        freshPasskey: true,
        sessionId,
      });
      return result.decision === "accepted"
        ? { ...result, sessionId }
        : result;
    },
    changeSpendingCeiling: ({ ceilingMicrousd }) =>
      boundaries.changeSpendingCeiling({
        ceilingMicrousd,
        freshPasskey: true,
      }),
    readBoundaryStatus: () => boundaries.readBoundaryStatus(),
  },
  completionControls: continuityRuntime,
  controls: runtime,
  ...(keeploreControls === undefined ? {} : { keeploreControls }),
  origin,
  promotionControl: {
    readDeploymentAuthorityUpgradeChallenge: () =>
      readDeploymentAuthorityUpgradeChallenge(deploymentAuthorityChallengePaths),
    requestDeploymentAuthorityUpgrade: (authorization) =>
      requestDeploymentAuthorityUpgrade(
        {
          ...deploymentAuthorityChallengePaths,
          requestPath:
            process.env.VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE_REQUEST_PATH ??
              "/var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.request",
        },
        authorization,
      ),
    requestResume: () => requestPromotionResume(
      process.env.VOICE_AGENT_PROMOTION_RESUME_PATH ??
        "/var/lib/voice-agent-promotion-resume/resume.request",
      process.env.VOICE_AGENT_PROMOTION_STATE_PATH ??
        "/var/lib/voice-agent-promotions/state.tsv",
    ),
  },
  records: {
    getEvidenceRecord: async (taskId) => {
      if (taskId.startsWith(keeplorePromotionTaskPrefix)) {
        const records = await readKeeploreEvidenceRecords();
        return records.find((record) => record.task.id === taskId);
      }
      const administrativeTaskId = administrativeTaskIdSchema.safeParse(taskId);
      return (
        (await callbackRuntime.readEvidenceRecord(taskId)) ??
        (administrativeTaskId.success
          ? await administrativeRuntime.getTask(administrativeTaskId.data)
          : undefined) ??
        (await runtime.getEvidenceRecord(taskId))
      );
    },
    listEvidenceRecords: async () => {
      const records = [
        ...(await administrativeRuntime.listTasks()),
        ...(await runtime.listEvidenceRecords()),
        ...(await callbackRuntime.listEvidenceRecords()),
        ...(await readKeeploreEvidenceRecords()).map((record) => record.task),
      ];
      return records
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 100);
    },
    readOperationalMetrics: async () => {
      const [taskMetrics, callbackMetrics] = await Promise.all([
        runtime.readOperationalMetrics(),
        callbackRuntime.readOperationalMetrics(),
      ]);
      return {
        ...taskMetrics,
        callbacks: callbackMetrics,
        notifications: {
          requested:
            taskMetrics.notifications.requested +
            callbackMetrics.notifications.requested,
          sent:
            taskMetrics.notifications.sent + callbackMetrics.notifications.sent,
        },
      };
    },
    recordPolicyDenial: () => runtime.recordPolicyDenial(),
  },
  ...(administrativeRestartWitnessRuntime === undefined
    ? {}
    : { restartWitnessControls: administrativeRestartWitnessRuntime }),
  telephoneControls: callbackRuntime,
});
await api.register(staticFiles, {
  root: fileURLToPath(new URL("../../pwa/dist", import.meta.url)),
});

const shutdown = async () => {
  await api.close();
  await authenticationStore.close();
  await administrativeRuntime.close();
  await administrativeRestartWitnessStore.close();
  await boundaries.close();
  await callbackRuntime.close();
  await continuityRuntime.close();
  await runtime.close();
  keeploreOnboardingStore.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await api.listen({
  host: "127.0.0.1",
  port: Number(process.env.VOICE_AGENT_PORT ?? "3472"),
});
if (!testMode) {
  apiServiceInstanceFingerprint =
    await registerNodeAdministrativeRestartWitnessServiceInstance({
      nextServiceInstanceId: () =>
        `administrative-api-service-instance-${randomUUID()}`,
      now: () => new Date().toISOString(),
      service: "api",
      store: administrativeRestartWitnessStore,
    });
}

async function requestPromotionResume(
  path: string,
  statePath: string,
): Promise<string> {
  let stateContents: string;
  try {
    stateContents = await readFile(statePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("No open Deployment Circuit Breaker");
    }
    throw error;
  }
  const state = stateContents.trim().split("\t");
  const circuitState = state[1];
  const commit = state[2];
  if (circuitState !== "open" || commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("No open Deployment Circuit Breaker");
  }
  await writeNarrowRequest(path, `${commit}\n`, (existing) =>
    existing === `${commit}\n`,
  );
  return commit;
}

async function readAdditionalMetrics(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
