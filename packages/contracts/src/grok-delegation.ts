import { z } from "zod";

const absolutePathSchema = z.string().min(1).max(500).startsWith("/");
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const identifierSchema = z.string().min(1).max(120);
const providerIdentifierSchema = z.string().min(1).max(200);
const sentenceSchema = z.string().min(1).max(300);

/** The only Subagent provider the Administrative Autonomy MVP may execute. */
export const grokProvider = "grok" as const;

/**
 * The model this contract asks for.
 *
 * `grok-build` is documented as the recommended alias but the subscription
 * rejects it as an unknown model id; `grok models` offers `grok-4.6` and
 * `grok-4.5`. It is named explicitly rather than left to the account default
 * so that a changed default is drift rather than a silent substitution.
 *
 * The model the provider actually serves is recorded separately, because it
 * differs: a run asking for `grok-4.6` is served by `grok-4.6-build`.
 */
export const grokModelSelector = "grok-4.6" as const;

/**
 * The one authentication route this provider may use.
 *
 * The owner's subscription authorizes these runs. The metered xAI API is a
 * different billing relationship, so a run that reports anything else - or
 * reports nothing - is not an accepted run.
 */
export const grokAuthenticationRoute = "subscription-oauth" as const;

/**
 * Where the root-managed configuration is installed.
 *
 * The path a given runner build actually reads is confirmed during enrollment
 * and recorded in the Runner Pin, because a provider release may move its own
 * system configuration location. This constant is what the Agent Host installs
 * and what the runbook pins by default, not an assumption checked at runtime.
 */
export const grokRootConfigurationPath = "/etc/voice-agent/grok/config.toml";

/** The reviewed sandbox profile a model process is confined to. */
export const grokSandboxProfile = "voice-agent-task";

/** Host stores that remain broker-only under ADR-0048. */
export const credentialCustodyBoundaryPaths = [
  "/etc/ssh",
  "/etc/voice-agent",
  "/home",
  "/root",
  "/run/voice-agent-broker",
  "/run/voice-agent-grok-auth",
  "/run/voice-agent-keeplore-publisher",
  "/run/voice-agent-subagent",
  "/usr/local/libexec/voice-agent",
  "/var/lib/voice-agent",
  "/var/lib/voice-agent-broker",
  "/var/lib/voice-agent-evidence",
  "/var/lib/voice-codex",
  "/var/lib/voice-grok-auth",
] as const;

export const grokContractDelegationCapabilities = [
  "delegated-worktree.read",
  "delegated-worktree.write",
] as const;

/**
 * The structured result the model itself returns.
 *
 * It is deliberately small. The trusted executor observes the worktree, the
 * runner's exit, and the provider's own headless envelope; the model is asked
 * only for what nothing else can supply - whether it believes it finished, a
 * sentence about what it did, and the risks it noticed. A transcript or event
 * stream is not part of the contract and is never persisted.
 */
export const grokModelReportSchema = z
  .object({
    risks: z.array(sentenceSchema).max(20),
    status: z.enum(["completed", "declined"]),
    summary: z.string().min(1).max(1_000),
  })
  .strict();
export type GrokModelReport = z.infer<typeof grokModelReportSchema>;

/**
 * The exact runner build this contract was proved against.
 *
 * Both halves are required. A version string is the runner's own claim about
 * itself; the digest is the only statement about the bytes that will execute.
 */
