import { z } from "zod";

import {
  administrativeExecutionManifestFingerprintSchema,
  administrativeTimestampSchema,
} from "./administrative-autonomy.ts";

const releaseCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const administrativeRestartWitnessCampaignIdSchema = z
  .string()
  .regex(/^administrative-restart-campaign-[A-Za-z0-9._:-]+$/u)
  .max(160)
  .brand<"AdministrativeRestartWitnessCampaignId">();
export type AdministrativeRestartWitnessCampaignId = z.infer<
  typeof administrativeRestartWitnessCampaignIdSchema
>;

export const administrativeRestartWitnessChallengeSchema = z
  .string()
  .regex(/^administrative-restart-challenge-[A-Za-z0-9._:-]+$/u)
  .max(200)
  .brand<"AdministrativeRestartWitnessChallenge">();
export type AdministrativeRestartWitnessChallenge = z.infer<
  typeof administrativeRestartWitnessChallengeSchema
>;

export const administrativeRestartWitnessPhaseSchema = z.enum([
  "baseline",
  "service-restart",
  "host-reboot",
]);
export type AdministrativeRestartWitnessPhase = z.infer<
  typeof administrativeRestartWitnessPhaseSchema
>;

export const administrativeRestartWitnessServiceInstanceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .brand<"AdministrativeRestartWitnessServiceInstanceId">();
export type AdministrativeRestartWitnessServiceInstanceId = z.infer<
  typeof administrativeRestartWitnessServiceInstanceIdSchema
>;

export const agentHostBootIdentitySchema = z
  .string()
  .min(1)
  .max(200)
  .brand<"AgentHostBootIdentity">();
export type AgentHostBootIdentity = z.infer<
  typeof agentHostBootIdentitySchema
>;

export const administrativeRestartWitnessHostObservationSchema = z
  .object({
    bootIdentity: agentHostBootIdentitySchema,
    releaseCommit: releaseCommitSchema,
    serviceInstanceId: administrativeRestartWitnessServiceInstanceIdSchema,
  })
  .strict();
export type AdministrativeRestartWitnessHostObservation = z.infer<
  typeof administrativeRestartWitnessHostObservationSchema
>;

export const administrativeRestartWitnessFailureReasonSchema = z.enum([
  "authority-changed",
  "boot-identity-changed-during-service-restart",
  "boot-identity-unchanged",
  "campaign-attempt-limit",
  "campaign-completed",
  "campaign-unavailable",
  "challenge-consumed",
  "challenge-mismatch",
  "host-observation-unavailable",
  "phase-out-of-order",
  "policy-inactive",
  "release-changed",
  "service-instance-unchanged",
]);
export type AdministrativeRestartWitnessFailureReason = z.infer<
  typeof administrativeRestartWitnessFailureReasonSchema
>;

const policyObservationSchema = z
  .object({
    executionManifestFingerprint:
      administrativeExecutionManifestFingerprintSchema,
    revision: z.number().int().positive(),
    stateVersion: z.number().int().positive(),
    status: z.literal("active"),
  })
  .strict();

const commonObservationFields = {
  observedAt: administrativeTimestampSchema,
  provenance: z.literal("server-recorded-authenticated-api"),
  sequence: z.number().int().positive().max(100),
};

const passingObservationFields = {
  ...commonObservationFields,
  outcome: z.literal("passed"),
  policy: policyObservationSchema,
  releaseCommit: releaseCommitSchema,
};

const passedObservationSchema = z.discriminatedUnion("phase", [
  z
    .object({
      ...passingObservationFields,
      checks: z.object({ authorityCaptured: z.literal(true) }).strict(),
      phase: z.literal("baseline"),
    })
    .strict(),
  z
    .object({
      ...passingObservationFields,
      checks: z
        .object({
          authorityUnchanged: z.literal(true),
          bootIdentityUnchanged: z.literal(true),
          serviceInstanceChanged: z.literal(true),
        })
        .strict(),
      phase: z.literal("service-restart"),
    })
    .strict(),
  z
    .object({
      ...passingObservationFields,
      checks: z
        .object({
          authorityUnchanged: z.literal(true),
          bootIdentityChanged: z.literal(true),
        })
        .strict(),
      phase: z.literal("host-reboot"),
    })
    .strict(),
]);

