// Pure-decision tests for applyTriageReplies (ROADMAP B6c) — literal in →
// literal out, same discipline as triage.test.ts and pr-preflight.test.ts's
// marker suites. Builds real marker text via findingMarker/triageMarker
// rather than hand-writing `<!-- pr-hero-... -->` strings, so a change to
// either wire format breaks this suite the same way it would break the real
// binder.

import { describe, expect, test } from "bun:test";
import type { StoredComparisonRow } from "../src/ledger";
import { findingMarker } from "../src/pr-preflight";
import { triageMarker } from "../src/triage";
import {
  applyTriageReplies,
  type TriageReplyCandidate,
} from "../src/triage-write";

const HEAD = "e3ab386a63020c6f5c21d814d176ff33849eef8d";
const PARENT_CLAIM = "the latch never resets";

function prheroRow(
  over: Partial<StoredComparisonRow> = {},
): StoredComparisonRow {
  return {
    bucket: "prhero_only",
    greptile: null,
    prhero: {
      id: "F001",
      path: "src/a.ts",
      line: 10,
      claim: PARENT_CLAIM,
      tier: "blocking",
    },
    verdict: null,
    reasoning: null,
    actor: null,
    ...over,
  };
}

// A real finding comment body (marker + claim prose, mirroring
// postInlineFindings) at src/a.ts:10 — the ONE parent every reply below
// binds to, unless a test overrides `parentBody` itself.
const PARENT_BODY = `${findingMarker({ path: "src/a.ts", line: 10, headSha: HEAD, claim: PARENT_CLAIM })}\n${PARENT_CLAIM}`;

function reply(
  fields: Parameters<typeof triageMarker>[0],
  reasoning: string,
  parentBody: string = PARENT_BODY,
): TriageReplyCandidate {
  return { parentBody, replyBody: `${triageMarker(fields)}\n${reasoning}` };
}

describe("applyTriageReplies — verdict composition (ROADMAP B6c)", () => {
  // The composite string is deliberate: both what the author claimed AND
  // (for the adjudicated tags) whether it held up must survive into the
  // ledger's AS-IS tally — collapsing "dismissed/rejected" to "dismissed"
  // would hide the most interesting number the loop produces. `inconclusive`
  // is the one exception: it stays `null` (Pending triage) rather than a
  // settled-looking string, but `actor` is still written on that row — see
  // the dedicated assertion below.
  test.each([
    [{ tag: "applied", headSha: HEAD, actor: "agent" } as const, "applied"],
    [
      {
        tag: "dismissed",
        headSha: HEAD,
        actor: "agent",
        verdict: "upheld",
      } as const,
      "dismissed/upheld",
    ],
    [
      {
        tag: "dismissed",
        headSha: HEAD,
        actor: "agent",
        verdict: "rejected",
      } as const,
      "dismissed/rejected",
    ],
    [
      {
        tag: "deferred",
        headSha: HEAD,
        actor: "human",
        issue: 42,
        verdict: "upheld",
      } as const,
      "deferred/upheld",
    ],
  ])("%o composes as %s", (fields, expected) => {
    const outcome = applyTriageReplies(
      [prheroRow()],
      [reply(fields, "reasoning prose")],
    );
    expect(outcome.bound).toBe(1);
    expect(outcome.rows[0]?.verdict).toBe(expected);
    expect(outcome.rows[0]?.actor).toBe(fields.actor);
    expect(outcome.rows[0]?.reasoning).toBe("reasoning prose");
  });

  // The escalation seam (ROADMAP B6b/B6c): inconclusive leaves verdict null
  // (routes to Pending triage, ledger.ts:289) but actor IS written — that
  // is what lets a reader tell "adjudicated, could not settle" apart from
  // "nobody has looked yet" (both null).
  test("inconclusive: verdict stays null, actor is still written", () => {
    const outcome = applyTriageReplies(
      [prheroRow()],
      [
        reply(
          {
            tag: "misclassified",
            headSha: HEAD,
            actor: "agent",
            verdict: "inconclusive",
          },
          "unclear whether this is a classification error",
        ),
      ],
    );
    expect(outcome.bound).toBe(1);
    expect(outcome.rows[0]?.verdict).toBeNull();
    expect(outcome.rows[0]?.actor).toBe("agent");
  });
});