export const grokRunnerPinSchema = z
  .object({
    /**
     * The one configuration source an accepted run may have, as this runner
     * build reported it during enrollment.
     */
    configurationPath: absolutePathSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .strict();
export type GrokRunnerPin = z.infer<typeof grokRunnerPinSchema>;

export function sameGrokRunnerPin(
  left: GrokRunnerPin,
  right: GrokRunnerPin,
): boolean {
  const parsedLeft = grokRunnerPinSchema.parse(left);
  const parsedRight = grokRunnerPinSchema.parse(right);
  return (
    parsedLeft.configurationPath === parsedRight.configurationPath &&
    parsedLeft.digest === parsedRight.digest &&
    parsedLeft.version === parsedRight.version
  );
}

/**
 * What a run cost, as the provider actually reported it.
 *
 * Subscription-backed headless runs may omit monetary cost entirely. An
 * omitted cost is `"unknown"` and never zero: recording a run the owner's
 * subscription paid for as free would misstate the only usage signal this
 * route has.
 */
export const grokRunCostSchema = z.union([
  z.literal("unknown"),
  z
    .object({
      amount: z.number().nonnegative(),
      currency: z.string().length(3),
    })
    .strict(),
]);

export const grokUsageSchema = z
  .object({
    cost: grokRunCostSchema,
    incomplete: z.boolean(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * The durable account of one provider execution.
 *
 * Everything here is either authored by this codebase or copied from the
 * provider's own headless envelope. No credential, prompt, transcript, tool
 * event, or raw output reaches it, which is what makes it safe to keep for as
 * long as the Durable Task lives.
 */
export const grokRunEvidenceSchema = z
  .object({
    authenticationRoute: z.literal(grokAuthenticationRoute),
    model: z
      .object({
        providerReported: providerIdentifierSchema,
        selector: z.literal(grokModelSelector),
      })
      .strict(),
    provider: z.literal(grokProvider),
    requestId: providerIdentifierSchema.nullable(),
    runner: grokRunnerPinSchema,
    sessionId: providerIdentifierSchema.nullable(),
    stopReason: z.string().min(1).max(120),
    usage: grokUsageSchema,
  })
  .strict();
export type GrokRunEvidence = z.infer<typeof grokRunEvidenceSchema>;

/**
 * Why a run stopped in a state an attended action can resume.
 *
 * Each of these is the provider declining to serve this subscription right
 * now. None of them is a reason to select another route: the Durable Task,
 * its worktrees, and its completed commits are preserved and the work resumes
 * after quota, entitlement, or a fresh device authorization returns.
 */
export const grokPauseReasonSchema = z.enum([
  "provider-authentication",
  "provider-contract-drift",
  "provider-entitlement",
  "provider-quota",
  "runner-pin-drift",
]);
export type GrokPauseReason = z.infer<typeof grokPauseReasonSchema>;

/** Why a run ended without a result that resuming the same run could fix. */
export const grokFailureReasonSchema = z.enum([
  "malformed-output",
  "runner-execution",
  "timeout",
  "turn-limit",
]);
export type GrokFailureReason = z.infer<typeof grokFailureReasonSchema>;

const outcomeFields = {
  detail: sentenceSchema,
  evidence: grokRunEvidenceSchema.nullable(),
};

/**
 * How one bounded provider execution ended.
 *
 * Every ending is one of these four states. There is no state for "tried
 * another provider" and no state that leaves the ending unnamed: a run whose
 * output could not be understood is `failed` with a reason, not a completed
 * run with an empty result.
 */
export const grokContractRunOutcomeSchema = z.discriminatedUnion("state", [
  z
    .object({
      evidence: grokRunEvidenceSchema,
      report: grokModelReportSchema,
      state: z.literal("completed"),
    })
    .strict(),
  z
    .object({
      ...outcomeFields,
      reason: grokPauseReasonSchema,
      state: z.literal("paused"),
    })
    .strict(),
  z
    .object({
      ...outcomeFields,
      reason: grokFailureReasonSchema,
      state: z.literal("failed"),
    })
    .strict(),
  z
    .object({ ...outcomeFields, state: z.literal("stopped") })
    .strict(),
]);
export type GrokContractRunOutcome = z.infer<
  typeof grokContractRunOutcomeSchema
>;

/**
 * What is left on disk when a run ends, however it ended.
 *
 * A stopped, paused, or failed run keeps its Delegation root exactly as the
 * model left it: nothing is reset, stashed, cleaned, or deleted. Recording the
 * root's Git state beside the outcome is how a later run - or the owner - 
 * knows what is already committed and what is still unfinished.
 */
export const grokDelegationWorkspaceSchema = z
  .object({
    delegationRoot: absolutePathSchema,
    git: z.union([
      z.literal("not-a-repository"),
      z
        .object({
          dirty: z.boolean(),
          headCommit: commitSchema.nullable(),
        })
        .strict(),
    ]),
  })
  .strict();

/** The durable record of one bounded provider execution. */
export const grokContractRunRecordSchema = z
  .object({
    delegationId: identifierSchema,
    outcome: grokContractRunOutcomeSchema,
    recordedAt: z.iso.datetime(),
    schemaVersion: z.literal(1),
    workspace: grokDelegationWorkspaceSchema,
  })
  .strict();
export type GrokContractRunRecord = z.infer<typeof grokContractRunRecordSchema>;

export const grokContractDelegationBriefSchema = z
  .object({
    acceptanceCriteria: z.array(sentenceSchema).min(1).max(10),
    boundedContext: z
      .object({
        editablePaths: z
          .array(
            z
              .string()
              .min(1)
              .max(300)
              .refine(
                (path) =>
                  !path.startsWith("/") && !path.split("/").includes(".."),
                {
                  message:
                    "Delegated paths must stay relative to the Delegation root",
                },
              ),
          )
          .min(1)
          .max(50),
        repositoryContentTrust: z.literal("untrusted-data-only"),
      })
      .strict(),
    capabilities: z.tuple([
      z.literal(grokContractDelegationCapabilities[0]),
      z.literal(grokContractDelegationCapabilities[1]),
    ]),
    delegationId: identifierSchema.regex(/^[A-Za-z0-9_-]+$/u),
    goal: z.string().min(1).max(600),
    maxTurns: z.number().int().min(1).max(50),
    provider: z.literal(grokProvider),
    /**
     * Why this run exists.
     *
     * `contract-test` is the attended enrollment ceremony, which is what
     * produces the proof; requiring an accepted proof to run it could never
     * be satisfied. `work` is everything else, and it runs only while the
     * enrollment record for the pinned runner is accepted.
     */
    purpose: z.enum(["contract-test", "work"]),
  })
  .strict();
export type GrokContractDelegationBrief = z.infer<
  typeof grokContractDelegationBriefSchema
>;
