import { describe, expect, test } from "bun:test";
import {
  decideLastHeadDelta,
  decideRereviewCase,
  incompleteLastReviewMessage,
  planDiscovery,
  resolveLastReviewedHead,
  restrictedDiscoveryFiles,
  unreachableLastHeadMessage,
} from "#rereview/plan";

const L = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "cccccccccccccccccccccccccccccccccccccccc";

describe("resolveLastReviewedHead — S-A", () => {
  test("the summary marker wins over finding-marker heads", () => {
    expect(
      resolveLastReviewedHead({
        summaryHead: L,
        summaryComplete: true,
        findingMarkers: [{ headSha: OTHER, createdAt: "2026-08-21T00:00:00Z" }],
      }),
    ).toEqual({ L, source: "summary_marker", lastComplete: true });
  });

  test("with the summary gone, L is the latest finding-marker created_at", () => {
    expect(
      resolveLastReviewedHead({
        summaryHead: null,
        summaryComplete: true,
        findingMarkers: [
          { headSha: OTHER, createdAt: "2026-08-20T00:00:00Z" },
          { headSha: L, createdAt: "2026-08-21T00:00:00Z" },
        ],
      }),
    ).toEqual({ L, source: "finding_markers", lastComplete: true });
  });

  test("no summary and no markers is case-A absent, not a guessed head", () => {
    expect(
      resolveLastReviewedHead({
        summaryHead: null,
        summaryComplete: true,
        findingMarkers: [],
      }),
    ).toEqual({ L: null, source: "absent", lastComplete: true });
  });

  // The rereview-coverage fix: completeness travels WITH L. A
  // partial summary marker's L is NEVER nulled out — nulling it would make
  // this function fall through to `latestMarkerHead(findingMarkers)`, and a
  // partial run's own inline finding markers carry the SAME head, so L would
  // just get resurrected there and the forced-full re-review would be a
  // no-op. The pin below is exactly that trap: an incomplete summary marker
  // AND a finding marker at the same head must still force `lastComplete`
  // false, never quietly recover `true` through the fallback path.
  test("an incomplete summary marker forces lastComplete false, even with a same-head finding marker", () => {
    expect(
      resolveLastReviewedHead({
        summaryHead: L,
        summaryComplete: false,
        findingMarkers: [{ headSha: L, createdAt: "2026-08-21T00:00:00Z" }],
      }),
    ).toEqual({ L, source: "summary_marker", lastComplete: false });
  });

  // lastComplete is only ever consulted when the summary marker itself is
  // the source of L — finding-marker recovery (no summary comment at all)
  // and the absent case both mean "nothing to distrust", so they are always
  // complete regardless of what summaryComplete says.
  test("lastComplete is always true when L comes from finding markers or is absent, ignoring summaryComplete", () => {
    expect(
      resolveLastReviewedHead({
        summaryHead: null,
        summaryComplete: false,
        findingMarkers: [{ headSha: L, createdAt: "2026-08-21T00:00:00Z" }],
      }),
    ).toEqual({ L, source: "finding_markers", lastComplete: true });
  });
});

describe("decideRereviewCase", () => {
  test("A — L absent", () => {
    expect(
      decideRereviewCase({
        L: null,
        H,
        objectExists: null,
        isAncestor: null,
      }),
    ).toBe("A");
  });

  test("B — L === H", () => {
    expect(
      decideRereviewCase({
        L: H,
        H,
        objectExists: true,
        isAncestor: true,
      }),
    ).toBe("B");
  });

  test("C — L is an ancestor of H", () => {
    expect(
      decideRereviewCase({
        L,
        H,
        objectExists: true,
        isAncestor: true,
      }),
    ).toBe("C");
  });

  test("D — L exists but is not an ancestor (force-push / rebase)", () => {
    expect(
      decideRereviewCase({
        L,
        H,
        objectExists: true,
        isAncestor: false,
      }),
    ).toBe("D");
  });

  test("E — L is not in this object store (shallow clone / GC)", () => {
    expect(
      decideRereviewCase({
        L,
        H,
        objectExists: false,
        isAncestor: null,
      }),
    ).toBe("E");
  });

  test("unknown object existence falls to E, never a truncated delta", () => {
    expect(
      decideRereviewCase({
        L,
        H,
        objectExists: null,
        isAncestor: null,
      }),
    ).toBe("E");
  });
});

