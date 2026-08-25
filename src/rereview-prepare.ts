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
  decideLastHeadDelta,
  decideRereviewCase,
  type LastHeadSource,
  type LastReviewedHead,
  type MarkerHead,
  planDiscovery,
  resolveLastReviewedHead,
  restrictedDiscoveryFiles,
  unreachableLastHeadMessage,
} from "./rereview-plan";
import type { LiveFinding, StateFinding } from "./rereview-state";
import type { VerifyQueueEntry } from "./rereview-verify";
import { parseTriageMarker } from "./triage";

// cli.ts reaches the whole re-review surface through this module and never
// imports rereview-plan.ts directly; these two travel with `prepareDiscovery`'s
// output, so they ride the same facade. The return type stays unexported here
// — cli.ts infers it, and nothing names it across this boundary.
export { decideLastHeadDelta, unreachableLastHeadMessage };

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

// The read-back half of the block above, for the ONE consumer that has no
// pipeline in memory: `post --from <run-dir>` (`runPostCommand`). The run's
// `pipeline.json` is the only place a re-review's case, `live[]` and
// verified-gone count survive the process that computed them, so the summary
// `post --from` publishes is truthful exactly when this parse succeeds — and
// a block that half-parses is worse than none, because the delta it feeds
// silently falls back to the absence matcher (`MatchResult.resolved`) that
// item 7 exists to retire. Hence: valid, absent, or LOUD. Pure so the seam is
// testable without a run directory.
export type RereviewProvenanceRead =
  | { kind: "absent" }
  | { kind: "ok"; rereview: RereviewProvenance }
  | { kind: "invalid"; problem: string };

