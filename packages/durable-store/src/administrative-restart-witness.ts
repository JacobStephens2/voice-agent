import type {
  AdministrativeRestartWitnessCampaign,
  AdministrativeRestartWitnessCampaignId,
  AdministrativeRestartWitnessChallenge,
  AdministrativeRestartWitnessHostObservation,
  AdministrativeRestartWitnessObservationIdentity,
  AdministrativeRestartWitnessObservationResponse,
  AdministrativeTimestamp,
} from "@voice-agent/contracts";

export interface AdministrativeRestartWitnessStore {
  close(): Promise<void>;
  ensureCampaign(input: {
    readonly campaignId: AdministrativeRestartWitnessCampaignId;
    readonly createdAt: AdministrativeTimestamp;
    readonly initialChallenge: AdministrativeRestartWitnessChallenge;
    readonly releaseCommit: string;
  }): Promise<AdministrativeRestartWitnessCampaign>;
  observe(input: {
    readonly identity: AdministrativeRestartWitnessObservationIdentity;
    readonly nextChallenge: AdministrativeRestartWitnessChallenge;
    readonly observedAt: AdministrativeTimestamp;
    readonly observation: AdministrativeRestartWitnessHostObservation;
  }): Promise<AdministrativeRestartWitnessObservationResponse>;
  recordHostObservationFailure(input: {
    readonly identity: AdministrativeRestartWitnessObservationIdentity;
    readonly nextChallenge: AdministrativeRestartWitnessChallenge;
    readonly observedAt: AdministrativeTimestamp;
  }): Promise<AdministrativeRestartWitnessObservationResponse>;
  readCampaign(
    campaignId: AdministrativeRestartWitnessCampaignId,
  ): Promise<AdministrativeRestartWitnessCampaign | undefined>;
  readCampaignForRelease(
    releaseCommit: string,
  ): Promise<AdministrativeRestartWitnessCampaign | undefined>;
}
