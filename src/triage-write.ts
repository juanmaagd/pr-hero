// Binds triage replies (ROADMAP B6c) to their comparison.json row — the
// pure half of `pr-hero triage`. NO I/O, same contract as pr-preflight.ts
// and ledger.ts: no gh, no git, no filesystem, no clock. The caller
// (cli.ts) fetches the PR's review comments, finds every reply
// (`in_reply_to_id` set) and hands over only the (parent body, reply body)
// pair — this module never sees the wider comment stream, never decides
// what counts as a reply, and never touches disk.

import type { StoredComparisonRow } from "./ledger";
import { claimFingerprint, parseFindingMarker } from "./pr-preflight";
import { type ParsedTriageMarker, parseTriageMarker } from "./triage";

export interface TriageReplyCandidate {
  // The body of the comment this reply is IN_REPLY_TO. Parsed with the
  // SAME parser the poster's own finding comment was built from
  // (parseFindingMarker) — a foreign comment (not one of pr-hero's own
  // finding markers) is rejected by that parser, never a second heuristic
  // that could disagree with it.
  parentBody: string;
  // The reply's own body — its first line is 6b's triage marker, the rest
  // is the author's reasoning prose.
  replyBody: string;
}

export interface TriageBindOutcome {
  rows: StoredComparisonRow[];
  bound: number;
  ignored: number;
}

// Applies every candidate reply to `rows`, in the ORDER GIVEN. The caller
// must hand replies over in chronological (creation) order — GitHub's own
// order for `pulls/<n>/comments` — because a finding that collects more
// than one triage reply resolves LAST-WRITE-WINS: the newest triage is the
// current one (ROADMAP B6c spec, "if several replies bind to one row, the
// LAST one wins"). Re-running this over the same replies is therefore
// idempotent by construction — the same last reply overwrites the same
// row to the same values, never appending or duplicating anything, because
// a row is identified by its own path+line, not by which reply touched it.
//
// Never mutates the input array: returns a fresh one, so a caller that
// still holds the pre-triage rows (e.g. to diff a dry-run's plan against
// them) is not surprised by this function's side effects.
export function applyTriageReplies(
  rows: StoredComparisonRow[],
  replies: TriageReplyCandidate[],
): TriageBindOutcome {
  const updated = rows.map((row) => ({ ...row }));
  let bound = 0;
  let ignored = 0;
  for (const reply of replies) {
    // Not one of OUR finding comments — somebody else's conversation
    // (ROADMAP B6c: "a reply whose parent is not one of our finding
    // comments is ignored — it is somebody else's conversation").
    const parent = parseFindingMarker(reply.parentBody);
    if (parent === null) {
      ignored++;
      continue;
    }
    const marker = parseTriageMarker(reply.replyBody);
    if (marker === null) {
      ignored++;
      continue;
    }
    // Location, not id: the parent finding marker carries only path+line
    // (never the internal finding id, which is not stable across runs —
    // pr-preflight.ts's own comment on ComparisonPrHeroClaim.id). This is
    // the SAME identity pr-preflight's matcher keys on, matched here
    // against a row's `prhero` side — but path+line is NOT a unique key
    // (compare.ts documents real production data with two distinct
    // findings at the same path:line, e.g. PR 1509). `.find()` would pick
    // whichever tied row happens to be first and silently overwrite ITS
    // verdict/reasoning/actor for a reply meant for the other one,
    // corrupting the audit ledger with no error. Mirror resolveWinner's
    // shape (inline.ts): collect every tied candidate, and when more than
    // one ties, disambiguate with the SAME claim fingerprint the marker
    // itself carries (`c`) — never a forced pick on ambiguity.
    const candidates = updated.filter(
      (r) =>
        r.prhero !== null &&
        r.prhero.path === parent.path &&
        r.prhero.line === parent.line,
    );
    let row: StoredComparisonRow | undefined;
    if (candidates.length === 1) {
      row = candidates[0];
    } else if (candidates.length > 1) {
      const matching = candidates.filter(
        (r) =>
          r.prhero !== null && claimFingerprint(r.prhero.claim) === parent.c,
      );
      row = matching.length === 1 ? matching[0] : undefined;
    }
    if (row === undefined) {
      ignored++;
      continue;
    }
    row.verdict = composeVerdict(marker);
    row.actor = marker.actor;
    row.reasoning = stripMarkerLine(reply.replyBody);
    bound++;
  }
  return { rows: updated, bound, ignored };
}

// The composite verdict string (ROADMAP B6c, "this composite is
// deliberate"): `applied` pays no adjudicator, so it is its own verdict.
// The three adjudicated tags carry `<tag>/<adjudicator verdict>` so BOTH
// facts survive into the ledger's AS-IS tally — what the author claimed,
// and whether it held up under adjudication; collapsing to just the tag
// would hide the single most interesting number the loop can produce (how
// often an agent's own claim is rejected). An `inconclusive` ruling leaves
// the row's verdict at `null` — which routes it to Pending triage
// (ledger.ts:289) instead of inventing a settled-looking string for a
// finding nobody actually settled; `actor` is still written, which is what
// lets a reader tell "adjudicated, could not settle" apart from "nobody
// has looked yet" (both-null).
function composeVerdict(marker: ParsedTriageMarker): string | null {
  if (marker.tag === "applied") return "applied";
  // parseTriageMarker guarantees `verdict` is present for every other tag
  // (the ADJUDICATED_TAGS guard in triage.ts) — this branch is exhaustive.
  if (marker.verdict === "inconclusive") return null;
  return `${marker.tag}/${marker.verdict}`;
}

// The reasoning is everything AFTER the marker's own first line — mirrors
// parseTriageMarker's "only the first line is the marker" contract, so a
// reply that happens to quote a prior triage marker mid-body still keeps
// its real prose intact rather than losing it to a naive strip.
function stripMarkerLine(body: string): string {
  const newline = body.indexOf("\n");
  if (newline === -1) return "";
  return body.slice(newline + 1).trim();
}