const failedObservationSchema = z
  .object({
    ...commonObservationFields,
    failure: administrativeRestartWitnessFailureReasonSchema.exclude([
      "campaign-attempt-limit",
      "campaign-completed",
      "campaign-unavailable",
      "challenge-consumed",
      "challenge-mismatch",
      "phase-out-of-order",
    ]),
    outcome: z.literal("failed"),
    phase: administrativeRestartWitnessPhaseSchema,
  })
  .strict();

export const administrativeRestartWitnessObservationSchema = z.union([
  passedObservationSchema,
  failedObservationSchema,
]);
export type AdministrativeRestartWitnessObservation = z.infer<
  typeof administrativeRestartWitnessObservationSchema
>;

export const administrativeRestartWitnessObservationRequestSchema = z
  .object({
    campaignId: administrativeRestartWitnessCampaignIdSchema,
    challenge: administrativeRestartWitnessChallengeSchema,
    csrfToken: z.string().min(1).max(500),
    phase: administrativeRestartWitnessPhaseSchema,
  })
  .strict();
export type AdministrativeRestartWitnessObservationRequest = z.infer<
  typeof administrativeRestartWitnessObservationRequestSchema
>;

export const administrativeRestartWitnessObservationIdentitySchema =
  administrativeRestartWitnessObservationRequestSchema.omit({ csrfToken: true });
export type AdministrativeRestartWitnessObservationIdentity = z.infer<
  typeof administrativeRestartWitnessObservationIdentitySchema
>;

const nextObservationSchema = z
  .object({
    challenge: administrativeRestartWitnessChallengeSchema,
    phase: administrativeRestartWitnessPhaseSchema,
  })
  .strict();

export const administrativeRestartWitnessCampaignSchema = z
  .object({
    campaignId: administrativeRestartWitnessCampaignIdSchema,
    createdAt: administrativeTimestampSchema,
    nextObservation: nextObservationSchema.nullable(),
    observations: z.array(administrativeRestartWitnessObservationSchema).max(100),
    releaseCommit: releaseCommitSchema,
    schemaVersion: z.literal(2),
    status: z.enum(["completed", "pending"]),
  })
  .strict()
  .superRefine((campaign, context) => {
    if ((campaign.nextObservation === null) !== (campaign.status === "completed")) {
      context.addIssue({
        code: "custom",
        message: "Restart Witness campaign status is inconsistent",
        path: ["status"],
      });
    }
  });
export type AdministrativeRestartWitnessCampaign = z.infer<
  typeof administrativeRestartWitnessCampaignSchema
>;

export const administrativeRestartWitnessRecordSchema = z
  .object({
    campaignId: administrativeRestartWitnessCampaignIdSchema,
    createdAt: administrativeTimestampSchema,
    observations: z.array(administrativeRestartWitnessObservationSchema).max(100),
    releaseCommit: releaseCommitSchema,
    schemaVersion: z.literal(2),
    status: z.enum(["completed", "pending"]),
  })
  .strict();
export type AdministrativeRestartWitnessRecord = z.infer<
  typeof administrativeRestartWitnessRecordSchema
>;

export const administrativeRestartWitnessObservationResponseSchema =
  z.discriminatedUnion("decision", [
    z
      .object({
        decision: z.literal("recorded"),
        observation: administrativeRestartWitnessObservationSchema,
      })
      .strict(),
    z
      .object({
        decision: z.literal("denied"),
        reason: administrativeRestartWitnessFailureReasonSchema,
      })
      .strict(),
  ]);
export type AdministrativeRestartWitnessObservationResponse = z.infer<
  typeof administrativeRestartWitnessObservationResponseSchema
>;

export function administrativeRestartWitnessRecord(
  campaign: AdministrativeRestartWitnessCampaign,
): AdministrativeRestartWitnessRecord {
  const { nextObservation: _nextObservation, ...record } =
    administrativeRestartWitnessCampaignSchema.parse(campaign);
  return administrativeRestartWitnessRecordSchema.parse(record);
}
