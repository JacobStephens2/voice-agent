import type { PromotionEvidenceRecordProjection } from "@voice-agent/contracts";

/**
 * One label per Promotion Evidence Event kind, shared by every page that
 * renders that history. Both the Promotion and Keeplore onboarding records
 * project the same event kinds, so a new kind is named once here rather than
 * added to each page in turn.
 */
export const promotionEventLabels: Record<
  PromotionEvidenceRecordProjection["evidence"][number]["kind"],
  string
> = {
  "admission.paused": "Call Admission paused",
  "admission.reopened": "Call Admission reopened",
  "authority.drift-observed": "Pinned Deployment Authority diverges",
  "circuit.changed": "Circuit state changed",
  "delivery.denied": "Delivery denied",
  "delivery.duplicate": "Duplicate delivery ignored",
  "merge.accepted": "Human Merge accepted",
  "promotion.queued": "Promotion Attempt queued",
  "promotion.reordered": "Promotion Attempt reordered",
  "reconciliation.discovered": "Missed Human Merge discovered",
  "release.built": "Release built",
  "release.preflighted": "Preflight completed",
  "release.rolled-back": "Prior Release restored",
  "release.switched": "Release switched",
  "release.verified": "Release verified",
  "safe-point.reached": "Promotion Safe Point reached",
  "work.disposed": "Active work disposition recorded",
};
