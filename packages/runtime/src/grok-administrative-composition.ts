import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  administrativeUnavailableExecutionManifest,
  credentialCustodyBoundaryPaths,
  evaluateGrokEnrollment,
  grokEnrollmentCampaignIdSchema,
  grokRunnerPinSchema,
  parseGrokEnrollmentRecord,
  type AdministrativeExecutionManifest,
  type GrokEnrollmentCampaignId,
  type GrokRunnerPin,
} from "@voice-agent/contracts";

import type {
  AdministrativeImplementationCatalog,
  AdministrativeOperationExecutor,
  AdministrativePlanProvider,
  AdministrativeRegisteredCodebasePathAuthority,
  AdministrativeRegisteredCodebaseRegistry,
} from "./administrative-autonomy.ts";
import {
  createGrokAdministrativeAdapter,
  type GrokAdministrativeAdapter,
  type GrokAdministrativeRunner,
} from "./grok-administrative-adapter.ts";

export const grokRunnerPinPath =
  process.env.VOICE_AGENT_GROK_PIN_PATH ??
  "/etc/voice-agent/grok/runner-pin.json";
export const grokEnrollmentRecordPath =
  process.env.VOICE_AGENT_GROK_ENROLLMENT_PATH ??
  "/var/lib/voice-agent-evidence/grok-enrollment.json";

const grokAdministrativeAdapterIdentity =
  "voice-agent/grok-administrative-adapter/v1";

export function grokAdministrativeImplementationDigest(): string {
  return createHash("sha256")
    .update(grokAdministrativeAdapterIdentity)
    .digest("hex");
}

export async function readGrokRunnerPin(
  pinPath = grokRunnerPinPath,
): Promise<GrokRunnerPin | undefined> {
  try {
    return grokRunnerPinSchema.parse(JSON.parse(await readFile(pinPath, "utf8")));
  } catch {
    return undefined;
  }
}

export async function readGrokEnrollmentCampaignId(
  enrollmentPath = grokEnrollmentRecordPath,
): Promise<GrokEnrollmentCampaignId> {
  try {
    const record = parseGrokEnrollmentRecord(
      JSON.parse(await readFile(enrollmentPath, "utf8")),
    );
    return record.campaignId;
  } catch {
    return grokEnrollmentCampaignIdSchema.parse("grok-enrollment");
  }
}

export async function evaluateDeployedGrokEnrollment(
  enrollmentPath = grokEnrollmentRecordPath,
): Promise<{ readonly activated: boolean } | null> {
  try {
    return evaluateGrokEnrollment(
      parseGrokEnrollmentRecord(
        JSON.parse(await readFile(enrollmentPath, "utf8")),
      ),
    );
  } catch {
    return null;
  }
}

/**
 * The production Grok runner. Until the reviewed executor can be invoked
 * from this process as `voice-grok`, a run the enrollment has accepted
 * still pauses rather than executing as the wrong identity.
 */
export function createHostGrokAdministrativeRunner(): GrokAdministrativeRunner {
  return {
    async runOperation() {
      return {
        reason: "provider-contract-drift",
        state: "paused",
      };
    },
    async runPlan() {
      return {
        reason: "provider-contract-drift",
        state: "paused",
      };
    },
  };
}

export function createEmptyAdministrativeRegisteredCodebaseRegistry(): AdministrativeRegisteredCodebaseRegistry {
  return {
    async findRegisteredCodebase() {
      return undefined;
    },
  };
}

export function createDeployedAdministrativeRegisteredCodebasePathAuthority(): AdministrativeRegisteredCodebasePathAuthority {
  return {
    allowedRoots: {
      liveCheckoutPath: ["/srv"],
      sourceCheckoutRoot: ["/srv/source"],
      worktreeRoot: ["/var/lib/voice-agent-worktrees"],
    },
    credentialCustodyBoundaryPaths,
    async resolvePath(path) {
      return path;
    },
  };
}

export type DeployedAdministrativeGrokExecution =
  | {
      readonly kind: "unavailable";
      readonly executionManifest: AdministrativeExecutionManifest;
    }
  | {
      readonly kind: "grok-build";
      readonly adapter: GrokAdministrativeAdapter;
      readonly catalog: AdministrativeImplementationCatalog;
      readonly executionManifest: AdministrativeExecutionManifest;
      readonly executor: AdministrativeOperationExecutor;
      readonly provider: AdministrativePlanProvider;
      readonly registeredCodebasePathAuthority: AdministrativeRegisteredCodebasePathAuthority;
      readonly registeredCodebases: AdministrativeRegisteredCodebaseRegistry;
    };

export async function composeDeployedAdministrativeGrokExecution(input?: {
  readonly enrollmentPath?: string;
  readonly pinPath?: string;
  readonly runner?: GrokAdministrativeRunner;
}): Promise<DeployedAdministrativeGrokExecution> {
  const pin = await readGrokRunnerPin(input?.pinPath ?? grokRunnerPinPath);
  if (pin === undefined) {
    return {
      executionManifest: administrativeUnavailableExecutionManifest,
      kind: "unavailable",
    };
  }
  const enrollmentPath = input?.enrollmentPath ?? grokEnrollmentRecordPath;
  const adapter = createGrokAdministrativeAdapter({
    enrollmentCampaignId: await readGrokEnrollmentCampaignId(enrollmentPath),
    evaluateEnrollment: () => evaluateDeployedGrokEnrollment(enrollmentPath),
    implementationDigest: grokAdministrativeImplementationDigest(),
    runner: input?.runner ?? createHostGrokAdministrativeRunner(),
    runnerPin: pin,
  });
  return {
    adapter,
    catalog: adapter.catalog,
    executionManifest: adapter.executionManifest,
    executor: adapter.executor,
    kind: "grok-build",
    provider: adapter.provider,
    registeredCodebasePathAuthority:
      createDeployedAdministrativeRegisteredCodebasePathAuthority(),
    registeredCodebases: createEmptyAdministrativeRegisteredCodebaseRegistry(),
  };
}