export function readRereviewProvenance(
  pipeline: unknown,
): RereviewProvenanceRead {
  if (!isRecord(pipeline)) return { kind: "invalid", problem: "not an object" };
  const raw = pipeline.rereview;
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (!isRecord(raw)) return { kind: "invalid", problem: "rereview" };

  const problem = (field: string): RereviewProvenanceRead => ({
    kind: "invalid",
    problem: `rereview.${field}`,
  });
  const rereviewCase = raw.case;
  if (
    rereviewCase !== "A" &&
    rereviewCase !== "B" &&
    rereviewCase !== "C" &&
    rereviewCase !== "D" &&
    rereviewCase !== "E"
  ) {
    return problem("case");
  }
  const lastHead = raw.last_reviewed_head;
  if (lastHead !== null && typeof lastHead !== "string") {
    return problem("last_reviewed_head");
  }
  const source = raw.last_head_source;
  if (
    source !== "summary_marker" &&
    source !== "finding_markers" &&
    source !== "absent"
  ) {
    return problem("last_head_source");
  }
  if (typeof raw.discovery_range !== "string") {
    return problem("discovery_range");
  }
  if (typeof raw.discovery_restricted !== "boolean") {
    return problem("discovery_restricted");
  }
  if (typeof raw.discovery_skipped_empty_delta !== "boolean") {
    return problem("discovery_skipped_empty_delta");
  }
  for (const field of [
    "prior_findings",
    "settled_deterministically",
    "verified",
    "verification_capped",
  ] as const) {
    if (!isCount(raw[field])) return problem(field);
  }
  const triggers = raw.verification_triggers;
  if (!isRecord(triggers)) return problem("verification_triggers");
  for (const field of [
    "applied",
    "touched",
    "overlap",
    "verify_all",
  ] as const) {
    if (!isCount(triggers[field])) {
      return problem(`verification_triggers.${field}`);
    }
  }
  if (!Array.isArray(raw.live)) return problem("live");
  const live: LiveFinding[] = [];
  for (const [i, row] of raw.live.entries()) {
    const parsed = asLiveFinding(row);
    if (parsed === null) return problem(`live[${i}]`);
    live.push(parsed);
  }
  for (const field of ["resolved_verified", "returned", "re_tiered"] as const) {
    if (raw[field] !== undefined && !isCount(raw[field])) return problem(field);
  }
  const resolvedIds = raw.resolved_ids;
  if (
    resolvedIds !== undefined &&
    (!Array.isArray(resolvedIds) ||
      !resolvedIds.every((id) => typeof id === "string"))
  ) {
    return problem("resolved_ids");
  }
  // W-worse: `worsened` is what makes the summary name BOTH severities on a
  // prior that came back stronger ("returned R001: WARNING → CRITICAL",
  // `liveFindingLines`). Validated and carried, never quietly dropped — a
  // `post --from` that published the same summary minus those lines would be
  // the silent render this whole seam refuses.
  let worsened: RereviewProvenance["worsened"];
  if (raw.worsened !== undefined) {
    if (!Array.isArray(raw.worsened)) return problem("worsened");
    const rows: {
      priorId: string;
      priorSev: Severity;
      discoverySev: Severity;
    }[] = [];
    for (const [i, row] of raw.worsened.entries()) {
      if (
        !isRecord(row) ||
        typeof row.priorId !== "string" ||
        row.priorId.length === 0 ||
        !isSeverity(row.priorSev) ||
        !isSeverity(row.discoverySev)
      ) {
        return problem(`worsened[${i}]`);
      }
      rows.push({
        priorId: row.priorId,
        priorSev: row.priorSev,
        discoverySev: row.discoverySev,
      });
    }
    worsened = rows;
  }

  return {
    kind: "ok",
    rereview: {
      case: rereviewCase,
      last_reviewed_head: lastHead,
      last_head_source: source,
      discovery_range: raw.discovery_range,
      discovery_restricted: raw.discovery_restricted,
      discovery_skipped_empty_delta: raw.discovery_skipped_empty_delta,
      prior_findings: raw.prior_findings as number,
      settled_deterministically: raw.settled_deterministically as number,
      verified: raw.verified as number,
      verification_capped: raw.verification_capped as number,
      verification_triggers: {
        applied: triggers.applied as number,
        touched: triggers.touched as number,
        overlap: triggers.overlap as number,
        verify_all: triggers.verify_all as number,
      },
      live,
      resolved_verified: (raw.resolved_verified as number | undefined) ?? 0,
      resolved_ids: (resolvedIds as string[] | undefined) ?? [],
      returned: (raw.returned as number | undefined) ?? 0,
      re_tiered: (raw.re_tiered as number | undefined) ?? 0,
      ...(worsened === undefined ? {} : { worsened }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSeverity(value: unknown): value is Severity {
  return (
    value === "BLOCKER" ||
    value === "CRITICAL" ||
    value === "WARNING" ||
    value === "SUGGESTION"
  );
}

// A `live[]` row, validated to the shape the state block re-renders from —
// `c` included, because `renderStateBlock` writes it back verbatim and a row
// missing it produces a block the NEXT run's `parseStateBlock` rejects
// wholesale, which is how a state block quietly stops existing.
function asLiveFinding(value: unknown): LiveFinding | null {
  if (!isRecord(value)) return null;
  const { id, sev, tier, channel, status, locs, c, claim } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (!isSeverity(sev)) return null;
  if (tier !== "blocking" && tier !== "advisory") return null;
  if (channel !== "inline" && channel !== "outside") return null;
  if (
    status !== "carried" &&
    status !== "unconfirmed" &&
    status !== "suppressed" &&
    status !== "deferred"
  ) {
    return null;
  }
  if (!Array.isArray(locs) || !locs.every((loc) => typeof loc === "string")) {
    return null;
  }
  if (typeof c !== "string" || !/^[0-9a-f]{12}$/.test(c)) return null;
  if (typeof claim !== "string") return null;
  return { id, sev, tier, channel, status, locs: [...locs], c, claim };
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
// One-to-one, and the assignment is GLOBAL by distance — never greedy in
// `priors` array order. That order-dependence was a real defect: with prior A
// at {X:0, Y:1} and prior B whose only candidate is X at 1, walking the array
// gave A→X, B→nothing on `[A, B]` and B→X, A→Y on `[B, A]`. Two orderings of
// the SAME state, two different sets of threads collapsed; and `priors` order
// is whatever the state block happened to serialise, i.e. arbitrary.
//
// The algorithm, and the invariant that makes it order-free:
//   * every (prior, comment) pair inside the window is a candidate, computed
//     once up front;
//   * distances are processed in increasing order, and a level runs
//     synchronous rounds until it quiesces: each round every eligible prior
//     makes at most ONE proposal, then every contested comment is resolved.
//     Nothing inside a round reads array position, so a round's outcome is a
//     function of the state alone.
//   * a round always changes state when it has active pairs (a prior either
//     proposes or is disqualified; a proposal either binds or blocks its
//     comment), so a level cannot quiesce with a nearer pair still live —
//     that is what keeps "nearest first" true, and what terminates the loop.
//
// The two ambiguity rules, both "bind NOTHING" as before:
//   * prior side — a prior tied across several comments at its current best
//     distance is resolved by `c`, and disqualified for good when `c` cannot
//     (exactly today's rule, which also never fell through to a farther
//     comment);
//   * comment side — the mirror, which array-order greed used to decide by
//     position: several priors proposing the SAME comment at the same
//     distance are resolved by `c`, and when `c` cannot, that comment is
//     blocked for everyone. The losers of a `c`-resolved contest are NOT
//     disqualified; their comment is simply gone, so they fall to their next
//     distance like any other prior.
//
// Direction of error stays under-match — a missed binding costs a dropped
// triage tag or a thread left open; an over-match puts a "✅ RESOLVED ·
// verified gone" reply on a still-live finding.
export function bindPriorsToPosted<T extends PostedForPrior>(
  priors: readonly { id: string; locs: readonly string[]; claim: string }[],
  posted: readonly T[],
  window: number = IDENTITY_LINE_WINDOW,
): Map<string, T> {
  interface Pair {
    priorId: string;
    claim: string;
    row: T;
    distance: number;
  }
  const pairs: Pair[] = [];
  for (const prior of priors) {
    const identity = identityFromLocs(prior.locs);
    if (identity.size === 0) continue;
    for (const row of posted) {
      const distance = anchorDistance(identity, row, window);
      if (distance === null) continue;
      pairs.push({ priorId: prior.id, claim: prior.claim, row, distance });
    }
  }

  const bound = new Map<string, T>();
  // A comment is consumable once (`consumed`), or by nobody at all when an
  // equidistant contest over it could not be resolved (`blocked`). A prior
  // whose own best-distance set was ambiguous binds nothing ever
  // (`disqualified`).
  const consumed = new Set<number>();
  const blocked = new Set<number>();
  const disqualified = new Set<string>();

  const distances = [...new Set(pairs.map((pair) => pair.distance))].sort(
    (a, b) => a - b,
  );
  for (const distance of distances) {
    for (;;) {
      const active = pairs.filter(
        (pair) =>
          pair.distance === distance &&
          !bound.has(pair.priorId) &&
          !disqualified.has(pair.priorId) &&
          !consumed.has(pair.row.id) &&
          !blocked.has(pair.row.id),
      );
      if (active.length === 0) break;

      const byPrior = new Map<string, Pair[]>();
      for (const pair of active) {
        const group = byPrior.get(pair.priorId);
        if (group === undefined) byPrior.set(pair.priorId, [pair]);
        else group.push(pair);
      }
      let changed = false;
      const proposals: Pair[] = [];
      for (const [priorId, group] of byPrior) {
        const winner = resolvePriorTie(group, group[0]?.claim ?? "");
        if (winner === undefined) {
          disqualified.add(priorId);
          changed = true;
          continue;
        }
        const proposal = group.find((pair) => pair.row.id === winner.id);
        if (proposal !== undefined) proposals.push(proposal);
      }

      const byRow = new Map<number, Pair[]>();
      for (const pair of proposals) {
        const group = byRow.get(pair.row.id);
        if (group === undefined) byRow.set(pair.row.id, [pair]);
        else group.push(pair);
      }
      for (const [rowId, group] of byRow) {
        const winner = resolveRowTie(group);
        if (winner === undefined) {
          blocked.add(rowId);
          changed = true;
          continue;
        }
        bound.set(winner.priorId, winner.row);
        consumed.add(rowId);
        changed = true;
      }
      // Unreachable while `active` is non-empty (every branch above changes
      // state); kept because a loop whose termination depends on that
      // reasoning holding forever is one refactor away from hanging a post.
      if (!changed) break;
    }
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

// The mirror of `resolvePriorTie`, for the contest array-order greed used to
// settle by position: several priors at the SAME distance from one comment.
// Same rule, read the other way — `c` may break the tie and nothing else, an
// empty claim cannot vote (`claimFingerprint("")` is a constant every
// claim-less prior shares), and anything short of exactly one match leaves the
// comment to nobody.
function resolveRowTie<T extends PostedForPrior>(
  contenders: readonly { priorId: string; claim: string; row: T }[],
): { priorId: string; row: T } | undefined {
  if (contenders.length === 1) return contenders[0];
  const matching = contenders.filter(
    (contender) =>
      contender.claim.trim().length > 0 &&
      contender.row.marker.c === claimFingerprint(contender.claim),
  );
  return matching.length === 1 ? matching[0] : undefined;
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
