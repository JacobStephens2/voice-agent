import {
  bountywellHealthInquirySchema,
  type BountywellHealthInquiry,
  type BountywellHealthInquiryRequest,
  type BountywellHealthObservation,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";

export function authorizeBountywellHealthInquiry(
  request: BountywellHealthInquiryRequest,
): BountywellHealthInquiry {
  const decision = bountywellHealthInquirySchema.safeParse(request);
  if (!decision.success) {
    throw new Error("Unsupported Bountywell health inquiry");
  }
  return decision.data;
}

export function deriveBountywellHealthConclusion(
  observation: BountywellHealthObservation,
): EvidenceRecordProjection["task"]["conclusion"] {
  const hasPassingApiEvidence = observation.checks.some(
    (check) =>
      check.outcome === "pass" &&
      (check.source === "public-health" ||
        check.source === "authentication-boundary"),
  );
  const everyCheckPassed = observation.checks.every(
    (check) => check.outcome === "pass",
  );

  return hasPassingApiEvidence && everyCheckPassed
    ? "Bountywell API is healthy."
    : "Bountywell API health could not be confirmed.";
}
