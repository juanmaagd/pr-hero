// Cross-run finding identity for item 7 (`docs/item7-rereview-design.md` §3.5).
// Pure: unordered set of normalized proof-ref locations, plus the finding's
// own path:line as an always-present anchor. Invalid / non-path:line refs
// are dropped (S10); a finding with nothing left after the drop still has
// the anchor, so it never becomes the empty set.
//
// WHY a new module and not MatchResult / claimFingerprint / root_cause_id:
// musive PR 1759, two auto-launched runs 16 minutes apart on a byte-identical
// tree, paired none of those keys and would have reported `Δ 2 resolved`
// against zero commits (§0.6). The unordered set of locations is what
// survived the producer/consumer flip.
//
// Direction of error is under-match (S1, same posture as root-cause.ts:60-70).
// A missed pairing costs a verification step or a visible duplicate; an
// over-match can hide a live defect behind `carried`.

import { normalizePath } from "./compare";
import { extractAnchor } from "./root-cause";

// Same number as `FINDING_LINE_WINDOW` in inline.ts. The posting matcher and
// this identity layer MUST NOT drift: the design names that constant as the
// span window (§3.5). A test in rereview-identity.test.ts pins the equality.
// Widening either independently is the size-gate 1500→2500→1500 arc.
export const IDENTITY_LINE_WINDOW = 5;

export interface LineSpan {
  start: number;
  end: number;
}

export interface IdentityLoc {
  path: string;
  span: LineSpan;
}

export type FindingIdentity = ReadonlyMap<string, readonly LineSpan[]>;

export interface IdentityInput {
  path: string;
  line: number;
  proof_refs: readonly string[];
}

const LINE_SPEC = /^(\d+)(?:-(\d+))?$/;

// One proof_ref may name several spans on the same path (`path.ts:64,78-90`).
// `inline.ts`'s parseProofRefLines rejects the comma form; identity cannot,
// because the PR 1759 pair's defect A is stored that way.
export function parseProofRefLocs(ref: string): IdentityLoc[] {
  const anchor = extractAnchor([ref]);
  if (anchor === null) return [];
  const colon = anchor.lastIndexOf(":");
  const path = normalizePath(anchor.slice(0, colon));
  if (path.length === 0) return [];
  const specs = anchor.slice(colon + 1).split(",");
  const locs: IdentityLoc[] = [];
  for (const spec of specs) {
    const match = LINE_SPEC.exec(spec);
    if (match?.[1] === undefined) continue;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      continue;
    }
    locs.push({ path, span: { start, end } });
  }
  return locs;
}

export function identityFromFinding(finding: IdentityInput): FindingIdentity {
  const locs: IdentityLoc[] = [];
  for (const ref of finding.proof_refs) {
    locs.push(...parseProofRefLocs(ref));
  }
  locs.push({
    path: normalizePath(finding.path),
    span: { start: finding.line, end: finding.line },
  });
  return groupByPath(locs);
}

// State-block `locs` are already `path:line` / `path:start-end` tokens, but
// a hunter-shaped `path:64,78-90 (prose)` must parse the same way on both
// sides of a round-trip.
export function identityFromLocs(locs: readonly string[]): FindingIdentity {
  const parsed: IdentityLoc[] = [];
  for (const loc of locs) parsed.push(...parseProofRefLocs(loc));
  return groupByPath(parsed);
}

export function mapIdentityPaths(
  identity: FindingIdentity,
  rewrite: (path: string) => string,
): FindingIdentity {
  const locs: IdentityLoc[] = [];
  for (const [path, spans] of identity) {
    const next = rewrite(path);
    for (const span of spans) locs.push({ path: next, span });
  }
  return groupByPath(locs);
}

export function formatLocs(identity: FindingIdentity): string[] {
  const out: string[] = [];
  const paths = [...identity.keys()].sort();
  for (const path of paths) {
    const spans = identity.get(path);
    if (spans === undefined) continue;
    for (const span of spans) {
      out.push(
        span.start === span.end
          ? `${path}:${span.start}`
          : `${path}:${span.start}-${span.end}`,
      );
    }
  }
  return out;
}

export function identitiesMatch(
  a: FindingIdentity,
  b: FindingIdentity,
  window: number = IDENTITY_LINE_WINDOW,
): boolean {
  const pa = new Set(a.keys());
  const pb = new Set(b.keys());
  const equal = setsEqual(pa, pb);
  const containment =
    pa.size > 1 && pb.size > 1 && (isSubset(pa, pb) || isSubset(pb, pa));
  if (!equal && !containment) return false;
  const shared = equal ? pa : intersect(pa, pb);
  for (const path of shared) {
    const as = a.get(path);
    const bs = b.get(path);
    if (as === undefined || bs === undefined) return false;
    if (!spansOverlapOrNear(as, bs, window)) return false;
  }
  return true;
}

export function findingsMatch(
  a: IdentityInput,
  b: IdentityInput,
  window?: number,
): boolean {
  return identitiesMatch(
    identityFromFinding(a),
    identityFromFinding(b),
    window,
  );
}

function groupByPath(locs: readonly IdentityLoc[]): FindingIdentity {
  const grouped = new Map<string, LineSpan[]>();
  for (const loc of locs) {
    const existing = grouped.get(loc.path);
    if (existing === undefined) {
      grouped.set(loc.path, [loc.span]);
      continue;
    }
    if (
      existing.some(
        (span) => span.start === loc.span.start && span.end === loc.span.end,
      )
    ) {
      continue;
    }
    existing.push(loc.span);
  }
  for (const spans of grouped.values()) {
    spans.sort((x, y) => x.start - y.start || x.end - y.end);
  }
  return grouped;
}

function spansOverlapOrNear(
  as: readonly LineSpan[],
  bs: readonly LineSpan[],
  window: number,
): boolean {
  for (const a of as) {
    for (const b of bs) {
      if (spanDistance(a, b) <= window) return true;
    }
  }
  return false;
}

function spanDistance(a: LineSpan, b: LineSpan): number {
  if (a.end >= b.start && b.end >= a.start) return 0;
  if (a.end < b.start) return b.start - a.end;
  return a.start - b.end;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size > b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}