describe("planDiscovery", () => {
  test("case A empty diff is still an error — first review", () => {
    const plan = planDiscovery({ case: "A", full: false, lastComplete: true });
    expect(plan).toMatchObject({
      discovery: "full",
      emptyDeltaIsError: true,
      skipDiscovery: false,
      verifyAll: false,
    });
  });

  test("S-empty — a re-review empty delta is not an error", () => {
    expect(
      planDiscovery({ case: "B", full: false, lastComplete: true })
        .emptyDeltaIsError,
    ).toBe(false);
    expect(
      planDiscovery({ case: "C", full: false, lastComplete: true })
        .emptyDeltaIsError,
    ).toBe(false);
    expect(
      planDiscovery({ case: "C", full: false, lastComplete: true }).discovery,
    ).toBe("restricted");
  });

  test("case B without --full skips discovery", () => {
    expect(
      planDiscovery({ case: "B", full: false, lastComplete: true }),
    ).toMatchObject({
      discovery: "none",
      skipDiscovery: true,
      discoveryRestricted: true,
    });
  });

  test("--full widens discovery and records the REAL case (R2-C5)", () => {
    const b = planDiscovery({ case: "B", full: true, lastComplete: true });
    expect(b.case).toBe("B");
    expect(b.discovery).toBe("full");
    expect(b.discoveryRestricted).toBe(false);
    expect(b.skipDiscovery).toBe(false);
    expect(b.verifyAll).toBe(false);

    const c = planDiscovery({ case: "C", full: true, lastComplete: true });
    expect(c.case).toBe("C");
    expect(c.discoveryRestricted).toBe(false);
    expect(c.verifyAll).toBe(false);

    const d = planDiscovery({ case: "D", full: true, lastComplete: true });
    expect(d.case).toBe("D");
    expect(d.verifyAll).toBe(true);
  });

  test("D and E verify-all on a full B..H range", () => {
    expect(
      planDiscovery({ case: "D", full: false, lastComplete: true }),
    ).toMatchObject({
      discovery: "full",
      verifyAll: true,
      emptyDeltaIsError: false,
    });
    expect(
      planDiscovery({ case: "E", full: false, lastComplete: true }).verifyAll,
    ).toBe(true);
  });

  // The defect this whole fix closes (GitHub #42's re-review half): a PARTIAL
  // run's marker used to read as complete, `decideRereviewCase` landed on B,
  // and case B's `skipDiscovery: true` branch (line ~138) meant the missing
  // hunters never ran again. `lastComplete: false` must take the SAME
  // full-discovery path `--full` takes — never rewriting the case (that stays
  // B/C/D/E per R2-C5), only widening what gets looked at — and additionally
  // force `verifyAll`, because the prior refuter may be exactly what failed.
  test("case B + lastComplete false forces full discovery, never the skipDiscovery branch", () => {
    const plan = planDiscovery({ case: "B", full: false, lastComplete: false });
    expect(plan).toMatchObject({
      case: "B",
      discovery: "full",
      discoveryRestricted: false,
      skipDiscovery: false,
      verifyAll: true,
    });
  });

  test("case C + lastComplete false forces full discovery and verifyAll", () => {
    const plan = planDiscovery({ case: "C", full: false, lastComplete: false });
    expect(plan).toMatchObject({
      case: "C",
      discovery: "full",
      discoveryRestricted: false,
      skipDiscovery: false,
      verifyAll: true,
    });
  });

  // emptyDeltaIsError stays a function of the CASE alone, never of
  // completeness — a first review (A) is still the only case that errors on
  // an empty diff, even in the degenerate combination the resolver never
  // actually produces (case A always reports lastComplete: true).
  test("emptyDeltaIsError is unaffected by lastComplete for every case", () => {
    expect(
      planDiscovery({ case: "A", full: false, lastComplete: false })
        .emptyDeltaIsError,
    ).toBe(true);
    expect(
      planDiscovery({ case: "B", full: false, lastComplete: false })
        .emptyDeltaIsError,
    ).toBe(false);
  });
});

describe("incompleteLastReviewMessage", () => {
  test("names the un-finished commit and the consequence", () => {
    const message = incompleteLastReviewMessage(L);
    expect(message).toContain(L);
    expect(message).toContain("full");
    expect(message).toContain("re-verifies");
  });
});

describe("restrictedDiscoveryFiles — S-merge / D9", () => {
  test("upstream-only files from a merge of main are absent", () => {
    const prFiles = ["src/app.ts", "src/pr.ts"];
    const deltaFiles = ["src/app.ts", "vendor/upstream.ts", "README.md"];
    expect(restrictedDiscoveryFiles(prFiles, deltaFiles)).toEqual([
      "src/app.ts",
    ]);
  });

  test("a file both the PR and the merge touched stays in", () => {
    expect(
      restrictedDiscoveryFiles(
        ["src/app.ts", "src/shared.ts"],
        ["src/shared.ts", "vendor/upstream.ts"],
      ),
    ).toEqual(["src/shared.ts"]);
  });

  test("a revert-to-base drops out of discovery (touched still sees L..H)", () => {
    // File was in the PR at L, reverted to base by H, so it is not in B..H.
    expect(
      restrictedDiscoveryFiles(
        ["src/kept.ts"],
        ["src/kept.ts", "src/reverted.ts"],
      ),
    ).toEqual(["src/kept.ts"]);
  });

  test("an empty intersection is a valid re-review delta, not a missing file", () => {
    expect(
      restrictedDiscoveryFiles(["src/app.ts"], ["vendor/upstream.ts"]),
    ).toEqual([]);
  });
});

describe("decideLastHeadDelta — the force-push gate", () => {
  test("case E (L orphaned by a force-push) never asks git for an L..H diff", () => {
    expect(decideLastHeadDelta({ case: "E", L })).toEqual({
      kind: "unreachable",
      sha: L,
    });
  });

  test("a reachable prior head still gets its L..H delta", () => {
    expect(decideLastHeadDelta({ case: "C", L })).toEqual({
      kind: "diff",
      from: L,
    });
    expect(decideLastHeadDelta({ case: "D", L })).toEqual({
      kind: "diff",
      from: L,
    });
    expect(decideLastHeadDelta({ case: "B", L })).toEqual({
      kind: "diff",
      from: L,
    });
  });

  test("a first review has no prior head to diff against", () => {
    expect(decideLastHeadDelta({ case: "A", L: null })).toEqual({
      kind: "none",
    });
    // Defensive: case A with a stray L is still a first review.
    expect(decideLastHeadDelta({ case: "A", L })).toEqual({ kind: "none" });
    expect(decideLastHeadDelta({ case: "E", L: null })).toEqual({
      kind: "none",
    });
  });
});

describe("unreachableLastHeadMessage", () => {
  test("names the orphaned commit, the likely cause, and the consequence", () => {
    const message = unreachableLastHeadMessage(L);
    expect(message).toContain(L);
    expect(message).toContain("force-push");
    expect(message).toContain("full review");
  });
});
