// The CI review-policy mode enum. Split out of ci/review-admission.ts
// (architecture guard C2): review/preflight.ts validates config's
// `ci_review_policy` field against this list, and ci/review-admission.ts
// imports `parseFindingMarker`/`PR_FINDING_MARKER_PREFIX` (value) from
// pr/preflight.ts, which in turn imports `assertOutsideRepo` (value) from
// review/preflight.ts — so review/preflight.ts importing this enum FROM
// ci/review-admission.ts closed a 3-file value-import cycle. This file has
// no imports of its own — a true leaf every side can depend on one-way.

export const CI_REVIEW_POLICY_MODES = [
  "once_per_pr",
  "thresholded",
  "risk_aware",
  "every_push",
  "manual_only",
] as const;

export type CiReviewPolicyMode = (typeof CI_REVIEW_POLICY_MODES)[number];
