// Impure-half orchestration for item 7 discovery (`docs/item7-rereview-design.md`
// §3.1). Git facts arrive through `RereviewGit` so the CLI owns `cat-file`,
// `merge-base --is-ancestor`, and `diff --name-only`, and tests inject fakes.
// The case machine itself stays in rereview-plan.ts.

import { normalizePath } from "./compare";
import type { Severity } from "./findings";
import { claimFingerprint } from "./pr-preflight";
import {
  classifyPrior,
  type PhaseBResult,
  type PriorRecord,
  type PriorTriage,
  type RereviewCase,
} from "./rereview-classify";
import {
  type FindingIdentity,
  IDENTITY_LINE_WINDOW,
  identityFromLocs,
} from "./rereview-identity";
import {
  type DiscoveryPlan,
  decideRereviewCase,
  type LastHeadSource,
  type LastReviewedHead,
  type MarkerHead,
  planDiscovery,
  resolveLastReviewedHead,
  restrictedDiscoveryFiles,
} from "./rereview-plan";
import type { LiveFinding, StateFinding } from "./rereview-state";
import type { VerifyQueueEntry } from "./rereview-verify";
import { parseTriageMarker } from "./triage";

export interface RereviewGit {
  commitExists(sha: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  nameOnly(from: string, to: string): Promise<string[]>;
}

export interface PreparedDiscovery {
  last: LastReviewedHead;
  case: RereviewCase;
  plan: DiscoveryPlan;
  // Null: unrestricted B..H (hunters see the full PR range). Empty: skip
  // discovery — no files in the restricted intersection, or case B.
  discoveryPaths: string[] | null;
  discoveryFrom: string;
  discoveryTo: string;
  discoverySkippedEmptyDelta: boolean;
}

export interface RereviewProvenance {
  case: RereviewCase;
  last_reviewed_head: string | null;
  last_head_source: LastHeadSource;
  discovery_range: string;
  discovery_restricted: boolean;
  discovery_skipped_empty_delta: boolean;
  prior_findings: number;
  settled_deterministically: number;
  verified: number;
  verification_capped: number;
  verification_triggers: {
    applied: number;
    touched: number;
    overlap: number;
    verify_all: number;
  };
  live: LiveFinding[];
  resolved_verified?: number;
  resolved_ids?: string[];
  returned?: number;
  re_tiered?: number;
  worsened?: readonly {
    priorId: string;
    priorSev: Severity;
    discoverySev: Severity;
  }[];
}

export function parseNameOnly(stdout: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const path = line.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  out.sort();
  return out;
}

export function shouldAbortEmptyDiscovery(
  plan: DiscoveryPlan,
  patch: string,
): boolean {
  return plan.emptyDeltaIsError && patch.trim().length === 0;
}

export async function prepareDiscovery(input: {
  B: string;
  H: string;
  full: boolean;
  summaryHead: string | null;
  findingMarkers: readonly MarkerHead[];
  git: RereviewGit;
}): Promise<PreparedDiscovery> {
  const last = resolveLastReviewedHead({
    summaryHead: input.summaryHead,
    findingMarkers: input.findingMarkers,
  });
  let objectExists: boolean | null = null;
  let isAncestor: boolean | null = null;
  if (last.L !== null) {
    objectExists = await input.git.commitExists(last.L);
    if (objectExists) {
      isAncestor = await input.git.isAncestor(last.L, input.H);
    }
  }
  const rereviewCase = decideRereviewCase({
    L: last.L,
    H: input.H,
    objectExists,
    isAncestor,
  });
  const plan = planDiscovery({ case: rereviewCase, full: input.full });

  if (plan.skipDiscovery) {
    const from = last.L ?? input.B;
    return {
      last,
      case: rereviewCase,
      plan,
      discoveryPaths: [],
      discoveryFrom: from,
      discoveryTo: input.H,
      discoverySkippedEmptyDelta: true,
    };
  }

  if (plan.discovery !== "restricted" || last.L === null) {
    return {
      last,
      case: rereviewCase,
      plan,
      discoveryPaths: null,
      discoveryFrom: input.B,
      discoveryTo: input.H,
      discoverySkippedEmptyDelta: false,
    };
  }

  const [prFiles, deltaFiles] = await Promise.all([
    input.git.nameOnly(input.B, input.H),
    input.git.nameOnly(last.L, input.H),
  ]);
  const discoveryPaths = restrictedDiscoveryFiles(prFiles, deltaFiles);
  return {
    last,
    case: rereviewCase,
    plan,
    discoveryPaths,
    discoveryFrom: last.L,
    discoveryTo: input.H,
    discoverySkippedEmptyDelta: discoveryPaths.length === 0,
  };
}

// First review (case A) carries no block at all (W-prov). Counts that the
// verify spawn has not filled yet stay zero rather than omitted — an
// artifact that cannot name its case is unscorable; zeros are still a case.
export function toRereviewProvenance(
  prepared: PreparedDiscovery,
  priorFindings = 0,
): RereviewProvenance | undefined {
  if (prepared.case === "A") return undefined;
  return {
    case: prepared.case,
    last_reviewed_head: prepared.last.L,
    last_head_source: prepared.last.source,
    discovery_range: `${prepared.discoveryFrom}..${prepared.discoveryTo}`,
    discovery_restricted: prepared.plan.discoveryRestricted,
    discovery_skipped_empty_delta: prepared.discoverySkippedEmptyDelta,
    prior_findings: priorFindings,
    settled_deterministically: 0,
    verified: 0,
    verification_capped: 0,
    verification_triggers: {
      applied: 0,
      touched: 0,
      overlap: 0,
      verify_all: 0,
    },
    live: [],
    resolved_verified: 0,
    returned: 0,
    re_tiered: 0,
  };
}

export interface NameStatus {
  files: string[];
  deleted: string[];
  renameMap: Map<string, string>;
}

// `git diff --name-status` lines. Renames are `R100\told\tnew`. Every path
// mentioned — including deleted and the old side of a rename — is a touched
// path: S-revert needs the unrestricted L..H set, not the surviving dest.
export function parseNameStatus(stdout: string): NameStatus {
  const files = new Set<string>();
  const deleted: string[] = [];
  const renameMap = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const status = line[0];
    const rest = line.slice(1).replace(/^\d*/, "").replace(/^\t/, "");
    const parts = rest.split("\t").filter((p) => p.length > 0);
    if (status === "R" || status === "C") {
      const from = parts[0];
      const to = parts[1];
      if (from === undefined || to === undefined) continue;
      renameMap.set(from, to);
      files.add(from);
      files.add(to);
      continue;
    }
    const path = parts[0];
    if (path === undefined) continue;
    files.add(path);
    if (status === "D") deleted.push(path);
  }
  return {
    files: [...files].sort(),
    deleted: deleted.sort(),
    renameMap,
  };
}