describe("applyTriageReplies — path+line collisions (real data shape, compare.ts:103-107)", () => {
  // Two distinct findings can legitimately share a path+line (e.g. PR 1509:
  // two defects at the same location). A reply must bind to the row whose
  // claim its marker's `c` fingerprint actually matches, never to whichever
  // tied row happens to be first — that would silently overwrite the WRONG
  // row's verdict/reasoning/actor.
  const CLAIM_A = "the latch never resets";
  const CLAIM_B = "the retry counter overflows silently";

  function twoTiedRows(): StoredComparisonRow[] {
    return [
      prheroRow({
        prhero: {
          id: "F001",
          path: "src/a.ts",
          line: 10,
          claim: CLAIM_A,
          tier: "blocking",
        },
      }),
      prheroRow({
        prhero: {
          id: "F002",
          path: "src/a.ts",
          line: 10,
          claim: CLAIM_B,
          tier: "blocking",
        },
      }),
    ];
  }

  test("fingerprint picks the RIGHT row out of two tied at the same path+line", () => {
    const parentForB = `${findingMarker({ path: "src/a.ts", line: 10, headSha: HEAD, claim: CLAIM_B })}\n${CLAIM_B}`;
    const outcome = applyTriageReplies(twoTiedRows(), [
      reply(
        { tag: "applied", headSha: HEAD, actor: "agent" },
        "fixed B",
        parentForB,
      ),
    ]);
    expect(outcome.bound).toBe(1);
    expect(outcome.ignored).toBe(0);
    // Row F001 (claim A) must stay untouched.
    expect(outcome.rows[0]?.verdict).toBeNull();
    expect(outcome.rows[0]?.actor).toBeNull();
    // Row F002 (claim B) is the one that gets bound.
    expect(outcome.rows[1]?.verdict).toBe("applied");
    expect(outcome.rows[1]?.actor).toBe("agent");
  });

  test("fingerprint matches NEITHER tied row: refuses to bind", () => {
    const foreignClaim = "something else entirely";
    const parentForForeign = `${findingMarker({ path: "src/a.ts", line: 10, headSha: HEAD, claim: foreignClaim })}\n${foreignClaim}`;
    const outcome = applyTriageReplies(twoTiedRows(), [
      reply(
        { tag: "applied", headSha: HEAD, actor: "agent" },
        "fixed",
        parentForForeign,
      ),
    ]);
    expect(outcome.bound).toBe(0);
    expect(outcome.ignored).toBe(1);
    expect(outcome.rows[0]?.verdict).toBeNull();
    expect(outcome.rows[1]?.verdict).toBeNull();
  });

  test("fingerprint matches BOTH tied rows (duplicate claims): refuses to bind", () => {
    const rows: StoredComparisonRow[] = [
      prheroRow({
        prhero: {
          id: "F001",
          path: "src/a.ts",
          line: 10,
          claim: PARENT_CLAIM,
          tier: "blocking",
        },
      }),
      prheroRow({
        prhero: {
          id: "F002",
          path: "src/a.ts",
          line: 10,
          claim: PARENT_CLAIM,
          tier: "blocking",
        },
      }),
    ];
    const outcome = applyTriageReplies(rows, [
      reply({ tag: "applied", headSha: HEAD, actor: "agent" }, "fixed"),
    ]);
    expect(outcome.bound).toBe(0);
    expect(outcome.ignored).toBe(1);
    expect(outcome.rows[0]?.verdict).toBeNull();
    expect(outcome.rows[1]?.verdict).toBeNull();
  });
});

describe("applyTriageReplies — ignored replies", () => {
  // Three distinct reasons a reply never binds — a foreign parent
  // (somebody else's conversation), a reply that is not a triage marker at
  // all (an ordinary human reply), and a marker whose parent's path+line
  // matches no row — each must be ignored, never crash the binder or
  // silently touch an unrelated row.
  test.each([
    [
      "foreign parent",
      reply(
        { tag: "applied", headSha: HEAD, actor: "human" },
        "n/a",
        "just a human saying hi, no marker here",
      ),
    ],
    [
      "not a triage marker",
      { parentBody: PARENT_BODY, replyBody: "looks right to me, thanks" },
    ],
    [
      "no row at that path+line",
      reply(
        { tag: "applied", headSha: HEAD, actor: "agent" },
        "fixed",
        `${findingMarker({ path: "src/other.ts", line: 99, headSha: HEAD, claim: "unrelated" })}\nunrelated`,
      ),
    ],
  ])("%s", (_label, candidate) => {
    const outcome = applyTriageReplies([prheroRow()], [candidate]);
    expect(outcome.bound).toBe(0);
    expect(outcome.ignored).toBe(1);
    expect(outcome.rows[0]?.verdict).toBeNull();
    expect(outcome.rows[0]?.actor).toBeNull();
  });
});

describe("applyTriageReplies — idempotency and last-write-wins", () => {
  // Idempotent + last-write-wins (ROADMAP B6c): re-running (or a second
  // reply landing on the same finding) overwrites the row in place, never
  // duplicates it, and the LAST reply in the given order is the one that
  // sticks.
  test("two replies on the same finding: the LAST one wins, not the first", () => {
    const replies = [
      reply(
        { tag: "dismissed", headSha: HEAD, actor: "agent", verdict: "upheld" },
        "first triage attempt",
      ),
      reply(
        { tag: "applied", headSha: HEAD, actor: "human" },
        "actually just fixed it directly",
      ),
    ];
    const outcome = applyTriageReplies([prheroRow()], replies);
    expect(outcome.bound).toBe(2);
    expect(outcome.rows[0]?.verdict).toBe("applied");
    expect(outcome.rows[0]?.actor).toBe("human");
    expect(outcome.rows[0]?.reasoning).toBe("actually just fixed it directly");
  });

  // Re-running over the SAME replies must produce byte-identical rows —
  // never appended, never drifted — and never mutate the caller's array.
  test("re-running over the same replies is idempotent, and never mutates the input", () => {
    const rows = [prheroRow()];
    const replies = [
      reply({ tag: "applied", headSha: HEAD, actor: "agent" }, "fixed"),
    ];
    const first = applyTriageReplies(rows, replies);
    const second = applyTriageReplies(first.rows, replies);
    expect(second.rows).toEqual(first.rows);
    expect(second.bound).toBe(1);
    expect(rows[0]?.verdict).toBeNull();
  });
});

// The reasoning strip mirrors parseTriageMarker's own "only the first line
// is the marker" contract: a reply that quotes a prior marker mid-body must
// keep that quoted line intact as part of its prose.
test("reasoning is everything after the marker's first line, verbatim", () => {
  const reasoning =
    "line one of the argument\nquoting an old marker below:\n" +
    "<!-- pr-hero-triage tag=applied head=aaaa actor=agent -->\nline three";
  const outcome = applyTriageReplies(
    [prheroRow()],
    [reply({ tag: "applied", headSha: HEAD, actor: "agent" }, reasoning)],
  );
  expect(outcome.rows[0]?.reasoning).toBe(reasoning);
});
