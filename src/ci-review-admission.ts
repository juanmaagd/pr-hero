// CI review admission (Pillar 3): decides whether a CI run should spend on
// this push BEFORE fetch/worktree/pipeline. Pure — no I/O. Re-review internals
// (case machine, verify leg) are unchanged; when admission says run, they
// behave exactly as today.
//
// Policy default: at most two reviews per PR (initial + one re-review), and
// a re-review only when prior findings score >= 4 with blocking×2 + advisory×1.

import type { Tier } from "./findings";
import type { LocalConfig } from "./preflight";
import type { ParsedStateBlock } from "./rereview-state";

export const DEFAULT_CI_MAX_REVIEWS = 2;
export const DEFAULT_CI_REREVIEW_MIN_SCORE = 4;
export const DEFAULT_CI_BLOCKING_WEIGHT = 2;
export const DEFAULT_CI_ADVISORY_WEIGHT = 1;

export interface CiReviewPolicy {
  maxReviews: number;
  rereviewMinScore: number;
  blockingWeight: number;
  advisoryWeight: number;
}

export type CiReviewSkipReason =
  | "same-head"
  | "max-reviews"
  | "below-threshold";

export interface PriorTierScore {
  blocking: number;
  advisory: number;
  score: number;
  source: "state" | "summary" | "none";
}

export interface CiReviewAdmissionInput {
  currentHead: string;
  summaryHead: string | null;
  summaryBody: string | null;
  markerSeen: boolean;
  reviewCount: number;
  state: ParsedStateBlock | null;
  policy: CiReviewPolicy;
}

export type CiReviewAdmissionVerdict =
  | { action: "run" }
  | {
      action: "skip";
      reason: CiReviewSkipReason;
      prior: PriorTierScore;
      reviewCount: number;
      maxReviews: number;
      minScore: number;
    };

export function resolveCiReviewPolicy(
  config: Pick<
    LocalConfig,
    | "ci_max_reviews"
    | "ci_rereview_min_score"
    | "ci_blocking_weight"
    | "ci_advisory_weight"
  >,
): CiReviewPolicy {
  return {
    maxReviews: config.ci_max_reviews ?? DEFAULT_CI_MAX_REVIEWS,
    rereviewMinScore:
      config.ci_rereview_min_score ?? DEFAULT_CI_REREVIEW_MIN_SCORE,
    blockingWeight: config.ci_blocking_weight ?? DEFAULT_CI_BLOCKING_WEIGHT,
    advisoryWeight: config.ci_advisory_weight ?? DEFAULT_CI_ADVISORY_WEIGHT,
  };
}

export function stateReviewCount(
  state: ParsedStateBlock | null,
  markerSeen: boolean,
): number {
  if (
    state?.reviews !== undefined &&
    Number.isInteger(state.reviews) &&
    state.reviews >= 1
  ) {
    return state.reviews;
  }
  return markerSeen ? 1 : 0;
}

export function nextStateReviewCount(input: {
  existingSummaryId: number | null;
  state: ParsedStateBlock | null;
}): number {
  const current = stateReviewCount(
    input.state,
    input.existingSummaryId !== null,
  );
  return current + 1;
}

export function priorTierScore(
  findings: readonly { tier: Tier }[],
  weights: Pick<CiReviewPolicy, "blockingWeight" | "advisoryWeight">,
): PriorTierScore {
  let blocking = 0;
  let advisory = 0;
  for (const finding of findings) {
    if (finding.tier === "blocking") blocking++;
    else advisory++;
  }
  return {
    blocking,
    advisory,
    score: blocking * weights.blockingWeight + advisory * weights.advisoryWeight,
    source: "state",
  };
}

// Headline uses hunter severity glyphs, not tier — close enough for admission
// when the state block is absent (first-review posts before item-7 framing).
const SUMMARY_TIER_COUNTS =
  /🔴 (\d+) critical · 🟡 (\d+) warning/;

export function parsePostedSummaryTierCounts(
  body: string,
): { blocking: number; advisory: number } | null {
  const match = SUMMARY_TIER_COUNTS.exec(body);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const blocking = Number(match[1]);
  const advisory = Number(match[2]);
  if (!Number.isFinite(blocking) || !Number.isFinite(advisory)) return null;
  return { blocking, advisory };
}

export function priorScoreForAdmission(input: {
  state: ParsedStateBlock | null;
  summaryBody: string | null;
  policy: CiReviewPolicy;
}): PriorTierScore {
  if (input.state !== null && input.state.findings.length > 0) {
    return priorTierScore(input.state.findings, input.policy);
  }
  if (input.summaryBody !== null) {
    const counts = parsePostedSummaryTierCounts(input.summaryBody);
    if (counts !== null) {
      return {
        blocking: counts.blocking,
        advisory: counts.advisory,
        score:
          counts.blocking * input.policy.blockingWeight +
          counts.advisory * input.policy.advisoryWeight,
        source: "summary",
      };
    }
  }
  return { blocking: 0, advisory: 0, score: 0, source: "none" };
}

export function evaluateCiReviewAdmission(
  input: CiReviewAdmissionInput,
): CiReviewAdmissionVerdict {
  if (!input.markerSeen && input.summaryHead === null) {
    return { action: "run" };
  }
  if (
    input.summaryHead !== null &&
    input.summaryHead === input.currentHead
  ) {
    const prior = priorScoreForAdmission(input);
    return {
      action: "skip",
      reason: "same-head",
      prior,
      reviewCount: input.reviewCount,
      maxReviews: input.policy.maxReviews,
      minScore: input.policy.rereviewMinScore,
    };
  }
  if (input.reviewCount >= input.policy.maxReviews) {
    const prior = priorScoreForAdmission(input);
    return {
      action: "skip",
      reason: "max-reviews",
      prior,
      reviewCount: input.reviewCount,
      maxReviews: input.policy.maxReviews,
      minScore: input.policy.rereviewMinScore,
    };
  }
  const prior = priorScoreForAdmission(input);
  if (prior.score < input.policy.rereviewMinScore) {
    return {
      action: "skip",
      reason: "below-threshold",
      prior,
      reviewCount: input.reviewCount,
      maxReviews: input.policy.maxReviews,
      minScore: input.policy.rereviewMinScore,
    };
  }
  return { action: "run" };
}

export function ciReviewSkipDetail(
  verdict: Extract<CiReviewAdmissionVerdict, { action: "skip" }>,
): string {
  const { prior, reason, reviewCount, maxReviews, minScore } = verdict;
  const counts =
    prior.source === "none"
      ? "no prior findings recorded"
      : `${prior.blocking} blocking-tier · ${prior.advisory} advisory-tier (score ${prior.score})`;
  switch (reason) {
    case "same-head":
      return "this commit was already reviewed";
    case "max-reviews":
      return (
        `review limit reached (${reviewCount}/${maxReviews} reviews on this PR)`
      );
    case "below-threshold":
      return (
        `${counts}; re-review needs score ≥ ${minScore} to justify another run`
      );
  }
}