export function buildPhaseBQueue(input: {
  case: RereviewCase;
  priors: readonly PriorRecord[];
  nameStatus: NameStatus;
  summaryUpdatedAt: string | null;
}): {
  queued: VerifyQueueEntry[];
  overlapCandidates: VerifyQueueEntry[];
  settled: PhaseBResult[];
} {
  const deltaFiles = new Set(input.nameStatus.files);
  const ctx = {
    case: input.case,
    deletedFiles: new Set(input.nameStatus.deleted),
    renameMap: input.nameStatus.renameMap,
    touched: (identity: FindingIdentity) =>
      [...identity.keys()].some((path) => deltaFiles.has(path)),
    summaryUpdatedAt: input.summaryUpdatedAt,
  };
  const queued: VerifyQueueEntry[] = [];
  const overlapCandidates: VerifyQueueEntry[] = [];
  const settled: PhaseBResult[] = [];
  for (const prior of input.priors) {
    const result = classifyPrior(prior, ctx);
    settled.push(result);
    const entry = {
      priorId: prior.id,
      sev: prior.sev,
      trigger: result.trigger ?? "touched",
      claim: prior.claim,
      locs: result.locs,
      authorReply: "",
      commentBody: "",
      triageTag: prior.triage?.tag ?? "",
      deltaHunks: "",
    };
    if (result.status === "queued" && result.trigger !== undefined) {
      queued.push({ ...entry, trigger: result.trigger });
    } else if (result.status === "carried") {
      overlapCandidates.push(entry);
    }
  }
  return { queued, overlapCandidates, settled };
}

