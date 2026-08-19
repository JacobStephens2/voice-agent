import { useState } from "react";

import type {
  KeeploreLiveInspection,
  KeeploreRegistration,
  KeeploreWorkingTreeReconciliation,
} from "@voice-agent/contracts";

const reconciliationOutcomes = [
  "already-clean",
  "committed-by-owner",
  "preserved-on-branch",
  "stashed-by-owner",
] as const;

export function KeeploreOnboardingControl(props: {
  busy: boolean;
  inspection?: KeeploreLiveInspection | undefined;
  onActivateDeploymentContract(): Promise<void>;
  onEnroll(reconciliation: KeeploreWorkingTreeReconciliation): Promise<void>;
  onInspect(): Promise<void>;
  registration?: KeeploreRegistration | undefined;
}) {
  const [outcome, setOutcome] =
    useState<KeeploreWorkingTreeReconciliation["outcome"]>("already-clean");
  const [preservedRef, setPreservedRef] = useState("");
  const uncommittedPaths = props.inspection?.uncommittedPaths ?? [];

  return (
    <section className="bountywell-control" aria-labelledby="keeplore-heading">
      <p className="eyebrow">Registered application</p>
      <h2 id="keeplore-heading">Keeplore production</h2>
      {props.inspection === undefined ? (
        <>
          <p>
            Revalidate the live Keeplore checkout before anything pulls,
            branches, builds, or deploys. The inspection is read-only.
          </p>
          <button disabled={props.busy} onClick={() => void props.onInspect()}>
            Inspect live Keeplore checkout
          </button>
        </>
      ) : (
        <>
          <p>
            {props.inspection.repository} on{" "}
            {props.inspection.productionBranch} at{" "}
            {props.inspection.liveCheckoutPath}, served by{" "}
            {props.inspection.servingEdge} from{" "}
            {props.inspection.documentRoots.ui} and{" "}
            {props.inspection.documentRoots.api}. Verification:{" "}
            {props.inspection.verificationCommands.join(", ")}.
          </p>
          <p>
            Shared runtime state:{" "}
            {props.inspection.sharedPaths.length === 0
              ? "none declared"
              : props.inspection.sharedPaths.join(", ")}
          </p>
          <p>
            {uncommittedPaths.length === 0
              ? "The live working tree is clean."
              : `${uncommittedPaths.length} uncommitted path(s): ${uncommittedPaths.join(", ")}`}
          </p>
        </>
      )}
      {props.registration === undefined ? (
        props.inspection === undefined ? null : (
          <>
            <p>
              Record how you reconciled and preserved the live work, then enroll
              Keeplore with a Fresh Passkey Action.
            </p>
            <label>
              Reconciliation
              <select
                value={outcome}
                onChange={(event) =>
                  setOutcome(
                    event.target
                      .value as KeeploreWorkingTreeReconciliation["outcome"],
                  )
                }
              >
                {reconciliationOutcomes.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            {outcome === "preserved-on-branch" ? (
              <label>
                Preserved reference
                <input
                  value={preservedRef}
                  onChange={(event) => setPreservedRef(event.target.value)}
                />
              </label>
            ) : null}
            <button
              disabled={props.busy}
              onClick={() =>
                void props.onEnroll({
                  outcome,
                  ...(outcome === "preserved-on-branch" && preservedRef !== ""
                    ? { preservedRef }
                    : {}),
                  reconciledAt: new Date().toISOString(),
                  reconciledBy: "owner",
                  remainingUncommittedPaths: [],
                })
              }
            >
              Enroll Keeplore
            </button>
          </>
        )
      ) : (
        <>
          <p>
            Keeplore is registered at revision {props.registration.revision} with
            the {props.registration.verification.checkName} check, worktrees under{" "}
            {props.registration.worktreeRoot}, and Releases under{" "}
            {props.registration.deploymentBoundaries.releaseRoot}. Delegation is
            limited to {props.registration.permittedSubagentProvider}.
          </p>
          <button
            disabled={props.busy}
            onClick={() => void props.onActivateDeploymentContract()}
          >
            Activate Keeplore Deployment Contract
          </button>
        </>
      )}
    </section>
  );
}
