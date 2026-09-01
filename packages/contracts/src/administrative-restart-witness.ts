import { z } from "zod";

import {
  administrativeExecutionManifestFingerprintSchema,
  administrativeTimestampSchema,
} from "./administrative-autonomy.ts";

export const administrativeRestartWitnessReleaseCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u)
  .brand<"AdministrativeRestartWitnessReleaseCommit">();
export type AdministrativeRestartWitnessReleaseCommit = z.infer<
  typeof administrativeRestartWitnessReleaseCommitSchema
>;

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

const restartWitnessFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u);

export const administrativeRestartWitnessApiServiceInstanceFingerprintSchema =
  restartWitnessFingerprintSchema.brand<"AdministrativeRestartWitnessApiServiceInstanceFingerprint">();
export type AdministrativeRestartWitnessApiServiceInstanceFingerprint = z.infer<
  typeof administrativeRestartWitnessApiServiceInstanceFingerprintSchema
>;

export const administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema =
  restartWitnessFingerprintSchema.brand<"AdministrativeRestartWitnessWorkerServiceInstanceFingerprint">();
export type AdministrativeRestartWitnessWorkerServiceInstanceFingerprint =
  z.infer<
    typeof administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema
  >;

export const administrativeRestartWitnessBootIdentityFingerprintSchema =
  restartWitnessFingerprintSchema.brand<"AdministrativeRestartWitnessBootIdentityFingerprint">();
export type AdministrativeRestartWitnessBootIdentityFingerprint = z.infer<
  typeof administrativeRestartWitnessBootIdentityFingerprintSchema
>;

export const administrativeRestartWitnessServiceSchema = z.enum([
  "api",
  "worker",
]);
export type AdministrativeRestartWitnessService = z.infer<
  typeof administrativeRestartWitnessServiceSchema
>;

export const administrativeRestartWitnessHostObservationSchema = z
  .object({
    apiServiceInstanceFingerprint:
      administrativeRestartWitnessApiServiceInstanceFingerprintSchema,
    bootIdentityFingerprint:
      administrativeRestartWitnessBootIdentityFingerprintSchema,
    releaseCommit: administrativeRestartWitnessReleaseCommitSchema,
    workerServiceInstanceFingerprint:
      administrativeRestartWitnessWorkerServiceInstanceFingerprintSchema,
  })
  .strict();
export type AdministrativeRestartWitnessHostObservation = z.infer<
  typeof administrativeRestartWitnessHostObservationSchema
>;

export const administrativeRestartWitnessFailureReasonSchema = z.enum([
  "api-service-instance-changed-during-host-reboot",
  "api-service-instance-unchanged",
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
  "worker-observation-unavailable",
  "worker-service-instance-changed-during-host-reboot",
  "worker-service-instance-unchanged",
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
  sequence: z.number().int().positive(),
};

const passingObservationFields = {
  ...commonObservationFields,
  outcome: z.literal("passed"),
  policy: policyObservationSchema,
  releaseCommit: administrativeRestartWitnessReleaseCommitSchema,
};

const currentPassedObservationSchema = z.discriminatedUnion("phase", [
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
          apiServiceInstanceChanged: z.literal(true),
          bootIdentityUnchanged: z.literal(true),
          workerServiceInstanceChanged: z.literal(true),
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
          apiServiceInstanceStable: z.literal(true),
          bootIdentityChanged: z.literal(true),
          workerServiceInstanceStable: z.literal(true),
        })
        .strict(),
      phase: z.literal("host-reboot"),
    })
    .strict(),
]);

// V2 observations remain readable append-only evidence. They cannot satisfy
// the V3 campaign because they did not witness the worker service.
const legacyPassedObservationSchema = z.discriminatedUnion("phase", [
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
  currentPassedObservationSchema,
  legacyPassedObservationSchema,
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
    releaseCommit: administrativeRestartWitnessReleaseCommitSchema,
    schemaVersion: z.literal(3),
    status: z.enum(["completed", "migration-required", "pending"]),
  })
  .strict()
  .superRefine((campaign, context) => {
    if (
      (campaign.status === "pending") !== (campaign.nextObservation !== null)
    ) {
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
    releaseCommit: administrativeRestartWitnessReleaseCommitSchema,
    schemaVersion: z.literal(3),
    status: z.enum(["completed", "migration-required", "pending"]),
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
