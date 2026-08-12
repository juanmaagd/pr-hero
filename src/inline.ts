// Inline review surface (ROADMAP B6) — pure. Three jobs, chained:
//
//   1. classifyAnchorability — will GitHub accept an inline review comment at
//      this finding's path:line? (a PREDICTION — GitHub's 422 is the
//      authority, not this function; see pr.ts's recovery path)
//   2. matchPostedFindings — does this finding already have a comment from a
//      prior run, so posting it again would duplicate?
//   3. buildPostPlan — combine both into what to actually post this run.
//
// NO I/O. Same contract as preflight.ts/pr-preflight.ts: no gh, no git, no
// network, no filesystem. cli.ts and pr.ts execute what this module plans.

import type { PrHeroFindingRef } from "./compare";
import type { ParsedFindingMarker } from "./pr-preflight";
import { diffRecordPath, splitDiffRecords } from "./size-gate";

// ---------------------------------------------------------------------------
// 1. Anchorability

export type Anchorability = "anchorable" | "un-anchorable";

// path -> the set of RIGHT-side (head) line numbers any hunk touches.
export type HunkAnchors = Map<string, Set<number>>;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Per-path RIGHT-side line set, built from `@@ -a,b +c,d @@` headers plus the
// `+`/context lines that follow each one (design D4). Deletion-only lines are
// LEFT-side and never contribute — a finding always names a HEAD line, so a
// hunk that only removes code anchors nothing.
//
// Reuses splitDiffRecords/diffRecordPath (size-gate.ts) rather than
// re-parsing `diff --git` headers here: the record boundary and path
// resolution (rename/copy/C-quoting) logic already exists and any drift
// between a second implementation and size-gate's would be exactly the class
// of bug c717fe4 fixed — two places deciding "what is this record's path"
// and disagreeing. A record whose path cannot be resolved contributes no
// anchors at all, which is the demote-not-guess direction: every finding in
// that path falls through to un-anchorable.
export function parseHunkAnchors(patch: string): HunkAnchors {
  const anchors: HunkAnchors = new Map();
  for (const record of splitDiffRecords(patch)) {
    const target = diffRecordPath(record);
    if (target === undefined) continue;
    const lines = anchorLinesForRecord(record);
    if (lines.size === 0) continue;
    anchors.set(target, lines);
  }
  return anchors;
}

function anchorLinesForRecord(record: string): Set<number> {
  const out = new Set<number>();
  let rightLine = 0;
  let inHunk = false;
  for (const line of record.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      rightLine = Number.parseInt(header[1] as string, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") || line.startsWith(" ")) {
      out.add(rightLine);
      rightLine++;
      continue;
    }
    if (line.startsWith("-")) continue; // left-side only; right counter holds
    // Anything else inside a hunk body ("\ No newline at end of file", or the
    // record simply ending) closes it — the next header line reopens.
    inHunk = false;
  }
  return out;
}

// Un-anchorable is the fail-closed direction on every branch: a path absent
// from the diff (excluded by the size gate's glob list, or never in the diff
// at all) and a line the diff never touched both demote rather than guess —
// see spec "Anchorability classification".
export function classifyAnchorability(
  finding: { path: string; line: number },
  anchors: HunkAnchors,
): Anchorability {
  const lines = anchors.get(finding.path);
  if (lines === undefined) return "un-anchorable";
  return lines.has(finding.line) ? "anchorable" : "un-anchorable";
}

// ---------------------------------------------------------------------------
// 2. Cross-run matching

// FINDING_LINE_WINDOW=5 is a JUDGEMENT CALL, not a measurement — recorded
// here so nobody later cites it as evidence. It deliberately diverges from
// compare.ts's DEFAULT_LINE_WINDOW=25: that window is a deliberate OVER-match
// (show a human a pair they can reject rather than score a real agreement as
// a miss). This window needs the OPPOSITE bias, because an over-match here
// silently suppresses a genuinely new finding — an invisible miss, the worst
// failure a review tool can have. The first live pair of runs is this
// number's only evidence; widen it only with a measurement, never a
// extrapolation (size-gate.ts's 1500->2500->1500 arc is the cautionary
// tale for skipping that step).
export const FINDING_LINE_WINDOW = 5;

