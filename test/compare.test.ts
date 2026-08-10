// Bucketing and rendering tests for the head-to-head comparison.
//
// The matching rule is location-only and deliberately generous, so these tests
// pin the two things a human depends on: the window boundary is inclusive and
// exact, and the ordering is deterministic.

import { describe, expect, test } from "bun:test";
import {
  compareFindings,
  DEFAULT_LINE_WINDOW,
  normalizePath,
  type PrHeroFindingRef,
} from "../src/compare";
import { BUCKET_HEADINGS, renderComparison } from "../src/compare-report";
import type { GreptileFinding } from "../src/greptile";

function greptile(over: Partial<GreptileFinding> = {}): GreptileFinding {
  return {
    index: 1,
    path: "src/a.ts",
    startLine: 100,
    endLine: 100,
    title: "Stale cache",
    description: "The derived value is never invalidated.",
    ...over,
  };
}

function prhero(over: Partial<PrHeroFindingRef> = {}): PrHeroFindingRef {
  return {
    id: "F001",
    path: "src/a.ts",
    line: 100,
    claim: "Cached list survives the mutation.",
    tier: "blocking",
    ...over,
  };
}

describe("normalizePath", () => {
  test("trims and strips one leading ./", () => {
    expect(normalizePath("  ./src/a.ts  ")).toBe("src/a.ts");
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });

  test("does not fold case or reduce to a basename", () => {
    // Two packages in this monorepo genuinely own files with the same
    // basename; matching on it would fabricate agreements across packages.
    expect(normalizePath("packages/web/src/a.ts")).not.toBe(
      normalizePath("packages/app/src/a.ts"),
    );
    expect(normalizePath("Src/A.ts")).not.toBe(normalizePath("src/a.ts"));
  });
});

describe("compareFindings — the matching rule", () => {
  test("exact same path and line pairs into both", () => {
    const result = compareFindings([prhero()], [greptile()]);
    expect(result.both).toHaveLength(1);
    expect(result.greptileOnly).toEqual([]);
    expect(result.prheroOnly).toEqual([]);
    expect(result.both[0].greptile.title).toBe("Stale cache");
    expect(result.both[0].prhero.id).toBe("F001");
  });

  test("a different path never matches, however close the lines", () => {
    const result = compareFindings(
      [prhero({ path: "src/b.ts" })],
      [greptile()],
    );
    expect(result.greptileOnly).toHaveLength(1);
    expect(result.prheroOnly).toHaveLength(1);
    expect(result.both).toEqual([]);
  });

  test("a leading ./ on either side still matches", () => {
    const result = compareFindings(
      [prhero({ path: "./src/a.ts" })],
      [greptile({ path: "src/a.ts" })],
    );
    expect(result.both).toHaveLength(1);
  });

  test("the default window is 25 and both edges are inclusive", () => {
    expect(DEFAULT_LINE_WINDOW).toBe(25);
    const g = greptile({ startLine: 100, endLine: 100 });
    // Exactly ON the boundary, both directions.
    expect(compareFindings([prhero({ line: 75 })], [g]).both).toHaveLength(1);
    expect(compareFindings([prhero({ line: 125 })], [g]).both).toHaveLength(1);
    // One line BEYOND it, both directions.
    expect(compareFindings([prhero({ line: 74 })], [g]).both).toEqual([]);
    expect(compareFindings([prhero({ line: 126 })], [g]).both).toEqual([]);
  });

  test("a Greptile range is expanded by the window on both sides", () => {
    const g = greptile({ startLine: 200, endLine: 220 });
    expect(compareFindings([prhero({ line: 175 })], [g]).both).toHaveLength(1);
    expect(compareFindings([prhero({ line: 210 })], [g]).both).toHaveLength(1);
    expect(compareFindings([prhero({ line: 245 })], [g]).both).toHaveLength(1);
    expect(compareFindings([prhero({ line: 174 })], [g]).both).toEqual([]);
    expect(compareFindings([prhero({ line: 246 })], [g]).both).toEqual([]);
  });

  test("an explicit lineWindow overrides the default, including zero", () => {
    const g = greptile({ startLine: 100, endLine: 100 });
    expect(
      compareFindings([prhero({ line: 105 })], [g], { lineWindow: 3 }).both,
    ).toEqual([]);
    expect(
      compareFindings([prhero({ line: 105 })], [g], { lineWindow: 5 }).both,
    ).toHaveLength(1);
    expect(
      compareFindings([prhero({ line: 101 })], [g], { lineWindow: 0 }).both,
    ).toEqual([]);
    expect(
      compareFindings([prhero({ line: 100 })], [g], { lineWindow: 0 }).both,
    ).toHaveLength(1);
  });
});

