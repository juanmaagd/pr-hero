// Pure decisions for `pr-hero triage reply` (W1 / issues #21 #20 #22).
// The coding agent chooses the tag and writes reasoning; this module
// chooses WHICH posted comment is the parent and whether the driver should
// resolve the GitHub review thread. NO I/O — cli.ts/pr.ts execute the plan.
//
// WHY a dedicated matcher, not matchPostedFindings (inline.ts): that matcher
// uses FINDING_LINE_WINDOW and livePath/liveLine so a re-review can find a
// prior comment after a small drift. Using it here would pick a parent by
// "nearest line on the live diff" — the exact 1724 failure (Greptile sat
// on the same path:line; the agent replied there). Triage identity is the
// finding marker: path + line + head + claim fingerprint, never location
// heuristics.

import type { PostedFindingComment } from "./inline";
import { claimFingerprint } from "./pr-preflight";
import { parseTriageMarker, type TriageVerdict } from "./triage";

export interface FindingIdentity {
  path: string;
  line: number;
  claim: string;
}

export type FindingCommentMatch =
  | { kind: "none" }
  | { kind: "matched"; posted: PostedFindingComment }
  | { kind: "ambiguous"; ids: number[] };

// Exact marker identity. `livePath`/`liveLine` are ignored on purpose:
// GitHub's live projection is what made 1724 look like "the comment at
// this line", and Greptile had already taken that line. Two posted
// comments that share the fingerprint is a driver bug (duplicate post),
// not a tie to break by proximity — fail closed.
export function matchPostedFindingExact(input: {
  finding: FindingIdentity;
  headSha: string;
  posted: PostedFindingComment[];
}): FindingCommentMatch {
  const fingerprint = claimFingerprint(input.finding.claim);
  const hits = input.posted.filter(
    (comment) =>
      comment.marker.path === input.finding.path &&
      comment.marker.line === input.finding.line &&
      comment.marker.headSha === input.headSha &&
      comment.marker.c === fingerprint,
  );
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) {
    const posted = hits[0];
    if (posted === undefined) return { kind: "none" };
    return { kind: "matched", posted };
  }
  return { kind: "ambiguous", ids: hits.map((comment) => comment.id) };
}

export type ThreadResolveDecision =
  | "resolve"
  | "skip-issue-channel"
  | "skip-inconclusive";

// Inline review threads close when the finding is handled. Issue-comment
// findings have no review thread (#17). `inconclusive` stays open so the
// human objector can still see an unresolved conversation.
export function decideThreadResolve(input: {
  channel: "review" | "issue";
  verdict?: TriageVerdict;
}): ThreadResolveDecision {
  if (input.channel === "issue") return "skip-issue-channel";
  if (input.verdict === "inconclusive") return "skip-inconclusive";
  return "resolve";
}

export interface ReviewReplyRef {
  in_reply_to_id: number | null;
  body: string;
}

// Same-head re-post guard: the finding marker's head is the budget unit
// (SKILL.md "One adjudication per finding per HEAD"). A second `triage
// reply` at that head must not create another comment.
export function existingTriageAtHead(input: {
  parentId: number;
  headSha: string;
  replies: ReviewReplyRef[];
}): boolean {
  return input.replies.some((reply) => {
    if (reply.in_reply_to_id !== input.parentId) return false;
    const marker = parseTriageMarker(reply.body);
    return marker !== null && marker.headSha === input.headSha;
  });
}
