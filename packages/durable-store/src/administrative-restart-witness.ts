import type {
  AdministrativeRestartWitnessCampaign,
  AdministrativeRestartWitnessCampaignId,
  AdministrativeRestartWitnessChallenge,
  AdministrativeRestartWitnessHostObservation,
  AdministrativeRestartWitnessObservationIdentity,
  AdministrativeRestartWitnessObservationResponse,
  AdministrativeRestartWitnessReleaseCommit,
  AdministrativeRestartWitnessService,
  AdministrativeRestartWitnessServiceInstanceFingerprint,
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
    readonly bootIdentityFingerprint: AdministrativeRestartWitnessServiceInstanceFingerprint;
    readonly candidateInstanceFingerprint: AdministrativeRestartWitnessServiceInstanceFingerprint;
    readonly registeredAt: AdministrativeTimestamp;
    readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
    readonly service: AdministrativeRestartWitnessService;
  }): Promise<AdministrativeRestartWitnessServiceInstanceFingerprint>;
  readServiceInstances(input: {
    readonly bootIdentityFingerprint: AdministrativeRestartWitnessServiceInstanceFingerprint;
    readonly releaseCommit: AdministrativeRestartWitnessReleaseCommit;
  }): Promise<{
    readonly api?: AdministrativeRestartWitnessServiceInstanceFingerprint;
    readonly worker?: AdministrativeRestartWitnessServiceInstanceFingerprint;
  }>;
  readCampaign(
    campaignId: AdministrativeRestartWitnessCampaignId,
  ): Promise<AdministrativeRestartWitnessCampaign | undefined>;
  readCampaignForRelease(
    releaseCommit: AdministrativeRestartWitnessReleaseCommit,
  ): Promise<AdministrativeRestartWitnessCampaign | undefined>;
}
