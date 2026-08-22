import {
  createAuthenticationLifecycle,
  createNodeAuthenticationSecrets,
  createSimpleWebAuthnPasskeyAdapter,
} from "@voice-agent/auth";
import {
  createSqliteAuthenticationStore,
  createSqliteCallbackHandshakeStore,
  createSqliteDurableTaskStore,
  createSqliteKeeploreOnboardingStore,
  createSqliteTelephoneBoundaryStore,
  createSqliteTaskContinuityStore,
} from "@voice-agent/sqlite-store";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createUnixSocketBountywellController,
  createUnixSocketBountywellObserver,
} from "@voice-agent/operations-broker";

import { createVoiceApi } from "./index.ts";
import {
  createCallbackHandshakeRuntime,
  createDurableTaskRuntime,
  createKeeploreOnboardingControls,
  createNodeKeeploreLiveInspector,
  assessKeeploreRepositoryPolicy,
  keeplorePromotionTaskPrefix,
  projectKeeplorePromotionEvidence,
  readKeeploreRegistrationFile,
  createNodeRawAudioArtifactRemover,
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
const api = createVoiceApi({
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
      readDeploymentAuthorityUpgradeChallenge(
        process.env.VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE_CHALLENGE_PATH ??
          "/var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.challenge",
        process.env.VOICE_AGENT_PROMOTION_STATE_PATH ??
          "/var/lib/voice-agent-promotions/state.tsv",
        "/opt/voice-agent/current/.voice-agent-release",
      ),
    requestDeploymentAuthorityUpgrade: (authorization) =>
      requestDeploymentAuthorityUpgrade(
        process.env.VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE_REQUEST_PATH ??
          "/var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.request",
        process.env.VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE_CHALLENGE_PATH ??
          "/var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.challenge",
        process.env.VOICE_AGENT_PROMOTION_STATE_PATH ??
          "/var/lib/voice-agent-promotions/state.tsv",
        "/opt/voice-agent/current/.voice-agent-release",
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
      return (
        (await callbackRuntime.readEvidenceRecord(taskId)) ??
        (await runtime.getEvidenceRecord(taskId))
      );
    },
    listEvidenceRecords: async () => {
      const records = [
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
  telephoneControls: callbackRuntime,
});
await api.register(staticFiles, {
  root: fileURLToPath(new URL("../../pwa/dist", import.meta.url)),
});

const shutdown = async () => {
  await api.close();
  await authenticationStore.close();
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

async function requestDeploymentAuthorityUpgrade(
  path: string,
  challengePath: string,
  statePath: string,
  activeReleaseMarkerPath: string,
  authorization: {
    readonly challenge: string;
    readonly commit: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly kind: "authentication" | "enrollment";
    readonly options: unknown;
    readonly response: unknown;
  },
): Promise<string> {
  const challenge = await readDeploymentAuthorityUpgradeChallenge(
    challengePath,
    statePath,
    activeReleaseMarkerPath,
  );
  if (
    authorization.commit !== challenge.commit ||
    authorization.challenge !== challenge.challenge ||
    authorization.createdAt !== challenge.createdAt ||
    authorization.expiresAt !== challenge.expiresAt ||
    authorization.kind !== challenge.kind
  ) {
    throw new Error("Deployment-authority upgrade challenge changed");
  }
  const contents = `${JSON.stringify({ ...authorization, version: 1 })}\n`;
  await writeNarrowRequest(path, contents, (existing) => existing === contents);
  return challenge.commit;
}

async function readDeploymentAuthorityUpgradeChallenge(
  path: string,
  statePath: string,
  activeReleaseMarkerPath: string,
): Promise<{
  readonly challenge: string;
  readonly commit: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly kind: "authentication" | "enrollment";
  readonly options: unknown;
}> {
  const state = (await readFile(statePath, "utf8")).trim().split("\t");
  const commit = state[3];
  if (
    state[1] !== "closed" ||
    state[2] !== "-" ||
    commit === undefined ||
    !/^[0-9a-f]{40}$/u.test(commit)
  ) {
    throw new Error("No successfully promoted Release is active");
  }
  if ((await readFile(activeReleaseMarkerPath, "utf8")).trim() !== commit) {
    throw new Error("Active Release does not match Promotion state");
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o640) {
    throw new Error("Deployment-authority upgrade challenge is not root-owned");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.commit !== commit ||
    typeof value.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.challenge) ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    (value.kind !== "authentication" && value.kind !== "enrollment") ||
    value.options === null ||
    typeof value.options !== "object" ||
    !("challenge" in value.options) ||
    value.options.challenge !== value.challenge ||
    Date.now() < Date.parse(value.createdAt) ||
    Date.now() >= Date.parse(value.expiresAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== 5 * 60 * 1_000
  ) {
    throw new Error("Deployment-authority upgrade challenge is invalid or expired");
  }
  return {
    challenge: value.challenge,
    commit,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    kind: value.kind,
    options: value.options,
  };
}

async function writeNarrowRequest(
  path: string,
  contents: string,
  acceptsExisting: (contents: string) => boolean,
): Promise<void> {
  try {
    const request = await open(path, "wx", 0o640);
    try {
      await request.writeFile(contents, "utf8");
    } finally {
      await request.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      if (acceptsExisting(await readFile(path, "utf8"))) return;
    } else {
      throw error;
    }
    throw new Error("Narrow request is invalid");
  }
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