export function priorsFromStateFindings(
  findings: readonly StateFinding[],
): PriorRecord[] {
  return findings.map((finding) => ({
    id: finding.id,
    sev: finding.sev,
    tier: finding.tier,
    channel: finding.channel,
    locs: finding.locs,
    claim: finding.claim,
    triage: null,
    newThreadReply: false,
  }));
}

export function priorsFromPostedMarkers(
  posted: readonly {
    path: string;
    line: number;
    channel: "inline" | "outside";
  }[],
): PriorRecord[] {
  return posted.map((item, i) => ({
    id: `R${String(i + 1).padStart(3, "0")}`,
    sev: "WARNING",
    tier: "advisory",
    channel: item.channel,
    locs: [`${item.path}:${item.line}`],
    claim: "",
    triage: null,
    newThreadReply: false,
  }));
}

// A previously posted per-finding comment, as much of it as the prior→comment
// binding needs. Deliberately NOT narrowed to `{ id, marker: { c } }`: that
// narrowing is what made the two consumers below structurally unable to
// consult the path and line sitting right there in the marker, so both keyed
// on `c` alone and neither could ever bind a prior recovered by
// `priorsFromPostedMarkers` (claim `""`, so a fingerprint no real marker
// carries). Types are a place bugs hide.
export interface PostedForPrior {
  id: number;
  marker: { path: string; line: number; c: string };
  // GitHub's live projection of a REVIEW comment. Present only for the
  // review channel, and only a projection — see the two-projection rule in
  // `bindPriorsToPosted`.
  livePath?: string;
  liveLine?: number;
}

// THE PRIOR→COMMENT BINDING, and the one place `c` is allowed to speak here.
//
// Three identity regimes now live in this codebase and they are NOT
// interchangeable. Naming them together because conflating two of them is
// exactly the defect this function replaces:
//
//   1. marker-strict — `matchPostedFindingExact` (`src/triage-reply.ts:63-88`):
//      path + line + headSha + c, live projection ignored ON PURPOSE. It binds
//      a triage reply to the comment a human was looking at, and design §3.5
//      says the marker stays strict there.
//   2. the §3.5 loc-SET identity — `identitiesMatch`
//      (`src/rereview-identity.ts`): equal-or-contained path sets with
//      overlapping spans. It pairs two FINDINGS across runs. It cannot serve
//      here: a posted comment has ONE anchor while a prior may carry many
//      locs, so `identitiesMatch` would refuse every multi-loc prior its own
//      single-anchor comment.
//   3. this one — the comment's anchor must land within the window of one of
//      the prior's locs on the same normalized path; `c` breaks a distance
//      TIE and nothing else.
//
// WHY the anchor is tested against BOTH the marker's stored path/line and the
// live projection, taking whichever is nearer: GitHub re-anchors a review
// comment's live `line` whenever the PR's diff changes, including when the
// BASE advances with no new push (`src/inline.ts:213-219`). A state-block
// prior still at `a.ts:100` and its own comment now projected to `a.ts:112`
// is zero-drift; live-only matching would miss it and silently drop the
// author's triage — the same class of invisible failure being fixed.
//
// WHY `c` is not a requirement even for a lone candidate: a prior recovered
// from posted markers has no claim at all, and LLM claim wording drifts run
// to run for the same defect. Requiring `c` would re-elevate the tie-breaker
// to an identity from the other direction.
//
// One-to-one and greedy in prior order, same posture as `matchPostedFindings`
// (`src/inline.ts`): a posted comment is consumable once, and an unresolvable
// ambiguity binds NOTHING. Direction of error is under-match — a missed
// binding costs a dropped triage tag or a thread left open; an over-match
// puts a "✅ RESOLVED · verified gone" reply on a still-live finding.
export function bindPriorsToPosted<T extends PostedForPrior>(
  priors: readonly { id: string; locs: readonly string[]; claim: string }[],
  posted: readonly T[],
  window: number = IDENTITY_LINE_WINDOW,
): Map<string, T> {
  const bound = new Map<string, T>();
  const consumed = new Set<number>();
  for (const prior of priors) {
    const identity = identityFromLocs(prior.locs);
    if (identity.size === 0) continue;
    const candidates: { row: T; distance: number }[] = [];
    for (const row of posted) {
      if (consumed.has(row.id)) continue;
      const distance = anchorDistance(identity, row, window);
      if (distance !== null) candidates.push({ row, distance });
    }
    if (candidates.length === 0) continue;
    const min = Math.min(...candidates.map((c) => c.distance));
    const tied = candidates.filter((c) => c.distance === min);
    const winner = resolvePriorTie(tied, prior.claim);
    if (winner === undefined) continue;
    bound.set(prior.id, winner);
    consumed.add(winner.id);
  }
  return bound;
}

