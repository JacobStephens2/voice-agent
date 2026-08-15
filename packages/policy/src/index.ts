import {
  bountywellRegistrationSchema,
  bountywellHealthInquirySchema,
  type BountywellHealthInquiry,
  type BountywellHealthInquiryRequest,
  type BountywellHealthObservation,
  type EvidenceRecordProjection,
  type BountywellRegistration,
} from "@voice-agent/contracts";

export function createBountywellReadRegistration(
  registeredAt: string,
  revision = 1,
): BountywellRegistration {
  return bountywellRegistrationSchema.parse({
    applicationId: "bountywell-production",
    capabilities: [
      "bountywell.public-health.read",
      "bountywell.authentication-boundary.read",
      "bountywell.local-health.read",
      "bountywell.service-metadata.read",
      "bountywell.resource-evidence.read",
    ],
    healthSemantics: {
      authenticationBoundary: { expectedStatus: 401, path: "/api/data" },
      primary: { expectedStatus: 200, path: "/api/health" },
      registeredLocal: {
        expectedStatus: 200,
        path: "/api/health",
        port: 3000,
      },
    },
    publicOrigin: "https://bountywell.com",
    registeredAt,
    revision,
    serviceUnit: "bountywell-api.service",
  });
}

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
  const hasPassingPrimaryHealth = observation.checks.some(
    (check) =>
      check.outcome === "pass" &&
      check.source === "public-health" &&
      check.facts.statusCode === 200,
  );
  const everyCheckPassed = observation.checks.every(
    (check) => check.outcome === "pass",
  );

  return hasPassingPrimaryHealth && everyCheckPassed
    ? "Bountywell API is healthy."
    : "Bountywell API health could not be confirmed.";
}
