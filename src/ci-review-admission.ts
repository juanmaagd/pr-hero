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
  source: "state" | "admission" | "none";
}

export interface CiReviewAdmissionInput {
  currentHead: string;
  summaryHead: string | null;
  markerSeen: boolean;
  reviewCount: number;
  state: ParsedStateBlock | null;
  admission: ParsedCiAdmissionBlock | null;
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
  admission: ParsedCiAdmissionBlock | null = null,
): number {
  if (
    state?.reviews !== undefined &&
    Number.isInteger(state.reviews) &&
    state.reviews >= 1
  ) {
    return state.reviews;
  }
  if (admission !== null) {
    return admission.reviews;
  }
  return markerSeen ? 1 : 0;
}

export function nextStateReviewCount(input: {
  existingSummaryId: number | null;
  state: ParsedStateBlock | null;
  summaryBody?: string | null;
}): number {
  const admission =
    input.summaryBody === undefined || input.summaryBody === null
      ? null
      : parseCiAdmissionBlock(input.summaryBody);
  const current = stateReviewCount(
    input.state,
    input.existingSummaryId !== null,
    admission,
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
    score:
      blocking * weights.blockingWeight + advisory * weights.advisoryWeight,
    source: "state",
  };
}

// First reviews carry no item-7 `pr-hero-state` block (W-prov), but CI admission
// still needs true tier counts. A separate marker keeps item-7 semantics intact
// while giving the gate tier-accurate data on every post.
export const PR_CI_ADMISSION_PREFIX = "<!-- pr-hero-ci-admission ";
const CI_ADMISSION_HEADER =
  /^<!-- pr-hero-ci-admission v=1 head=([0-9a-f]{40}) -->/;
const HTML_COMMENT = /<!--([\s\S]*?)-->/;

export interface ParsedCiAdmissionBlock {
  headSha: string;
  blocking: number;
  advisory: number;
  reviews: number;
}

export function tierCountsFromFindings(findings: readonly { tier: Tier }[]): {
  blocking: number;
  advisory: number;
} {
  let blocking = 0;
  let advisory = 0;
  for (const finding of findings) {
    if (finding.tier === "blocking") blocking++;
    else advisory++;
  }
  return { blocking, advisory };
}

export function renderCiAdmissionBlock(
  headSha: string,
  counts: { blocking: number; advisory: number },
  reviews: number,
): string {
  const payload = JSON.stringify({
    blocking: counts.blocking,
    advisory: counts.advisory,
    reviews,
  });
  return (
    `${PR_CI_ADMISSION_PREFIX}v=1 head=${headSha} -->\n` +
    `<!-- ${encodeCiAdmissionJson(payload)} -->`
  );
}

export function parseCiAdmissionBlock(
  body: string,
): ParsedCiAdmissionBlock | null {
  const start = body.indexOf(PR_CI_ADMISSION_PREFIX);
  if (start === -1) return null;
  const fromMarker = body.slice(start);
  const headerLine = fromMarker.split("\n", 1)[0] ?? "";
  const header = CI_ADMISSION_HEADER.exec(headerLine);
  if (header?.[1] === undefined) return null;
  const afterHeader = fromMarker.slice(headerLine.length);
  const jsonComment = HTML_COMMENT.exec(afterHeader);
  if (jsonComment?.[1] === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(jsonComment[1].trim());
    if (typeof parsed !== "object" || parsed === null) return null;
    const row = parsed as Record<string, unknown>;
    const blocking = row.blocking;
    const advisory = row.advisory;
    const reviews = row.reviews;
    if (
      typeof blocking !== "number" ||
      !Number.isInteger(blocking) ||
      blocking < 0 ||
      typeof advisory !== "number" ||
      !Number.isInteger(advisory) ||
      advisory < 0 ||
      typeof reviews !== "number" ||
      !Number.isInteger(reviews) ||
      reviews < 1
    ) {
      return null;
    }
    return { headSha: header[1], blocking, advisory, reviews };
  } catch {
    return null;
  }
}

function encodeCiAdmissionJson(value: string): string {
  return value
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
    .replaceAll("-->", "--\\u003e");
}

export function priorScoreForAdmission(input: {
  state: ParsedStateBlock | null;
  admission: ParsedCiAdmissionBlock | null;
  policy: CiReviewPolicy;
}): PriorTierScore {
  if (input.state !== null && input.state.findings.length > 0) {
    return priorTierScore(input.state.findings, input.policy);
  }
  if (input.admission !== null) {
    return {
      blocking: input.admission.blocking,
      advisory: input.admission.advisory,
      score:
        input.admission.blocking * input.policy.blockingWeight +
        input.admission.advisory * input.policy.advisoryWeight,
      source: "admission",
    };
  }
  return { blocking: 0, advisory: 0, score: 0, source: "none" };
}

export function evaluateCiReviewAdmission(
  input: CiReviewAdmissionInput,
): CiReviewAdmissionVerdict {
  if (!input.markerSeen && input.summaryHead === null) {
    return { action: "run" };
  }
  if (input.summaryHead !== null && input.summaryHead === input.currentHead) {
    const prior = priorScoreForAdmission({
      state: input.state,
      admission: input.admission,
      policy: input.policy,
    });
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
    const prior = priorScoreForAdmission({
      state: input.state,
      admission: input.admission,
      policy: input.policy,
    });
    return {
      action: "skip",
      reason: "max-reviews",
      prior,
      reviewCount: input.reviewCount,
      maxReviews: input.policy.maxReviews,
      minScore: input.policy.rereviewMinScore,
    };
  }
  const prior = priorScoreForAdmission({
    state: input.state,
    admission: input.admission,
    policy: input.policy,
  });
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
      return `review limit reached (${reviewCount}/${maxReviews} reviews on this PR)`;
    case "below-threshold":
      return `${counts}; re-review needs score ≥ ${minScore} to justify another run`;
  }
}
