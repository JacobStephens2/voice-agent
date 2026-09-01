import {
  administrativePolicyDefinitionSchema,
  forbiddenAdministrativeOperationKinds,
  type AdministrativeOperationKind,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyActivationExpectation,
  type AdministrativePolicyDefinition,
  type AdministrativePolicyStatus,
  type AdministrativePublicationIntent,
  type AdministrativeProviderPlan,
  type AdministrativeRequestedOutcome,
  type AdministrativeTaskOutcome,
} from "@voice-agent/contracts";

export const administrativeAutonomyPolicyDefinition: AdministrativePolicyDefinition =
  administrativePolicyDefinitionSchema.parse({
    branchOnlyOperations: ["delegated-worktree.change"],
    forbiddenOperations: forbiddenAdministrativeOperationKinds,
    livePatchOperations: ["live-patch.apply"],
    observationalOperations: ["production.observe"],
    schemaVersion: 1,
  });

export type AdministrativePolicyDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

export function authorizeAdministrativePolicyActivation(input: {
  readonly current: AdministrativePolicyStatus;
  readonly expectation: AdministrativePolicyActivationExpectation;
  readonly runtimeExecutionManifestFingerprint: string;
  readonly source: AdministrativePolicyActivationSource;
}): AdministrativePolicyDecision {
  if (input.source !== "fresh-passkey-action") {
    return {
      decision: "deny",
      reason:
        input.source === "trusted-browser-session"
          ? "Fresh Passkey Action required"
          : input.source === "voice"
            ? "Voice cannot activate Administrative Autonomy"
            : "Untrusted instructions cannot activate Administrative Autonomy",
    };
  }
  const activeRevision =
    input.current.status === "inactive" ? null : input.current.revision;
  if (
    input.expectation.expectedActiveRevision !== activeRevision ||
    input.expectation.expectedStateVersion !== input.current.stateVersion
  ) {
    return {
      decision: "deny",
      reason: "Administrative Autonomy policy state is stale",
    };
  }
  if (
    input.expectation.expectedExecutionManifestFingerprint !==
    input.runtimeExecutionManifestFingerprint
  ) {
    return {
      decision: "deny",
      reason: "Administrative execution manifest changed after it was observed",
    };
  }
  return { decision: "allow" };
}

export function authorizeAdministrativeTaskConfirmation(input: {
  readonly confirmation: "ambiguous" | "confirmed" | "declined";
}): AdministrativePolicyDecision {
  if (input.confirmation !== "confirmed") {
    return {
      decision: "deny",
      reason:
        input.confirmation === "ambiguous"
          ? "Task Confirmation remains ambiguous"
          : "Task Confirmation was declined",
    };
  }
  return { decision: "allow" };
}

/**
 * The ticket's user-facing “fix, repair, restore” phrases all request the
 * domain's Intervention outcome. The avoided synonym `fix` never crosses the
 * admission seam into Durable Task state or Evidence Events.
 */
export function canonicalAdministrativeOutcome(
  requested: AdministrativeRequestedOutcome,
): AdministrativeTaskOutcome {
  if (
    requested === "fix" ||
    requested === "repair" ||
    requested === "restore"
  ) {
    return "intervention";
  }
  if (requested === "propose" || requested === "open-pull-request") {
    return "proposal";
  }
  return "investigation";
}

export function canonicalAdministrativeIntent(
  requested: AdministrativeRequestedOutcome,
): {
  readonly outcome: AdministrativeTaskOutcome;
  readonly publicationIntent: AdministrativePublicationIntent;
} {
  return {
    outcome: canonicalAdministrativeOutcome(requested),
    publicationIntent:
      requested === "open-pull-request" ? "open-pull-request" : "branch-only",
  };
}

export function authorizeAdministrativePlan(input: {
  readonly definition: AdministrativePolicyDefinition;
  readonly outcome: AdministrativeTaskOutcome;
  readonly plan: AdministrativeProviderPlan;
}): AdministrativePolicyDecision {
  const definition = administrativePolicyDefinitionSchema.parse(
    input.definition,
  );
  const kinds = input.plan.map((operation) => operation.kind);
  if (new Set(kinds).size !== kinds.length) {
    return {
      decision: "deny",
      reason: "An Administrative Operation kind may appear only once per plan",
    };
  }
  const allowed = allowedOperationKinds(definition, input.outcome);
  const denied = kinds.find((kind) => !allowed.has(kind));
  if (denied !== undefined) {
    return {
      decision: "deny",
      reason: `${denied} exceeds the confirmed ${input.outcome} outcome`,
    };
  }
  return { decision: "allow" };
}

function allowedOperationKinds(
  definition: AdministrativePolicyDefinition,
  outcome: AdministrativeTaskOutcome,
): ReadonlySet<AdministrativeOperationKind> {
  const observational = definition.observationalOperations;
  if (outcome === "investigation") return new Set(observational);
  const branchOnly = [...observational, ...definition.branchOnlyOperations];
  if (outcome === "proposal") return new Set(branchOnly);
  if (outcome === "intervention") {
    return new Set([...branchOnly, ...definition.livePatchOperations]);
  }
  return new Set();
}
