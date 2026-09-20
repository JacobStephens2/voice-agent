import {
  administrativeExecutionManifestSchema,
  administrativeOperationExecutorIdentitySchema,
  administrativeOperationResultSchema,
  administrativePauseReasonFromGrok,
  administrativePlanChoiceSchema,
  administrativePlanProviderIdentitySchema,
  grokAdministrativePlanReportSchema,
  grokEnrollmentCampaignIdSchema,
  grokFailureReasonSchema,
  grokPauseReasonSchema,
  grokRunnerPinSchema,
  type AdministrativeExecutionManifest,
  type AdministrativeOperationResult,
  type GrokAdministrativePlanReport,
  type GrokContractRunOutcome,
  type GrokFailureReason,
  type GrokPauseReason,
  type GrokRunEvidence,
  type GrokRunnerPin,
} from "@voice-agent/contracts";

import {
  AdministrativeExecutionPaused,
  type AdministrativeImplementationCatalog,
  type AdministrativeOperationExecution,
  type AdministrativeOperationExecutor,
  type AdministrativePlanProvider,
} from "./administrative-autonomy.ts";

export type GrokAdministrativePlanRun =
  | { readonly reason: GrokPauseReason; readonly state: "paused" }
  | {
      readonly detail: string;
      readonly reason: GrokFailureReason;
      readonly state: "failed";
    }
  | { readonly detail: string; readonly state: "stopped" }
  | {
      readonly plan: GrokAdministrativePlanReport["plan"];
      readonly providerRun: GrokRunEvidence;
      readonly state: "completed";
    };

export type GrokAdministrativeOperationRun =
  | { readonly reason: GrokPauseReason; readonly state: "paused" }
  | {
      readonly detail: string;
      readonly reason: GrokFailureReason;
      readonly state: "failed";
    }
  | { readonly detail: string; readonly state: "stopped" }
  | {
      readonly providerRun: GrokRunEvidence;
      readonly result: AdministrativeOperationResult;
      readonly state: "completed";
    };

export interface GrokAdministrativeRunner {
  runOperation(
    execution: AdministrativeOperationExecution,
  ): Promise<GrokAdministrativeOperationRun>;
  runPlan(input: Parameters<AdministrativePlanProvider["choosePlan"]>[0]): Promise<
    GrokAdministrativePlanRun
  >;
}

export interface GrokAdministrativeAdapter {
  readonly catalog: AdministrativeImplementationCatalog;
  readonly executionManifest: AdministrativeExecutionManifest;
  readonly executor: AdministrativeOperationExecutor;
  readonly provider: AdministrativePlanProvider;
}

export interface GrokAdministrativeAdapterOptions {
  readonly enrollmentCampaignId: string;
  /**
   * When this returns an unactivated proof, planning and execution pause
   * with runner-pin-drift rather than spending a provider request.
   */
  readonly evaluateEnrollment?: () => Promise<{ readonly activated: boolean } | null>;
  readonly implementationDigest: string;
  readonly runner: GrokAdministrativeRunner;
  readonly runnerPin: GrokRunnerPin;
}

/**
 * Bind the reviewed Grok provider pin to Administrative planning and
 * Operation execution. Pause reasons are mapped onto this system's closed
 * enum before they cross into a Durable Task.
 */
