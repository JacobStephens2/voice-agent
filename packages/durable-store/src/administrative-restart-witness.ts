import type {
  AdministrativeRestartWitnessCampaign,
  AdministrativeRestartWitnessApiServiceInstanceFingerprint,
  AdministrativeRestartWitnessBootIdentityFingerprint,
  AdministrativeRestartWitnessCampaignId,
  AdministrativeRestartWitnessChallenge,
  AdministrativeRestartWitnessHostObservation,
  AdministrativeRestartWitnessObservationIdentity,
  AdministrativeRestartWitnessObservationResponse,
  AdministrativeRestartWitnessReleaseCommit,
  AdministrativeRestartWitnessWorkerServiceInstanceFingerprint,
  AdministrativeTimestamp,
} from "@voice-agent/contracts";

export interface AdministrativeRestartWitnessStore {
  close(): Promise<void>;
  ensureCampaign(input: {
    readonly campaignId: AdministrativeRestartWitnessCampaignId;
    readonly createdAt: AdministrativeTimestamp;
    readonly initialChallenge: AdministrativeRestartWitnessChallenge;
    readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  }): Promise<AdministrativeRestartWitnessCampaign>;
  observe(input: {
    readonly identity: AdministrativeRestartWitnessObservationIdentity;
    readonly nextChallenge: AdministrativeRestartWitnessChallenge;
    readonly observedAt: AdministrativeTimestamp;
    readonly observation: AdministrativeRestartWitnessHostObservation;
  }): Promise<AdministrativeRestartWitnessObservationResponse>;
  recordHostObservationFailure(input: {
    readonly failure:
      | "host-observation-unavailable"
      | "worker-observation-unavailable";
    readonly identity: AdministrativeRestartWitnessObservationIdentity;
    readonly nextChallenge: AdministrativeRestartWitnessChallenge;
    readonly observedAt: AdministrativeTimestamp;
  }): Promise<AdministrativeRestartWitnessObservationResponse>;
  registerServiceInstance(input: {
    readonly bootIdentityFingerprint: AdministrativeRestartWitnessBootIdentityFingerprint;
    readonly registeredAt: AdministrativeTimestamp;
    readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  } & (
    | {
        readonly candidateInstanceFingerprint: AdministrativeRestartWitnessApiServiceInstanceFingerprint;
        readonly service: "api";
      }
    | {
        readonly candidateInstanceFingerprint: AdministrativeRestartWitnessWorkerServiceInstanceFingerprint;
        readonly service: "worker";
      }
  )): Promise<
    | AdministrativeRestartWitnessApiServiceInstanceFingerprint
    | AdministrativeRestartWitnessWorkerServiceInstanceFingerprint
  >;
  readServiceInstances(input: {
    readonly bootIdentityFingerprint: AdministrativeRestartWitnessBootIdentityFingerprint;
    readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  }): Promise<{
    readonly api?: AdministrativeRestartWitnessApiServiceInstanceFingerprint;
    readonly worker?: AdministrativeRestartWitnessWorkerServiceInstanceFingerprint;
  }>;
  readCampaign(
    campaignId: AdministrativeRestartWitnessCampaignId,
  ): Promise<AdministrativeRestartWitnessCampaign | undefined>;
  readCampaignForRelease(
    releaseCommit: AdministrativeRestartWitnessReleaseCommit,
  ): Promise<AdministrativeRestartWitnessCampaign | undefined>;
}
