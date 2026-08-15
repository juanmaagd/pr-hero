// Pure-decision tests for triage-reply parent matching and resolve
// decisions (W1 / issues #20 #21 #22). Offline, no gh.

import { describe, expect, test } from "bun:test";
import type { PostedFindingComment } from "../src/inline";
import {
  claimFingerprint,
  findingMarker,
  parseFindingMarker,
} from "../src/pr-preflight";
import { triageMarker } from "../src/triage";
import {
  decideThreadResolve,
  existingTriageAtHead,
  matchPostedFindingExact,
} from "../src/triage-reply";

const HEAD = "c".repeat(40);
const OTHER_HEAD = "d".repeat(40);
const CLAIM_A = "the latch never resets on unmount";
const CLAIM_B = "the queue has no backoff cap";

function posted(input: {
  id: number;
  path: string;
  line: number;
  claim: string;
  headSha?: string;
  channel?: "review" | "issue";
  liveLine?: number;
}): PostedFindingComment {
  const headSha = input.headSha ?? HEAD;
  const body = findingMarker({
    path: input.path,
    line: input.line,
    headSha,
    claim: input.claim,
  });
  const marker = parseFindingMarker(body);
  if (marker === null) throw new Error("test fixture marker failed to parse");
  return {
    id: input.id,
    channel: input.channel ?? "review",
    marker,
    livePath: input.path,
    liveLine: input.liveLine,
  };
}

describe("matchPostedFindingExact", () => {
  const finding = { path: "docs/runbook.md", line: 144, claim: CLAIM_A };

  test("matches the pr-hero marker, ignoring a sibling at the same live line", () => {
    // 1724 shape: Greptile is NOT in `posted` (fetchPostedFindingComments
    // drops non-markers), but another pr-hero finding CAN sit nearby. The
    // matcher must not use liveLine, or a drifted sibling steals the parent.
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 11,
          path: "docs/runbook.md",
          line: 140,
          claim: CLAIM_B,
          liveLine: 144,
        }),
        posted({
          id: 22,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
          liveLine: 200,
        }),
      ],
    });
    expect(result).toEqual({
      kind: "matched",
      posted: expect.objectContaining({ id: 22 }),
    });
  });

  test("does not match on path+line alone when the claim fingerprint differs", () => {
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 11,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_B,
        }),
      ],
    });
    expect(result).toEqual({ kind: "none" });
    expect(claimFingerprint(CLAIM_A)).not.toBe(claimFingerprint(CLAIM_B));
  });

  test("does not match a different head", () => {
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 22,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
          headSha: OTHER_HEAD,
        }),
      ],
    });
    expect(result).toEqual({ kind: "none" });
  });

  test("ambiguous when two posted comments share the fingerprint", () => {
    const result = matchPostedFindingExact({
      finding,
      headSha: HEAD,
      posted: [
        posted({
          id: 22,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
        }),
        posted({
          id: 99,
          path: "docs/runbook.md",
          line: 144,
          claim: CLAIM_A,
        }),
      ],
    });
    expect(result).toEqual({ kind: "ambiguous", ids: [22, 99] });
  });
});

describe("decideThreadResolve", () => {
  test("resolves an inline applied reply", () => {
    expect(decideThreadResolve({ channel: "review" })).toBe("resolve");
  });

  test("skips issue-comment findings (no review thread)", () => {
    expect(decideThreadResolve({ channel: "issue" })).toBe(
      "skip-issue-channel",
    );
  });

  test("leaves inconclusive threads open", () => {
    expect(
      decideThreadResolve({ channel: "review", verdict: "inconclusive" }),
    ).toBe("skip-inconclusive");
  });

  test("resolves dismissed/deferred when the adjudicator settled", () => {
    expect(decideThreadResolve({ channel: "review", verdict: "upheld" })).toBe(
      "resolve",
    );
    expect(
      decideThreadResolve({ channel: "review", verdict: "rejected" }),
    ).toBe("resolve");
  });
});

describe("existingTriageAtHead", () => {
  test("detects a same-head triage reply on the parent", () => {
    expect(
      existingTriageAtHead({
        parentId: 22,
        headSha: HEAD,
        replies: [
          {
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\nok`,
          },
        ],
      }),
    ).toBe(true);
  });

  test("a different head is not a skip", () => {
    expect(
      existingTriageAtHead({
        parentId: 22,
        headSha: HEAD,
        replies: [
          {
            in_reply_to_id: 22,
            body: `${triageMarker({ tag: "applied", headSha: OTHER_HEAD, actor: "agent" })}\nok`,
          },
        ],
      }),
    ).toBe(false);
  });

  test("a reply to a different parent is not a skip", () => {
    expect(
      existingTriageAtHead({
        parentId: 22,
        headSha: HEAD,
        replies: [
          {
            in_reply_to_id: 11,
            body: `${triageMarker({ tag: "applied", headSha: HEAD, actor: "agent" })}\nok`,
          },
        ],
      }),
    ).toBe(false);
  });
});