describe("compareFindings — bucketing", () => {
  test("the measured miss lands in greptileOnly", () => {
    const result = compareFindings([], [greptile(), greptile({ index: 2 })]);
    expect(result.greptileOnly).toHaveLength(2);
    expect(result.both).toEqual([]);
    expect(result.prheroOnly).toEqual([]);
  });

  test("unmatched pr-hero findings land in prheroOnly", () => {
    const result = compareFindings([prhero(), prhero({ id: "F002" })], []);
    expect(result.prheroOnly.map((p) => p.id)).toEqual(["F001", "F002"]);
    expect(result.greptileOnly).toEqual([]);
  });

  test("both sides empty yields three empty buckets", () => {
    const result = compareFindings([], []);
    expect(result).toEqual({ greptileOnly: [], both: [], prheroOnly: [] });
  });

  test("one pr-hero finding may pair with several Greptile findings", () => {
    // Real shape: PR 1509 reported two distinct defects at the same path:line.
    const result = compareFindings(
      [prhero()],
      [greptile({ index: 1 }), greptile({ index: 2, title: "Second defect" })],
    );
    expect(result.both).toHaveLength(2);
    expect(result.greptileOnly).toEqual([]);
    // Matched once is matched — it must not also appear as a pr-hero-only miss.
    expect(result.prheroOnly).toEqual([]);
  });

  test("one Greptile finding may pair with several pr-hero findings", () => {
    const result = compareFindings(
      [prhero({ id: "F001" }), prhero({ id: "F002", line: 110 })],
      [greptile()],
    );
    expect(result.both.map((m) => m.prhero.id)).toEqual(["F001", "F002"]);
    expect(result.prheroOnly).toEqual([]);
  });

  test("mixed input partitions every finding exactly once per side", () => {
    const p = [
      prhero({ id: "F001", line: 100 }),
      prhero({ id: "F002", path: "src/z.ts", line: 5 }),
    ];
    const g = [
      greptile({ index: 1, startLine: 100, endLine: 100 }),
      greptile({ index: 2, path: "src/q.ts", startLine: 9, endLine: 9 }),
    ];
    const result = compareFindings(p, g);
    expect(result.both.map((m) => m.prhero.id)).toEqual(["F001"]);
    expect(result.greptileOnly.map((x) => x.index)).toEqual([2]);
    expect(result.prheroOnly.map((x) => x.id)).toEqual(["F002"]);
  });

  test("output order follows Greptile index order then pr-hero input order", () => {
    const result = compareFindings(
      [prhero({ id: "F009" }), prhero({ id: "F001" })],
      [greptile({ index: 7 }), greptile({ index: 3 })],
    );
    expect(result.both.map((m) => [m.greptile.index, m.prhero.id])).toEqual([
      [7, "F009"],
      [7, "F001"],
      [3, "F009"],
      [3, "F001"],
    ]);
  });

  test("is deterministic across repeated calls", () => {
    const p = [prhero(), prhero({ id: "F002", line: 400 })];
    const g = [
      greptile(),
      greptile({ index: 2, startLine: 900, endLine: 910 }),
    ];
    expect(compareFindings(p, g)).toEqual(compareFindings(p, g));
  });
});

describe("renderComparison", () => {
  const result = compareFindings(
    [
      prhero({ id: "F001", line: 100 }),
      prhero({
        id: "F007",
        path: "src/solo.ts",
        line: 12,
        tier: "advisory",
        claim: "Only pr-hero saw this.",
      }),
    ],
    [
      greptile({ index: 1, startLine: 100, endLine: 104 }),
      greptile({
        index: 2,
        path: "src/missed.ts",
        startLine: 42,
        endLine: 42,
        title: "Missed entirely",
        description: "Nothing on the pr-hero side is near this line.",
      }),
    ],
  );
  const markdown = renderComparison(1677, result);

  test("headers carry the PR number and every bucket count", () => {
    expect(markdown).toStartWith("# Greptile vs pr-hero — PR #1677");
    expect(markdown).toContain("Greptile-only: 1");
    expect(markdown).toContain("Both: 1");
    expect(markdown).toContain("pr-hero-only: 1");
  });

  test("the measured miss is rendered first", () => {
    const miss = markdown.indexOf(BUCKET_HEADINGS.greptile_only);
    const both = markdown.indexOf(BUCKET_HEADINGS.both);
    const only = markdown.indexOf(BUCKET_HEADINGS.prhero_only);
    expect(miss).toBeGreaterThan(-1);
    expect(miss).toBeLessThan(both);
    expect(both).toBeLessThan(only);
  });

  test("a miss shows its path, line, title and description", () => {
    expect(markdown).toContain("src/missed.ts:42");
    expect(markdown).toContain("Missed entirely");
    expect(markdown).toContain(
      "Nothing on the pr-hero side is near this line.",
    );
  });

  test("a pair prints both claims so a human can reject the match", () => {
    // The whole safety valve for location-only matching.
    expect(markdown).toContain("The derived value is never invalidated.");
    expect(markdown).toContain("Cached list survives the mutation.");
    expect(markdown).toContain("src/a.ts:100-104");
  });

  test("a pr-hero-only finding shows its id, tier, location and claim", () => {
    expect(markdown).toContain("F007");
    expect(markdown).toContain("src/solo.ts:12");
    expect(markdown).toContain("advisory");
    expect(markdown).toContain("Only pr-hero saw this.");
  });

  test("renders empty buckets without crashing and states so", () => {
    const empty = renderComparison(1, compareFindings([], []));
    expect(empty).toContain("Greptile-only: 0");
    expect(empty).toContain("_No location overlap");
    // A silent Greptile must never read as "pr-hero caught everything".
    expect(empty).toContain("Greptile reported no findings on this PR");
    expect(empty).not.toContain("pr-hero located every finding");
  });

  test("zero misses WITH agreements reads as a match, not as silence", () => {
    const matched = renderComparison(
      2,
      compareFindings([prhero()], [greptile()]),
    );
    expect(matched).toContain("_None — pr-hero located every finding");
    expect(matched).not.toContain("Greptile reported no findings");
  });

  test("is byte-identical on repeat — no clock, no randomness", () => {
    expect(renderComparison(1677, result)).toBe(markdown);
  });
});

// Two very different facts land in the same empty bucket, and they must not
// read alike: pr-hero agreeing with Greptile on everything it said, versus
// pr-hero having said nothing at all. The second is silence, and a benchmark
// that renders silence as agreement flatters the engine.
describe("empty pr-hero bucket", () => {
  test("silence is not reported as agreement", () => {
    const silent = renderComparison(1, {
      both: [],
      greptileOnly: [],
      prheroOnly: [],
    });
    expect(silent).toContain("silence, not agreement");
    expect(silent).not.toContain("every pr-hero finding overlapped");
  });
});
