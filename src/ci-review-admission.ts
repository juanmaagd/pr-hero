// CI review admission (Pillar 3): decides whether a CI run should spend on
// this push BEFORE fetch/worktree/pipeline. Pure — no I/O. Re-review internals
// (case machine, verify leg) are unchanged; when admission says run, they
// behave exactly as today.
//
// Policy default: at most two reviews per PR (initial + one re-review), and
// a re-review only when prior findings score >= 4 with blocking×2 + advisory×1.

import type { Tier } from "./findings";
import { PR_FINDING_MARKER_PREFIX, parseFindingMarker } from "./pr-preflight";
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
  source: "state" | "admission" | "posted-findings" | "none";
  // Markers for the prior head exist but tier lines could not be read — run
  // rather than treat unknown as zero (silent-loss direction).
  failOpen?: boolean;
}

export interface PostedFindingAdmissionScan {
  blocking: number;
  advisory: number;
  matchedMarkers: number;
  parsedTiers: number;
  // Markers for the prior head exist from untrusted actors only — run rather
  // than let forged comments drive a skip.
  failOpen?: boolean;
}

export interface CiReviewAdmissionInput {
  currentHead: string;
  summaryHead: string | null;
  markerSeen: boolean;
  reviewCount: number;
  state: ParsedStateBlock | null;
  admission: ParsedCiAdmissionBlock | null;
  postedFindings: PostedFindingAdmissionScan | null;
  policy: CiReviewPolicy;
  // New commits since the prior summary touch a path where a prior finding
  // was posted — bypass the below-threshold skip (absorbing-skip fix).
  deltaTouchesPriorFindings: boolean;
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

// GITHUB_ACTOR in Actions plus optional repo-config extras. Undefined when no
// actor is known — callers treat that as "do not filter by author".
export function resolveCiTrustedActors(input: {
  githubActor?: string;
  extra?: readonly string[];
}): ReadonlySet<string> | undefined {
  const actors = new Set<string>();
  if (input.githubActor !== undefined && input.githubActor.length > 0) {
    actors.add(input.githubActor);
  }
  for (const login of input.extra ?? []) {
    if (login.length > 0) actors.add(login);
  }
  return actors.size > 0 ? actors : undefined;
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

// Workflow runs that completed (success or failure) may have consumed budget
// without posting — take the max of the summary counter and distinct run heads.
export function resolveReviewAttemptCount(input: {
  stateCount: number;
  workflowHeads: ReadonlySet<string>;
}): number {
  return Math.max(input.stateCount, input.workflowHeads.size);
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

// Outside-diff findings are a subset of doc.findings; dedupe by id when a
// caller still merges inline + outside buckets.
export function canonicalAdmissionFindings(
  findings: readonly { id: string; tier: Tier }[],
): { id: string; tier: Tier }[] {
  const seen = new Set<string>();
  const out: { id: string; tier: Tier }[] = [];
  for (const finding of findings) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    out.push(finding);
  }
  return out;
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

// Posted inline/issue finding comments carry tier in the header line
// (`report.ts` findingHeaderLine), not in the marker. This is the bootstrap
// fallback when a summary predates `pr-hero-ci-admission` or lost its block.
const FINDING_HEADER_TIER = /^\S+\s+(blocking|advisory)\s+·\s+/;

export function parseFindingCommentTier(body: string): Tier | null {
  if (!body.includes(PR_FINDING_MARKER_PREFIX)) return null;
  let afterMarker = false;
  for (const line of body.split("\n")) {
    if (line.startsWith(PR_FINDING_MARKER_PREFIX)) {
      afterMarker = true;
      continue;
    }
    if (!afterMarker) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = FINDING_HEADER_TIER.exec(trimmed);
    if (match?.[1] === "blocking" || match?.[1] === "advisory") {
      return match[1];
    }
    return null;
  }
  return null;
}

function isTrustedActor(
  user: string | undefined,
  trustedActors: ReadonlySet<string> | undefined,
): boolean {
  if (trustedActors === undefined) return true;
  return user !== undefined && trustedActors.has(user);
}

export function pathsFromPostedFindingMarkers(
  comments: readonly { body: string; user?: string }[],
  summaryHead: string,
  trustedActors?: ReadonlySet<string>,
): string[] {
  const paths = new Set<string>();
  for (const comment of comments) {
    const marker = parseFindingMarker(comment.body);
    if (marker === null || marker.headSha !== summaryHead) continue;
    if (!isTrustedActor(comment.user, trustedActors)) continue;
    paths.add(marker.path);
  }
  return [...paths];
}

export function deltaTouchesPriorFindings(
  changedPaths: readonly string[],
  priorPaths: readonly string[],
): boolean {
  if (priorPaths.length === 0) return false;
  const changed = new Set(changedPaths);
  return priorPaths.some((path) => changed.has(path));
}

export function scanPostedFindingTiers(input: {
  summaryHead: string;
  comments: readonly { body: string; user?: string }[];
  trustedActors?: ReadonlySet<string>;
}): PostedFindingAdmissionScan | null {
  let blocking = 0;
  let advisory = 0;
  let matchedMarkers = 0;
  let parsedTiers = 0;
  let untrustedMarkers = 0;
  const seenFingerprints = new Set<string>();
  for (const comment of input.comments) {
    const marker = parseFindingMarker(comment.body);
    if (marker === null || marker.headSha !== input.summaryHead) continue;
    if (!isTrustedActor(comment.user, input.trustedActors)) {
      untrustedMarkers++;
      continue;
    }
    if (seenFingerprints.has(marker.c)) continue;
    seenFingerprints.add(marker.c);
    matchedMarkers++;
    const tier = parseFindingCommentTier(comment.body);
    if (tier === null) continue;
    parsedTiers++;
    if (tier === "blocking") blocking++;
    else advisory++;
  }
  if (matchedMarkers === 0) {
    if (untrustedMarkers > 0) {
      return {
        blocking: 0,
        advisory: 0,
        matchedMarkers: 0,
        parsedTiers: 0,
        failOpen: true,
      };
    }
    return null;
  }
  return { blocking, advisory, matchedMarkers, parsedTiers };
}

function tierScoreFromCounts(
  counts: { blocking: number; advisory: number },
  policy: CiReviewPolicy,
  source: Exclude<PriorTierScore["source"], "none">,
): PriorTierScore {
  return {
    blocking: counts.blocking,
    advisory: counts.advisory,
    score:
      counts.blocking * policy.blockingWeight +
      counts.advisory * policy.advisoryWeight,
    source,
  };
}

export function priorScoreForAdmission(input: {
  state: ParsedStateBlock | null;
  admission: ParsedCiAdmissionBlock | null;
  postedFindings: PostedFindingAdmissionScan | null;
  policy: CiReviewPolicy;
}): PriorTierScore {
  if (input.state !== null && input.state.findings.length > 0) {
    return priorTierScore(input.state.findings, input.policy);
  }
  if (input.admission !== null) {
    return tierScoreFromCounts(input.admission, input.policy, "admission");
  }
  if (input.postedFindings !== null) {
    if (input.postedFindings.failOpen === true) {
      return {
        blocking: 0,
        advisory: 0,
        score: 0,
        source: "none",
        failOpen: true,
      };
    }
    if (input.postedFindings.parsedTiers > 0) {
      return tierScoreFromCounts(
        input.postedFindings,
        input.policy,
        "posted-findings",
      );
    }
    return {
      blocking: 0,
      advisory: 0,
      score: 0,
      source: "none",
      failOpen: true,
    };
  }
  return { blocking: 0, advisory: 0, score: 0, source: "none" };
}

function priorForAdmissionInput(input: CiReviewAdmissionInput): PriorTierScore {
  return priorScoreForAdmission({
    state: input.state,
    admission: input.admission,
    postedFindings: input.postedFindings,
    policy: input.policy,
  });
}

export function evaluateCiReviewAdmission(
  input: CiReviewAdmissionInput,
): CiReviewAdmissionVerdict {
  if (!input.markerSeen && input.summaryHead === null) {
    return { action: "run" };
  }
  if (input.summaryHead !== null && input.summaryHead === input.currentHead) {
    const prior = priorForAdmissionInput(input);
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
    const prior = priorForAdmissionInput(input);
    return {
      action: "skip",
      reason: "max-reviews",
      prior,
      reviewCount: input.reviewCount,
      maxReviews: input.policy.maxReviews,
      minScore: input.policy.rereviewMinScore,
    };
  }
  const prior = priorForAdmissionInput(input);
  if (prior.failOpen === true) {
    return { action: "run" };
  }
  if (input.deltaTouchesPriorFindings) {
    return { action: "run" };
  }
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
