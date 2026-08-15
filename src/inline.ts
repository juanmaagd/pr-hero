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
import { claimFingerprint, type ParsedFindingMarker } from "./pr-preflight";
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
    // WHY skip, not close: `\ No newline at end of file` is not a tail-only
    // marker. Git emits it immediately after the last `-` line whenever the
    // OLD file lacked a trailing newline, and the hunk continues with more
    // `+` content lines in the SAME hunk when the file's last line is
    // edited (verified against real `git diff` output, not assumed shape).
    // The old code treated ANY non +/-/space line as the hunk's end, so
    // every `+` line after a mid-hunk marker was dropped from the anchor
    // set — classifyAnchorability then reported those lines un-anchorable
    // and buildPostPlan misrouted them to issueComments instead of
    // reviewComments. Closing on a genuine hunk end still works without
    // this branch: the next `@@` header (if any) sets inHunk back to true,
    // and the record simply running out of lines ends the loop regardless.
    if (line.startsWith("\\")) continue;
    // Anything else inside a hunk body closes it — the next header reopens.
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

interface Candidate {
  posted: PostedFindingComment;
  // 0 for a same-head exact stored-line match; otherwise the window
  // distance computed on the live line. Kept as one number so tie-detection
  // (`resolveWinner`) does not need to know which branch produced it.
  distance: number;
}

// Per-candidate: same head → exact match on the marker's STORED line first,
// falling back to the ±window on the live line; different head → window
// only (design D2). WHY the branch exists at all, not just "window on live
// line" everywhere: GitHub RE-ANCHORS a review comment's live `line`
// whenever the PR's diff changes — and the diff changes when the BASE
// branch advances, with no new push to the head. A marker stored at
// `a.ts:100`, a finding still at `a.ts:100`, and a base-driven live line of
// `112` is a same-head, zero-drift finding; keying on the live line alone
// (distance 12 > window 5) misses it and reposts a finding that never
// moved, which is exactly the daylight spec R11's "an unchanged head MUST
// NOT repost" exists to close. The live PATH is still preferred in both
// branches (it follows renames; the marker's path goes stale) — it is only
// the LINE that must prefer the marker on a same-head comparison.
function candidatesFor(
  finding: PrHeroFindingRef,
  available: Iterable<PostedFindingComment>,
  window: number,
  headSha: string,
): Candidate[] {
  const exact: Candidate[] = [];
  const windowed: Candidate[] = [];
  for (const posted of available) {
    const path = posted.livePath ?? posted.marker.path;
    if (path !== finding.path) continue;
    const sameHead = posted.marker.headSha === headSha;
    // WHY the fingerprint is consulted here too, not just in resolveWinner's
    // tie-break: this branch used to treat same-head path+line alone as
    // sufficient identity, and it is almost always the SOLE candidate (a
    // same-head exact-line hit crowds out any windowed alternative), so the
    // tie-break fingerprint check below never ran for it. Consequence: a
    // genuinely DIFFERENT defect reported at a path:line that already
    // carries an unrelated posted comment was silently classified `persist`
    // and never surfaced — the invisible miss this module's own doc comment
    // (above, "the worst failure mode a review tool can have") warns about,
    // via the one path built to bypass the safeguard meant to prevent it. A
    // fingerprint mismatch means "not established to be the same finding",
    // which resolves to fresh (POST AS NEW) per the demote-not-guess
    // direction: a visible duplicate is self-correcting, an invisible miss
    // is not. The honest cost: claimFingerprint is sha256 over the full
    // trimmed claim text, "nowhere near enough (nor intended) to be a
    // content-addressed identity on its own" (pr-preflight.ts), and LLM
    // claim wording drifts run to run for the SAME defect — so re-reviewing
    // an UNCHANGED head can now post a visible duplicate where it used to
    // silently persist. That trade is deliberate. It is also bounded: this
    // branch only fires on the SAME head, and `post --from` replays the
    // exact same findings.json, so identical claims yield identical
    // fingerprints and that path is unaffected.
    if (sameHead && posted.marker.line === finding.line) {
      if (posted.marker.c === claimFingerprint(finding.claim)) {
        exact.push({ posted, distance: 0 });
      }
      continue;
    }
    const line = posted.liveLine ?? posted.marker.line;
    const distance = Math.abs(line - finding.line);
    if (distance > window) continue;
    windowed.push({ posted, distance });
  }
  // A same-head exact stored-line match always outranks every window
  // candidate for this finding, even one that happens to also sit at
  // distance 0 on the live line — the exact branch is authoritative, not
  // merely a tiebreak, per design D2's ordering ("exact first, THEN window").
  return exact.length > 0 ? exact : windowed;
}

// One-to-one, greedy-nearest, UNDER-match by construction (spec "Match by
// path and a narrow line window, one-to-one" + "Ambiguous matches post as
// new, never a forced match"). Findings are matched in input order; each
// posted comment is consumable at most once, so two findings can never both
// claim the same prior comment. An ambiguous tie (two candidates at the
// identical minimum distance) resolves to POST, never to an arbitrary pick —
// this is the test that would fail if someone later widened the window or
// made the match many-to-many: widen it and a tie that used to post fresh
// starts silently forcing a match instead. The one exception is the `c`
// fingerprint tie-break (design D3): among candidates ALREADY tied at the
// minimum distance, a fingerprint match picks the winner. It never widens
// the window and never overrides a strictly nearer candidate — it only
// resolves a tie that would otherwise post fresh, and a tie where no
// candidate's fingerprint matches still falls through to post-as-new.
function resolveWinner(
  finding: PrHeroFindingRef,
  candidates: Candidate[],
): PostedFindingComment | undefined {
  if (candidates.length === 0) return undefined;
  const minDistance = Math.min(...candidates.map((c) => c.distance));
  const tied = candidates.filter((c) => c.distance === minDistance);
  if (tied.length === 1) return tied[0]?.posted;
  const fingerprint = claimFingerprint(finding.claim);
  const matching = tied.filter((c) => c.posted.marker.c === fingerprint);
  return matching.length === 1 ? matching[0]?.posted : undefined;
}

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
    const candidates = candidatesFor(finding, available, window, input.headSha);
    const winner = resolveWinner(finding, candidates);
    if (winner === undefined) {
      fresh.push(finding);
      continue;
    }
    available.delete(winner);
    persist.push({ finding, posted: winner });
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
  // Un-anchorable, unmatched findings — go into the summary Outside Diff
  // section (issues #16/#17, Greptile-shaped), not one issue comment each.
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