export function createGrokAdministrativeAdapter(
  options: GrokAdministrativeAdapterOptions,
): GrokAdministrativeAdapter {
  const runnerPin = grokRunnerPinSchema.parse(options.runnerPin);
  const enrollmentCampaignId = grokEnrollmentCampaignIdSchema.parse(
    options.enrollmentCampaignId,
  );
  const implementationDigest = options.implementationDigest;
  const providerIdentity = administrativePlanProviderIdentitySchema.parse({
    enrollmentCampaignId,
    kind: "grok-build",
    runnerPin,
  });
  const executorIdentity = administrativeOperationExecutorIdentitySchema.parse({
    operationAdapters: [
      { implementationDigest, kind: "production.observe" },
      { implementationDigest, kind: "delegated-worktree.change" },
    ],
  });
  const executionManifest = administrativeExecutionManifestSchema.parse({
    operationAdapters: executorIdentity.operationAdapters,
    provider: providerIdentity,
    schemaVersion: 1,
  });
  const provider: AdministrativePlanProvider = {
    async choosePlan(input) {
      await requireActivatedEnrollment(options.evaluateEnrollment);
      const run = await options.runner.runPlan(input);
      if (run.state === "paused") {
        throw new AdministrativeExecutionPaused(
          administrativePauseReasonFromGrok(run.reason),
        );
      }
      if (run.state !== "completed") {
        throw new Error(run.detail);
      }
      return administrativePlanChoiceSchema.parse({
        plan: run.plan,
        providerRun: run.providerRun,
        usage: run.providerRun.usage,
      });
    },
  };
  const executor: AdministrativeOperationExecutor = {
    async execute(execution) {
      await requireActivatedEnrollment(options.evaluateEnrollment);
      const run = await options.runner.runOperation(execution);
      if (run.state === "paused") {
        throw new AdministrativeExecutionPaused(
          administrativePauseReasonFromGrok(run.reason),
        );
      }
      if (run.state !== "completed") {
        throw new Error(run.detail);
      }
      return administrativeOperationResultSchema.parse({
        ...run.result,
        providerRun: run.providerRun,
        usage: run.providerRun.usage,
      });
    },
    async recoverCompletedResult() {
      return { decision: "not-completed" };
    },
  };
  const catalog: AdministrativeImplementationCatalog = {
    identifyExecutor(implementation) {
      return implementation === executor ? executorIdentity : undefined;
    },
    identifyProvider(implementation) {
      return implementation === provider ? providerIdentity : undefined;
    },
    identifyRollbackActivator() {
      return undefined;
    },
  };
  return { catalog, executionManifest, executor, provider };
}

/**
 * Turn a Grok contract-run outcome into the adapter's planning run.
 *
 * Completed planning still has to name a typed Operation plan. The model
 * report is untrusted data and cannot widen the kinds this system permits.
 */
export function grokPlanRunFromOutcome(
  outcome: GrokContractRunOutcome,
  structuredOutput: unknown,
): GrokAdministrativePlanRun {
  const paused = grokPausedRun(outcome);
  if (paused !== undefined) return paused;
  if (outcome.state === "paused") {
    return {
      detail: outcome.detail,
      reason: "runner-execution",
      state: "failed",
    };
  }
  if (outcome.state !== "completed") {
    return grokTerminalRun(outcome);
  }
  const report = grokAdministrativePlanReportSchema.safeParse(structuredOutput);
  if (!report.success || report.data.status !== "completed") {
    return {
      detail:
        "The provider returned a final result that does not match the reviewed structured schema.",
      reason: "malformed-output",
      state: "failed",
    };
  }
  return {
    plan: report.data.plan,
    providerRun: outcome.evidence,
    state: "completed",
  };
}

export function grokPausedRun(
  outcome: GrokContractRunOutcome,
): Extract<GrokAdministrativePlanRun, { state: "paused" }> | undefined {
  if (outcome.state !== "paused") return undefined;
  const reason = grokPauseReasonSchema.safeParse(outcome.reason);
  return reason.success ? { reason: reason.data, state: "paused" } : undefined;
}

function grokTerminalRun(
  outcome: Extract<GrokContractRunOutcome, { state: "failed" | "stopped" }>,
): Extract<GrokAdministrativePlanRun, { state: "failed" | "stopped" }> {
  if (outcome.state === "stopped") {
    return { detail: outcome.detail, state: "stopped" };
  }
  const reason = grokFailureReasonSchema.safeParse(outcome.reason);
  return {
    detail: outcome.detail,
    reason: reason.success ? reason.data : "runner-execution",
    state: "failed",
  };
}

async function requireActivatedEnrollment(
  evaluateEnrollment:
    | GrokAdministrativeAdapterOptions["evaluateEnrollment"]
    | undefined,
): Promise<void> {
  if (evaluateEnrollment === undefined) return;
  const evaluation = await evaluateEnrollment();
  if (evaluation !== null && evaluation.activated) return;
  throw new AdministrativeExecutionPaused(
    administrativePauseReasonFromGrok("runner-pin-drift"),
  );
}

