// Triage reply marker (ROADMAP B6b) — pure. The FIRST line of the consumer's
// coding agent's reply in a finding's own thread, so a future reader (a
// human, or 6c's ledger write-back) can tell "this finding was triaged" from
// "nobody has looked yet" without parsing prose.
//
// NO I/O. Same contract as pr-preflight.ts/inline.ts: no gh, no git, no
// network, no filesystem, no clock. The consuming skill (this repo's
// `skills/pr-hero-triage/`) runs in the CONSUMER's coding agent, outside
// this process entirely — this module only defines the wire format both
// sides agree on.
//
// Disjoint from PR_COMMENT_MARKER_PREFIX and PR_FINDING_MARKER_PREFIX on
// purpose, same reasoning as their own disjointness (pr-preflight.ts): a
// triage reply lands in the SAME comment stream as the summary and the
// per-finding markers (review comment threads and issue comments alike), so
// a matcher that could confuse any of the three families would misfile a
// reply as a finding, or a finding as a reply. See the three-way
// disjointness test in test/triage.test.ts.
export const TRIAGE_MARKER_PREFIX = "<!-- pr-hero-triage ";

// The FOUR tags an author may write (ROADMAP B6b table) — deliberately NOT
// the `refuter_verdict` schema enum (findings.ts), which is sacred under
// rule 5 and not ours to extend. This is a separate, project-owned
// vocabulary the triage loop invented, so adding a tag here costs no schema
// change and no coordination with the lab.
export type TriageTag = "applied" | "dismissed" | "deferred" | "misclassified";

const TRIAGE_TAGS: ReadonlySet<string> = new Set<TriageTag>([
  "applied",
  "dismissed",
  "deferred",
  "misclassified",
]);

// Who wrote the tag. Mirrors 6c's `actor` field on ComparisonRow (not wired
// here — this module only defines the marker both sides read/write) so a
// reader can eventually tell "a human overrode this row" from "the agent
// decided" without a second vocabulary.
export type TriageActor = "agent" | "human";

const TRIAGE_ACTORS: ReadonlySet<string> = new Set<TriageActor>([
  "agent",
  "human",
]);

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface TriageMarkerFields {
  tag: TriageTag;
  headSha: string;
  actor: TriageActor;
  // The GitHub issue number carrying a deferred finding's real destination.
  // REQUIRED when tag is "deferred" (ROADMAP B6b: "without it, defer is a
  // dismiss with a better name") — triageMarker throws rather than emit a
  // marker that would decay into an un-tracked dismiss. Meaningless for
  // every other tag and ignored if supplied.
  issue?: number;
}

// Builds the marker. Throws on a `deferred` fields object with no `issue`
// rather than silently omitting it — the whole point of the field is that a
// deferred finding without a real destination is a bug, not a valid state,
// and a pure function that accepted one anyway would let that bug reach
// GitHub before anyone could catch it.
export function triageMarker(fields: TriageMarkerFields): string {
  if (fields.tag === "deferred" && fields.issue === undefined) {
    throw new Error(
      "triageMarker: tag=deferred requires an issue number (ROADMAP B6b)",
    );
  }
  const issuePart = fields.tag === "deferred" ? ` issue=${fields.issue}` : "";
  return (
    `${TRIAGE_MARKER_PREFIX}tag=${fields.tag} head=${fields.headSha} ` +
    `actor=${fields.actor}${issuePart} -->`
  );
}

export interface ParsedTriageMarker {
  tag: TriageTag;
  headSha: string;
  actor: TriageActor;
  // Present only when tag is "deferred" (parseTriageMarker enforces this —
  // a deferred marker with no issue never reaches this type, it returns
  // null instead).
  issue?: number;
}

// Parses ONLY the first line of a reply body, mirroring
// parseFindingMarker's exact-prefix contract: a marker quoted mid-reply
// (someone pasting a prior triage into a new comment) must never parse as a
// fresh one. Returns null for anything malformed rather than guessing — a
// mis-parsed triage becomes a silently wrong ledger tally (6c), exactly the
// failure ledger.ts's loud per-field validation exists to prevent.
export function parseTriageMarker(body: string): ParsedTriageMarker | null {
  if (!body.startsWith(TRIAGE_MARKER_PREFIX)) return null;
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (!firstLine.endsWith(" -->")) return null;
  const fields = firstLine.slice(
    TRIAGE_MARKER_PREFIX.length,
    firstLine.length - " -->".length,
  );
  const parts = new Map<string, string>();
  for (const token of fields.split(" ")) {
    if (token.length === 0) continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    parts.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const rawTag = parts.get("tag");
  const headSha = parts.get("head");
  const rawActor = parts.get("actor");
  if (rawTag === undefined || headSha === undefined || rawActor === undefined) {
    return null;
  }
  if (!TRIAGE_TAGS.has(rawTag)) return null;
  if (!TRIAGE_ACTORS.has(rawActor)) return null;
  if (!FULL_SHA.test(headSha)) return null;
  const tag = rawTag as TriageTag;
  const actor = rawActor as TriageActor;

  // `deferred` MUST carry a valid issue number — the ROADMAP B6b rule this
  // parser exists to enforce, not just record. A deferred marker with no
  // issue, or a non-numeric one, is malformed: returning null here (rather
  // than a marker with `issue: undefined`) is what stops a defer from being
  // silently counted as a dismiss downstream.
  if (tag === "deferred") {
    const rawIssue = parts.get("issue");
    if (rawIssue === undefined) return null;
    const issue = Number.parseInt(rawIssue, 10);
    if (!Number.isInteger(issue) || issue <= 0) return null;
    return { tag, headSha, actor, issue };
  }
  return { tag, headSha, actor };
}
