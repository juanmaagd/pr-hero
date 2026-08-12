// Pure-decision tests for the inline review surface (ROADMAP B6): anchorability
// prediction, cross-run matching, and the post plan those two combine into.
// All offline — literal in → literal out, same discipline as size-gate.test.ts.

import { describe, expect, test } from "bun:test";
import type { PrHeroFindingRef } from "../src/compare";
import {
  buildPostPlan,
  classifyAnchorability,
  FINDING_LINE_WINDOW,
  type HunkAnchors,
  matchPostedFindings,
  type PostedFindingComment,
  parseHunkAnchors,
} from "../src/inline";

function finding(
  path: string,
  line: number,
  overrides: Partial<PrHeroFindingRef> = {},
): PrHeroFindingRef {
  return {
    id: `F${line}`,
    path,
    line,
    claim: "a defect",
    tier: "blocking",
    ...overrides,
  };
}

function posted(
  path: string,
  line: number,
  overrides: Partial<PostedFindingComment> = {},
): PostedFindingComment {
  return {
    id: overrides.id ?? line,
    channel: overrides.channel ?? "review",
    marker: {
      path,
      line,
      headSha: "aaaa000011112222333344445555666677778888",
      c: "c1c1c1c1c1c1",
    },
    ...overrides,
  };
}

// A single-record unified diff whose one hunk covers `count` RIGHT-side lines
// starting at line 1, all as fresh `+` content — enough to build a HunkAnchors
// fixture without hand-writing hundreds of context lines.
function diffAddingLines(path: string, count: number): string {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${count} @@\n` +
    `${body}\n`
  );
}

// Two disjoint hunks, matching the spec's "outside every hunk" example
// (128-135, 157-184) shape without needing that exact size.
function diffTwoHunks(path: string): string {
  const hunkA = Array.from({ length: 8 }, (_, i) => ` context ${i}`).join("\n");
  const hunkB = Array.from({ length: 28 }, (_, i) => ` context ${i}`).join(
    "\n",
  );
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -128,8 +128,8 @@\n` +
    `${hunkA}\n` +
    `@@ -157,28 +157,28 @@\n` +
    `${hunkB}\n`
  );
}

describe("parseHunkAnchors + classifyAnchorability", () => {
  test("inside a hunk is anchorable", () => {
    const patch = diffAddingLines("src/size-gate.ts", 486);
    const anchors = parseHunkAnchors(patch);
    expect(
      classifyAnchorability({ path: "src/size-gate.ts", line: 345 }, anchors),
    ).toBe("anchorable");
  });

  test("outside every hunk is un-anchorable", () => {
    const patch = diffTwoHunks("src/pr.ts");
    const anchors = parseHunkAnchors(patch);
    expect(
      classifyAnchorability({ path: "src/pr.ts", line: 68 }, anchors),
    ).toBe("un-anchorable");
    // Sanity: a line the hunks DO cover is anchorable, so this is testing the
    // boundary and not an empty anchor set.
    expect(
      classifyAnchorability({ path: "src/pr.ts", line: 130 }, anchors),
    ).toBe("anchorable");
  });

  test("a path absent from the diff entirely is un-anchorable", () => {
    const anchors: HunkAnchors = new Map();
    expect(
      classifyAnchorability({ path: "src/never-touched.ts", line: 1 }, anchors),
    ).toBe("un-anchorable");
  });

  test("a deletion-only line never anchors (right side did not move)", () => {
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n" +
      "index 0000000..1111111 100644\n" +
      "--- a/src/a.ts\n" +
      "+++ b/src/a.ts\n" +
      "@@ -1,3 +1,1 @@\n" +
      " kept line\n" +
      "-removed line\n" +
      "-removed line 2\n";
    const anchors = parseHunkAnchors(patch);
    // Only the one context line survives on the right side, at line 1.
    expect(classifyAnchorability({ path: "src/a.ts", line: 1 }, anchors)).toBe(
      "anchorable",
    );
    expect(classifyAnchorability({ path: "src/a.ts", line: 2 }, anchors)).toBe(
      "un-anchorable",
    );
  });
});

const HEAD = "aaaa000011112222333344445555666677778888";

