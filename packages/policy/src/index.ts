import {
  bountywellRegistrationSchema,
  bountywellDrillNotRegistered,
  bountywellOwnerUnavailable,
  bountywellHealthInquirySchema,
  bountywellOutageReport,
  type BountywellHealthInquiry,
  type BountywellHealthInquiryRequest,
  type BountywellHealthObservation,
  type BountywellHealthTaskConclusion,
  type BountywellHypothesis,
  type BountywellOutageTask,
  type BountywellRegistration,
} from "@voice-agent/contracts";

export * from "./keeplore-delegation.ts";
export * from "./keeplore-trial-promotion.ts";

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
): Extract<
  BountywellHealthTaskConclusion,
  "Bountywell API is healthy." | "Bountywell API health could not be confirmed."
> {
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

export function createBountywellRestartRegistration(
  registeredAt: string,
  revision: number,
): BountywellRegistration {
  return bountywellRegistrationSchema.parse({
    ...createBountywellReadRegistration(registeredAt, revision),
    capabilities: [
      "bountywell.public-health.read",
      "bountywell.authentication-boundary.read",
      "bountywell.local-health.read",
      "bountywell.service-metadata.read",
      "bountywell.resource-evidence.read",
      "bountywell.service.restart",
    ],
  });
}

export function hasBountywellRestartCapability(
  registration: BountywellRegistration | undefined,
): boolean {
  return (
    registration?.capabilities.some(
      (capability) => capability === "bountywell.service.restart",
    ) === true
  );
}

export function denyBountywellAuthorityExpansion(
  source: "repository" | "trusted-session" | "voice",
): string {
  if (source === "trusted-session") return "Fresh Passkey Action required";
  if (source === "voice") {
    return "Voice cannot expand Bountywell service-control authority";
  }
  return "Repository content cannot expand Bountywell service-control authority";
}

export function authorizeBountywellOutageReport(
  report: string,
): typeof bountywellOutageReport {
  if (report !== bountywellOutageReport) {
    throw new Error("Unsupported Bountywell outage report");
  }
  return report;
}

export interface BountywellOutageDiagnosis {
  readonly alreadyRecovered: boolean;
  readonly basis: "inference" | "observation";
  /** Every candidate explanation considered, with what the observation did to it. */
  readonly hypotheses: readonly BountywellHypothesis[];
  readonly inactiveUnit?: "bountywell-api.service";
}

const inactiveUnitHypothesis =
  "The registered bountywell-api.service unit is inactive and explains the unavailable API.";
const recoveredHypothesis =
  "Bountywell already matches the recovered public and service checks.";
const upstreamHypothesis =
  "The registered unit is running and something in front of it makes the API unavailable.";

/**
 * Diagnose the reported unavailability from bounded observation alone, keeping
 * every candidate explanation and the verdict the evidence supports for it.
 */
export function diagnoseBountywellOutage(
  observation: BountywellHealthObservation,
): BountywellOutageDiagnosis {
  const service = observation.checks.find((check) => check.source === "service-state");
  const publicHealth = observation.checks.find((check) => check.source === "public-health");
  const authentication = observation.checks.find(
    (check) => check.source === "authentication-boundary",
  );
  const recovered =
    service?.facts.active === true &&
    publicHealth?.facts.statusCode === 200 &&
    authentication?.facts.statusCode === 401;
  if (recovered) {
    return {
      alreadyRecovered: true,
      basis: "observation",
      hypotheses: [
        { statement: recoveredHypothesis, status: "supported" },
        { statement: inactiveUnitHypothesis, status: "ruled-out" },
        { statement: upstreamHypothesis, status: "ruled-out" },
      ],
    };
  }
  if (service?.facts.active === false) {
    return {
      alreadyRecovered: false,
      basis: "observation",
      hypotheses: [
        { statement: inactiveUnitHypothesis, status: "supported" },
        { statement: recoveredHypothesis, status: "ruled-out" },
        { statement: upstreamHypothesis, status: "ruled-out" },
      ],
      inactiveUnit: "bountywell-api.service",
    };
  }
  return {
    alreadyRecovered: false,
    basis: "inference",
    hypotheses: [
      { statement: recoveredHypothesis, status: "ruled-out" },
      {
        statement: inactiveUnitHypothesis,
        status: service?.facts.active === true ? "ruled-out" : "unresolved",
      },
      {
        statement: upstreamHypothesis,
        status: service?.facts.active === true ? "supported" : "unresolved",
      },
    ],
  };
}

/**
 * Whether one sanitized telephone transcript reports that Bountywell's API is
 * unavailable, in the owner's own words. It classifies the discussion only;
 * what may be recovered is decided by the presented drill itself, so loose
 * phrasing here cannot recover anything that was never presented.
 */
export function transcriptReportsBountywellOutage(text: string): boolean {
  return (
    /\bbountywell\b/iu.test(text) &&
    /\b(unavailable|unreachable|down|offline|not responding)\b/iu.test(text)
  );
}

/**
 * Authorize injecting the drill fault. The owner's asserted availability is not
 * evidence by itself: the live drill runs only while a Telephone Session is
 * carrying the owner, so the fault is never injected into an unattended host.
 */
export function authorizeBountywellFaultInjection(input: {
  readonly assertedAvailable: boolean;
  readonly liveTelephoneSessions: number;
  readonly registration: BountywellRegistration | undefined;
}): {
  readonly capability: "bountywell.outage.drill";
  readonly decision: "allow" | "deny";
  readonly reason: string;
} {
  const registered = authorizeBountywellDrillControl(input.registration);
  if (registered.decision === "deny") return registered;
  if (!input.assertedAvailable || input.liveTelephoneSessions < 1) {
    return {
      capability: "bountywell.outage.drill",
      decision: "deny",
      reason: bountywellOwnerUnavailable,
    };
  }
  return {
    capability: "bountywell.outage.drill",
    decision: "allow",
    reason:
      "The owner is available on a live Telephone Session for the guarded drill.",
  };
}


/**
 * Authorize one owner-initiated Bountywell Outage Drill Intervention. The drill
 * may address only the registered `bountywell-api.service` unit of a registered
 * Bountywell; it does not require the separate restart capability, which
 * authorizes the Voice Agent's own recovery.
 */
export function authorizeBountywellDrillControl(
  registration: BountywellRegistration | undefined,
): {
  readonly capability: "bountywell.outage.drill";
  readonly decision: "allow" | "deny";
  readonly reason: string;
} {
  if (registration?.serviceUnit === "bountywell-api.service") {
    return {
      capability: "bountywell.outage.drill",
      decision: "allow",
      reason:
        "The guarded drill addresses the registered bountywell-api.service unit.",
    };
  }
  return {
    capability: "bountywell.outage.drill",
    decision: "deny",
    reason: bountywellDrillNotRegistered,
  };
}

export function authorizeBountywellRestart(registration: BountywellRegistration | undefined): {
  readonly capability: "bountywell.service.restart";
  readonly decision: "allow" | "deny";
  readonly reason: string;
} {
  if (hasBountywellRestartCapability(registration)) {
    return {
      capability: "bountywell.service.restart",
      decision: "allow",
      reason: "Standing Autonomy Policy permits the registered Bountywell restart.",
    };
  }
  return {
    capability: "bountywell.service.restart",
    decision: "deny",
    reason: "Bountywell restart authority is not enrolled.",
  };
}

export function publicEndpointsRecovered(
  observation: BountywellHealthObservation,
): boolean {
  const publicHealth = observation.checks.find((check) => check.source === "public-health");
  const authentication = observation.checks.find(
    (check) => check.source === "authentication-boundary",
  );
  const service = observation.checks.find((check) => check.source === "service-state");
  return (
    publicHealth?.facts.statusCode === 200 &&
    authentication?.facts.statusCode === 401 &&
    service?.facts.active === true
  );
}

export function deriveBountywellOutageConclusion(input: {
  readonly alreadyRecovered: boolean;
  readonly recovered: boolean;
}): Extract<
  BountywellOutageTask["conclusion"],
  | "Bountywell API was recovered."
  | "Bountywell API was already recovered."
  | "Bountywell API recovery could not be confirmed."
> {
  if (input.alreadyRecovered) return "Bountywell API was already recovered.";
  if (input.recovered) return "Bountywell API was recovered.";
  return "Bountywell API recovery could not be confirmed.";
}

export * from "./keeplore-onboarding.ts";
export * from "./telephone-confirmation.ts";
