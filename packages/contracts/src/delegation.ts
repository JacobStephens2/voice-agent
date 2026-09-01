import { z } from "zod";

const identifierSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime();
const absolutePathSchema = z.string().min(1).max(500).startsWith("/");

export const delegationCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const delegationRepositoryPathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "Repository paths must stay relative to the Registered Codebase",
  });

export const delegationWorktreeSchema = z
  .object({
    baseCommit: delegationCommitSchema,
    branch: z.string().min(1).max(200),
    dirty: z.boolean(),
    id: identifierSchema,
    path: absolutePathSchema,
    state: z.enum(["queued", "running", "completed", "stopped", "failed"]),
  })
  .strict();

export const delegationFailureKinds = [
  "delegation-execution",
  "model-declined",
  "restricted-runner",
  "sandbox-initialization",
] as const;

export const delegationFailureSchema = z
  .object({
    evidencePaths: z.array(absolutePathSchema).max(4),
    kind: z.enum(delegationFailureKinds),
    message: z.string().min(1).max(300),
    name: z.string().min(1).max(120),
  })
  .strict();

export const delegationTerminationSchema = z
  .object({
    evidencePaths: z.array(absolutePathSchema).max(4),
    kind: z.enum(["deadline", "owner-requested", "signal"]),
    message: z.string().min(1).max(300),
  })
  .strict();

export const delegationAutomaticVerificationSchema = z
  .object({
    command: z.string().min(1).max(200),
    outcome: z.enum(["failed", "passed"]),
    summary: z.string().min(1).max(300),
  })
  .strict();

export const delegationVerifiedCandidateSchema = z
  .object({
    branch: z.string().min(1).max(200),
    commit: delegationCommitSchema,
    worktreeId: identifierSchema,
  })
  .strict();

/** Fields every Delegation Result carries, regardless of its domain-specific proof. */
export const delegationResultSharedFields = {
  branch: z.string().min(1).max(200),
  changedFiles: z.array(delegationRepositoryPathSchema).max(20),
  commits: z.array(delegationCommitSchema).max(20),
  completedAt: timestampSchema,
  delegationId: identifierSchema,
  failure: delegationFailureSchema.nullable(),
  risks: z.array(z.string().min(1).max(300)).max(20),
  status: z.enum(["completed", "failed", "stopped"]),
  worktree: delegationWorktreeSchema,
};

/** One truthful outcome invariant shared by every Delegation Result schema. */
export const delegationResultOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ failure: z.null(), status: z.literal("completed") }),
  z.object({ failure: delegationFailureSchema, status: z.literal("failed") }),
  z.object({ failure: z.null(), status: z.literal("stopped") }),
]);

export const delegationAutomatedVerificationResultsSchema = z
  .array(delegationAutomaticVerificationSchema)
  .max(10);

/** Canonical cross-codebase portion of every structured Delegation Result. */
export const delegationResultCoreSchema = z
  .object({
    ...delegationResultSharedFields,
    termination: delegationTerminationSchema.nullable(),
    verification: z
      .object({
        automated: delegationAutomatedVerificationResultsSchema,
        candidate: delegationVerifiedCandidateSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    if (!delegationResultOutcomeSchema.safeParse(result).success) {
      context.addIssue({
        code: "custom",
        message:
          "Completed and stopped Delegations have no failure; failed Delegations retain one",
        path: ["failure"],
      });
    }
    if (
      (result.status === "stopped") !== (result.termination !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Stopped Delegations retain termination proof; completed and failed Delegations do not",
        path: ["termination"],
      });
    }
    const headCommit = result.commits.at(-1);
    if (
      result.status === "completed" &&
      (headCommit === undefined ||
        result.verification.candidate === null ||
        result.verification.candidate.branch !== result.branch ||
        result.verification.candidate.commit !== headCommit ||
        result.verification.candidate.worktreeId !== result.worktree.id)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Delegation verification must identify the completed branch, head commit, and worktree",
        path: ["verification", "candidate"],
      });
    }
  });

export type DelegationResultCore = z.infer<typeof delegationResultCoreSchema>;