describe("matchPostedFindings", () => {
  test("distance within the window matches (drift after intervening pushes)", () => {
    const result = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 100, { liveLine: 105 })],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  test("distance beyond the window does not match", () => {
    const result = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 106)],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(0);
    expect(result.fresh).toHaveLength(1);
  });

  test("the boundary is exact: window itself matches, window+1 does not", () => {
    const atWindow = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 100 + FINDING_LINE_WINDOW)],
      headSha: HEAD,
    });
    expect(atWindow.persist).toHaveLength(1);

    const pastWindow = matchPostedFindings({
      findings: [finding("src/a.ts", 100)],
      posted: [posted("src/a.ts", 100 + FINDING_LINE_WINDOW + 1)],
      headSha: HEAD,
    });
    expect(pastWindow.persist).toHaveLength(0);
  });

  test("same line, different path does not match", () => {
    const result = matchPostedFindings({
      findings: [finding("b.ts", 50)],
      posted: [posted("a.ts", 50)],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(0);
    expect(result.fresh).toHaveLength(1);
  });

  test("a renamed file matches on GitHub's live path, not the marker's", () => {
    const result = matchPostedFindings({
      findings: [finding("new.ts", 40)],
      posted: [posted("old.ts", 40, { livePath: "new.ts", liveLine: 40 })],
      headSha: HEAD,
    });
    expect(result.persist).toHaveLength(1);
    expect(result.persist[0]?.posted.marker.path).toBe("old.ts");
  });

  // The direction-of-error pin: an ambiguous tie must post fresh, never force
  // a match. This is the test that would fail if someone later widened the
  // window (making both candidates equidistant differently) or made the
  // match many-to-many (letting the finding pair with BOTH).
  test("an ambiguous tie posts as new rather than forcing a match", () => {
    const result = matchPostedFindings({
      findings: [finding("a.ts", 100)],
      posted: [posted("a.ts", 98), posted("a.ts", 102, { id: 2 })],
      headSha: HEAD,
    });
    expect(result.fresh).toHaveLength(1);
    expect(result.persist).toHaveLength(0);
    // Neither prior comment was consumed — both stay eligible as "resolved"
    // this run if nothing else claims them.
    expect(result.resolved).toHaveLength(2);
  });

  test("each posted comment is matched at most once (one-to-one)", () => {
    const shared = posted("a.ts", 100);
    const result = matchPostedFindings({
      findings: [finding("a.ts", 100), finding("a.ts", 101, { id: "F2" })],
      posted: [shared],
      headSha: HEAD,
    });
    // The first finding (exact distance 0) claims it; the second finding
    // finds nothing left to match and posts fresh instead of double-claiming.
    expect(result.persist).toHaveLength(1);
    expect(result.persist[0]?.finding.line).toBe(100);
    expect(result.fresh).toHaveLength(1);
    expect(result.fresh[0]?.line).toBe(101);
  });

  test("first-ever run: nothing posted before, everything is fresh", () => {
    const result = matchPostedFindings({
      findings: [finding("a.ts", 1), finding("b.ts", 2, { id: "F2" })],
      posted: [],
      headSha: HEAD,
    });
    expect(result.fresh).toHaveLength(2);
    expect(result.persist).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });
});

describe("buildPostPlan", () => {
  test("mixed run: 1 resolved, 1 new, 2 persist", () => {
    const persistPosted1 = posted("a.ts", 10, { id: 1 });
    const persistPosted2 = posted("b.ts", 20, { id: 2 });
    const resolvedPosted = posted("c.ts", 30, { id: 3 });

    const plan = buildPostPlan({
      findings: [
        finding("a.ts", 10),
        finding("b.ts", 20, { id: "F2" }),
        finding("d.ts", 40, { id: "F3" }),
      ],
      anchors: new Map(),
      posted: [persistPosted1, persistPosted2, resolvedPosted],
      headSha: HEAD,
    });

    expect(plan.delta).toEqual({ resolved: 1, new: 1, persist: 2 });
    expect(plan.persisting).toHaveLength(2);
    expect(plan.resolved).toEqual([resolvedPosted]);
  });

  test("first run: 0 resolved, K new, 0 persist", () => {
    const plan = buildPostPlan({
      findings: [finding("a.ts", 1), finding("b.ts", 2, { id: "F2" })],
      anchors: new Map(),
      posted: [],
      headSha: HEAD,
    });
    expect(plan.delta).toEqual({ resolved: 0, new: 2, persist: 0 });
  });

  test("fresh findings split by anchorability into review vs issue comments", () => {
    const anchors = parseHunkAnchors(diffAddingLines("src/a.ts", 50));
    const plan = buildPostPlan({
      findings: [
        finding("src/a.ts", 10), // inside the hunk -> anchorable
        finding("src/never-touched.ts", 68, { id: "F2" }), // absent -> un-anchorable
      ],
      anchors,
      posted: [],
      headSha: HEAD,
    });
    expect(plan.reviewComments.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(plan.issueComments.map((f) => f.path)).toEqual([
      "src/never-touched.ts",
    ]);
  });
});
