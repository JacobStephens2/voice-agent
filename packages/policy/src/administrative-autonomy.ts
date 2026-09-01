import {
  administrativePolicyDefinitionSchema,
  type AdministrativeOperationKind,
  type AdministrativePolicyActivationSource,
  type AdministrativePolicyDefinition,
  type AdministrativePolicyStatus,
  type AdministrativeProviderPlan,
  type AdministrativeTaskOutcome,
} from "@voice-agent/contracts";

export const administrativeAutonomyPolicyDefinition: AdministrativePolicyDefinition =
  administrativePolicyDefinitionSchema.parse({
    branchOnlyOperations: ["delegated-worktree.change"],
    forbiddenOperations: [
      "policy.revise",
      "shell.root",
      "credential-custody.read",
      "production-data.mutate",
      "git.production-ref.write",
      "pull-request.merge",
      "deployment.execute",
    ],
    livePatchOperations: ["live-patch.apply"],
    observationalOperations: ["production.observe"],
    schemaVersion: 1,
  });

export type AdministrativePolicyDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

export function authorizeAdministrativePolicyActivation(input: {
  readonly current: AdministrativePolicyStatus;
  readonly expectedActiveRevision: number | null;
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
  if (input.expectedActiveRevision !== activeRevision) {
    return {
      decision: "deny",
      reason: "Administrative Autonomy policy state is stale",
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

const repairOutcomes = new Set<AdministrativeTaskOutcome>([
  "fix",
  "repair",
  "restore",
]);
const proposalOutcomes = new Set<AdministrativeTaskOutcome>([
  "propose",
  "open-pull-request",
]);

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
  if (outcome === "investigate") return new Set(observational);
  const branchOnly = [...observational, ...definition.branchOnlyOperations];
  if (proposalOutcomes.has(outcome)) return new Set(branchOnly);
  if (repairOutcomes.has(outcome)) {
    return new Set([...branchOnly, ...definition.livePatchOperations]);
  }
  return new Set();
}