// A previously posted per-finding comment, marker-parsed plus whatever
// GitHub's live projection adds. Review comments carry a live path/line that
// tracks renames and pushes; issue comments have neither (GitHub does not
// anchor them to code), so matching an issue comment falls back to the
// marker's own stored path/line — a known limitation that errs toward a
// duplicate rather than a silently swallowed finding (design D2).
export interface PostedFindingComment {
  id: number;
  channel: "review" | "issue";
  marker: ParsedFindingMarker;
  // GitHub's live location for a REVIEW comment. Preferred over the marker's
  // stored path/line because it follows renames and reflects the ACTUAL
  // current position, not the position at post time.
  livePath?: string;
  liveLine?: number;
}

export interface FindingMatch {
  finding: PrHeroFindingRef;
  posted: PostedFindingComment;
}

export interface MatchResult {
  // Matched to a prior comment — nothing to post.
  persist: FindingMatch[];
  // No prior comment matched — posts as new.
  fresh: PrHeroFindingRef[];
  // A prior comment with nothing matched to it this run.
  resolved: PostedFindingComment[];
}

// One-to-one, greedy-nearest, UNDER-match by construction (spec "Match by
// path and a narrow line window, one-to-one" + "Ambiguous matches post as
// new, never a forced match"). Findings are matched in input order; each
// posted comment is consumable at most once, so two findings can never both
// claim the same prior comment. An ambiguous tie (two candidates at the
// identical minimum distance) resolves to POST, never to an arbitrary pick —
// this is the test that would fail if someone later widened the window or
// made the match many-to-many: widen it and a tie that used to post fresh
// starts silently forcing a match instead.
export function matchPostedFindings(input: {
  findings: PrHeroFindingRef[];
  posted: PostedFindingComment[];
  headSha: string;
  window?: number;
}): MatchResult {
  const window = input.window ?? FINDING_LINE_WINDOW;
  const available = new Set(input.posted);
  const persist: FindingMatch[] = [];
  const fresh: PrHeroFindingRef[] = [];

  for (const finding of input.findings) {
    let best: PostedFindingComment | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let ambiguous = false;
    for (const posted of available) {
      // Live path (follows renames) wins over the marker's stored path —
      // design D2.
      const path = posted.livePath ?? posted.marker.path;
      if (path !== finding.path) continue;
      const line = posted.liveLine ?? posted.marker.line;
      const distance = Math.abs(line - finding.line);
      if (distance > window) continue;
      if (distance < bestDistance) {
        best = posted;
        bestDistance = distance;
        ambiguous = false;
      } else if (distance === bestDistance) {
        ambiguous = true;
      }
    }
    if (best === undefined || ambiguous) {
      fresh.push(finding);
      continue;
    }
    available.delete(best);
    persist.push({ finding, posted: best });
  }

  const matched = new Set(persist.map((match) => match.posted));
  const resolved = input.posted.filter((posted) => !matched.has(posted));
  return { persist, fresh, resolved };
}

// ---------------------------------------------------------------------------
// 3. Post plan

export interface PostPlan {
  // Anchorable, unmatched findings — go into ONE review submission
  // (`comments[]`), never one review per finding (spec "One review
  // submission for anchorable findings").
  reviewComments: PrHeroFindingRef[];
  // Un-anchorable, unmatched findings — one issue comment each (spec "One
  // issue comment per un-anchorable finding").
  issueComments: PrHeroFindingRef[];
  persisting: FindingMatch[];
  resolved: PostedFindingComment[];
  // From the matcher, not a stored count (design D5): persist = matched,
  // new = reviewComments.length + issueComments.length, resolved = prior
  // comments with nothing matched to them.
  delta: { resolved: number; new: number; persist: number };
}

export function buildPostPlan(input: {
  findings: PrHeroFindingRef[];
  anchors: HunkAnchors;
  posted: PostedFindingComment[];
  headSha: string;
  window?: number;
}): PostPlan {
  const match = matchPostedFindings({
    findings: input.findings,
    posted: input.posted,
    headSha: input.headSha,
    window: input.window,
  });
  const reviewComments: PrHeroFindingRef[] = [];
  const issueComments: PrHeroFindingRef[] = [];
  for (const finding of match.fresh) {
    const anchorability = classifyAnchorability(finding, input.anchors);
    if (anchorability === "anchorable") reviewComments.push(finding);
    else issueComments.push(finding);
  }
  return {
    reviewComments,
    issueComments,
    persisting: match.persist,
    resolved: match.resolved,
    delta: {
      resolved: match.resolved.length,
      new: match.fresh.length,
      persist: match.persist.length,
    },
  };
}
