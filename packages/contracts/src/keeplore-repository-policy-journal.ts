import { z } from "zod";

import { keeploreRegisteredCodebaseIdSchema } from "./keeplore-onboarding.ts";

const timestampSchema = z.iso.datetime();

/**
 * The Agent Host's append-only repository-policy journal records what was
 * observed of Keeplore's production-branch rules and GitHub App installation.
 *
 * Like the Promotion journal, it is written by root-owned Bash outside this
 * process, so every line is untrusted input (ADR-0042) and a malformed line is
 * skipped rather than trusted.
 */
export const keeploreBranchRulesObservationSchema = z
  .object({
    /** Rule types GitHub reports as active on the production branch. */
    activeRules: z.array(z.string().regex(/^[a-z_]+$/u).max(60)).max(40),
    registeredCodebaseId: keeploreRegisteredCodebaseIdSchema,
    branch: z.string().min(1).max(120),
    kind: z.literal("branch-rules"),
    observedAt: timestampSchema,
    observedBy: z.literal("github-app-installation"),
    repository: z.string().min(1).max(200),
    /** Check contexts the required-status-checks rule names. */
    requiredChecks: z.array(z.string().min(1).max(120)).max(20),
  })
  .strict();

/**
 * The owner's reading of the production branch's bypass actors.
 *
 * GitHub discloses a ruleset's `bypass_actors` only to an actor with write
 * access to the ruleset, which the Voice Agent's GitHub App must never hold. So
 * no credential the Voice Agent owns can enumerate them, and the owner reads
 * them with their own authenticated GitHub account and attests the result
 * (ADR-0047).
 */
export const keeploreBranchBypassAttestationSchema = z
  .object({
    registeredCodebaseId: keeploreRegisteredCodebaseIdSchema,
    attestedAt: timestampSchema,
    attestedBy: z.literal("owner"),
    branch: z.string().min(1).max(120),
    /** Every bypass actor on every ruleset that applies to the branch. */
    bypassActors: z.array(z.string().min(1).max(120)).max(20),
    kind: z.literal("branch-bypass"),
    observedAt: timestampSchema,
    repository: z.string().min(1).max(200),
    /** The rulesets read, so a partial attestation cannot pass as a whole one. */
    rulesetsRead: z.number().int().min(0).max(100),
  })
  .strict();

/**
 * The App's own granted authority. The permissions and repository selection are
 * read as the App itself with an App JWT; the repository list needs the
 * installation token, because no App-level endpoint reports it. Both are the
 * Voice Agent's own credentials, and neither can widen what it sees.
 */
export const keeploreGitHubAppObservationSchema = z
  .object({
    appId: z.number().int().positive(),
    appSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u),
    registeredCodebaseId: keeploreRegisteredCodebaseIdSchema,
    installationId: z.number().int().positive(),
    kind: z.literal("github-app"),
    observedAt: timestampSchema,
    observedBy: z.literal("github-app-credentials"),
    permissions: z
      .record(z.string().min(1).max(60), z.enum(["admin", "read", "write"]))
      .refine((permissions) => Object.keys(permissions).length <= 20, {
        message: "GitHub App permissions are bounded",
      }),
    repositories: z.array(z.string().min(1).max(200)).max(20),
    repositorySelection: z.enum(["all", "selected"]),
  })
  .strict();

export const keeploreRepositoryPolicyObservationSchema = z.discriminatedUnion(
  "kind",
  [
    keeploreBranchRulesObservationSchema,
    keeploreBranchBypassAttestationSchema,
    keeploreGitHubAppObservationSchema,
  ],
);

export type KeeploreBranchRulesObservation = z.infer<
  typeof keeploreBranchRulesObservationSchema
>;
export type KeeploreBranchBypassAttestation = z.infer<
  typeof keeploreBranchBypassAttestationSchema
>;
export type KeeploreGitHubAppObservation = z.infer<
  typeof keeploreGitHubAppObservationSchema
>;
export type KeeploreRepositoryPolicyObservation = z.infer<
  typeof keeploreRepositoryPolicyObservationSchema
>;