// Nearest approach of the comment's anchor to any of the prior's spans on a
// shared path, over both projections; null when neither lands within window.
function anchorDistance(
  identity: FindingIdentity,
  row: PostedForPrior,
  window: number,
): number | null {
  const projections: readonly (readonly [string, number])[] = [
    [row.marker.path, row.marker.line],
    [row.livePath ?? row.marker.path, row.liveLine ?? row.marker.line],
  ];
  let best: number | null = null;
  for (const [path, line] of projections) {
    const spans = identity.get(normalizePath(path));
    if (spans === undefined) continue;
    for (const span of spans) {
      const distance =
        line < span.start
          ? span.start - line
          : line > span.end
            ? line - span.end
            : 0;
      if (distance > window) continue;
      if (best === null || distance < best) best = distance;
    }
  }
  return best;
}

function resolvePriorTie<T extends PostedForPrior>(
  tied: readonly { row: T; distance: number }[],
  claim: string,
): T | undefined {
  if (tied.length === 1) return tied[0]?.row;
  // No claim, no tie-break: `claimFingerprint("")` is a real constant hash
  // (`e3b0c44298fc`) that every empty-claim prior shares, so consulting it
  // here would hand the whole tied set to whichever row came first.
  if (claim.trim().length === 0) return undefined;
  const fingerprint = claimFingerprint(claim);
  const matching = tied.filter((c) => c.row.marker.c === fingerprint);
  return matching.length === 1 ? matching[0]?.row : undefined;
}

export function enrichPriorsFromThreads(input: {
  priors: readonly PriorRecord[];
  posted: readonly PostedForPrior[];
  replies: readonly {
    in_reply_to_id: number | null;
    body: string;
    created_at?: string;
  }[];
  summaryUpdatedAt: string | null;
}): PriorRecord[] {
  const bound = bindPriorsToPosted(input.priors, input.posted);
  return input.priors.map((prior) => {
    const parent = bound.get(prior.id);
    if (parent === undefined) return prior;
    const thread = input.replies.filter(
      (reply) => reply.in_reply_to_id === parent.id,
    );
    let triage: PriorTriage | null = prior.triage;
    for (const reply of thread) {
      const marker = parseTriageMarker(reply.body);
      if (marker === null) continue;
      triage = {
        tag: marker.tag,
        verdict: marker.verdict ?? null,
        createdAt: reply.created_at ?? null,
      };
    }
    const newThreadReply = thread.some(
      (reply) =>
        reply.created_at !== undefined &&
        input.summaryUpdatedAt !== null &&
        reply.created_at > input.summaryUpdatedAt,
    );
    return { ...prior, triage, newThreadReply };
  });
}

// WHY the binding runs over EVERY prior and not just the verified-gone ones:
// one-to-one only means anything when the carried priors get to claim their
// own comments too. Binding the verified-gone subset alone would let a
// retired prior take a still-live neighbour's thread, which is the ✅ on a
// live defect this whole function exists to avoid.
export function collapseTargets(input: {
  verifiedGoneIds: readonly string[];
  priors: readonly { id: string; claim: string; locs: readonly string[] }[];
  posted: readonly (PostedForPrior & { channel: "review" | "issue" })[];
}): Array<{
  priorId: string;
  commentId: number;
  channel: "review" | "issue";
}> {
  const bound = bindPriorsToPosted(input.priors, input.posted);
  const out: Array<{
    priorId: string;
    commentId: number;
    channel: "review" | "issue";
  }> = [];
  for (const id of input.verifiedGoneIds) {
    const posted = bound.get(id);
    if (posted === undefined) continue;
    out.push({
      priorId: id,
      commentId: posted.id,
      channel: posted.channel,
    });
  }
  return out;
}
