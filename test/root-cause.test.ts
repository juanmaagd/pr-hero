import { describe, expect, test } from "bun:test";
import {
  clusterByRootCause,
  extractAnchor,
  type RootCauseInput,
  rootCauseIdByFinding,
} from "../src/root-cause";

function f(id: string, ...proof_refs: string[]): RootCauseInput {
  return { id, proof_refs };
}

// The real artifact this slice was designed against: six category-12 findings
// at six different call sites, every one of them citing the same producer
// location first, with different prose after the location token.
const DURATION = "packages/backend/src/Domain/ProjectSongDuration.ts:19-20";

describe("extractAnchor", () => {
  test("takes the location token up to the first whitespace", () => {
    expect(
      extractAnchor([`${DURATION} (fromSeconds stores raw seconds)`]),
    ).toBe(DURATION);
  });

  test("a ref with no whitespace at all is the whole anchor", () => {
    expect(extractAnchor(["src/app.ts:42"])).toBe("src/app.ts:42");
  });

  test("leading and trailing whitespace is trimmed", () => {
    expect(extractAnchor(["   src/app.ts:42   "])).toBe("src/app.ts:42");
  });

  test("empty proof_refs has no anchor", () => {
    expect(extractAnchor([])).toBeNull();
  });

  test("a whitespace-only ref has no anchor", () => {
    expect(extractAnchor(["   "])).toBeNull();
  });

  test("only the FIRST ref is consulted", () => {
    expect(extractAnchor(["src/a.ts:1", "src/b.ts:2"])).toBe("src/a.ts:1");
  });

  // Observed in a real artifact (run 571, F001): the hunter wrote
  // `WaveformWithTime.tsx: 12,36-38 (...)`, and cutting the prose left a bare
  // `WaveformWithTime.tsx:`. That is a file-level anchor, and file-level
  // anchors weld together every finding that shares a file.
  test("a space after the colon degenerates to file level and has no anchor", () => {
    expect(
      extractAnchor(["src/app.ts: 12,36-38 (durationSec is SECONDS)"]),
    ).toBeNull();
    expect(extractAnchor(["src/app.ts: 12-14 (prose)"])).toBeNull();
  });

  test("a bare path with no colon has no anchor", () => {
    expect(extractAnchor(["src/app.ts (whole file is wrong)"])).toBeNull();
  });

  test("a path:symbol anchor is specific and survives", () => {
    expect(extractAnchor(["src/store.ts:handleMount (arms the latch)"])).toBe(
      "src/store.ts:handleMount",
    );
  });
});

describe("clustering the fan-out case", () => {
  test("shared first anchor with differing prose is ONE cluster", () => {
    const summary = clusterByRootCause([
      f("F001", `${DURATION} (fromSeconds stores raw seconds)`),
      f("F002", `${DURATION} (constructor bypasses the scale)`),
      f("F003", `${DURATION} (value is never divided by 1000)`),
    ]);
    expect(summary.clusters).toHaveLength(1);
    expect(summary.clusters[0]?.id).toBe("RC001");
    expect(summary.clusters[0]?.anchor).toBe(DURATION);
    expect(summary.clusters[0]?.finding_ids).toEqual(["F001", "F002", "F003"]);
    expect(summary.distinct_root_causes).toBe(1);
  });

  test("consumer paths differing does not split a shared root cause", () => {
    const summary = clusterByRootCause([
      f("F001", `${DURATION} producer`, "packages/api/a.ts:10 consumer"),
      f("F002", `${DURATION} producer`, "packages/web/b.ts:20 consumer"),
    ]);
    expect(summary.distinct_root_causes).toBe(1);
  });
});

describe("anti-over-cluster rules", () => {
  // The whole reason this is first-anchor and not a union-find: a shared
  // formatting helper cited second by both findings must NOT weld two
  // unrelated defects into one root cause.
  test("different first anchors sharing a LATER ref stay separate", () => {
    const summary = clusterByRootCause([
      f("F001", "src/a.ts:10 producer", "src/format.ts:5 shared helper"),
      f("F002", "src/b.ts:20 producer", "src/format.ts:5 shared helper"),
    ]);
    expect(summary.distinct_root_causes).toBe(2);
    expect(summary.clusters.map((c) => c.anchor)).toEqual([
      "src/a.ts:10",
      "src/b.ts:20",
    ]);
  });

  test("no line-range normalization: foo.ts:19 and foo.ts:19-20 differ", () => {
    const summary = clusterByRootCause([
      f("F001", "src/foo.ts:19 first"),
      f("F002", "src/foo.ts:19-20 second"),
    ]);
    expect(summary.distinct_root_causes).toBe(2);
  });

  // The failure mode `dedupe.ts` pass 2 already refuses by construction: two
  // unrelated defects in one file must never become one root cause just
  // because both citations degenerated to the file.
  test("two file-level anchors in the same file never merge", () => {
    const a = f("F1", "src/app.ts: 10 (stale cache)");
    const b = f("F2", "src/app.ts: 90 (unrelated race)");
    const summary = clusterByRootCause([a, b]);
    expect(summary.distinct_root_causes).toBe(2);
    expect(summary.clusters.map((c) => c.anchor)).toEqual([null, null]);
  });

  test("no case folding: Foo.ts and foo.ts differ", () => {
    const summary = clusterByRootCause([
      f("F001", "src/Foo.ts:1"),
      f("F002", "src/foo.ts:1"),
    ]);
    expect(summary.distinct_root_causes).toBe(2);
  });
});

describe("anchorless findings", () => {
  test("an empty proof_refs finding is its own singleton with a null anchor", () => {
    const summary = clusterByRootCause([f("F001")]);
    expect(summary.clusters).toEqual([
      { id: "RC001", anchor: null, finding_ids: ["F001"] },
    ]);
  });

  test("two anchorless findings never merge with each other", () => {
    const summary = clusterByRootCause([f("F001"), f("F002")]);
    expect(summary.distinct_root_causes).toBe(2);
    expect(summary.clusters.map((c) => c.finding_ids)).toEqual([
      ["F001"],
      ["F002"],
    ]);
    for (const cluster of summary.clusters) {
      expect(cluster.anchor).toBeNull();
    }
  });

  test("an anchorless finding never joins an anchored cluster", () => {
    const summary = clusterByRootCause([
      f("F001", "src/a.ts:1 x"),
      f("F002"),
      f("F003", "src/a.ts:1 y"),
    ]);
    expect(summary.distinct_root_causes).toBe(2);
    expect(summary.clusters[0]?.finding_ids).toEqual(["F001", "F003"]);
    expect(summary.clusters[1]?.finding_ids).toEqual(["F002"]);
  });
});

describe("ids, totals and determinism", () => {
  test("cluster ids follow first-appearance order over the input array", () => {
    const summary = clusterByRootCause([
      f("F001", "src/a.ts:1 x"),
      f("F002", "src/b.ts:2 y"),
      f("F003", "src/a.ts:1 z"),
      f("F004", "src/c.ts:3 w"),
    ]);
    expect(summary.clusters.map((c) => [c.id, c.anchor])).toEqual([
      ["RC001", "src/a.ts:1"],
      ["RC002", "src/b.ts:2"],
      ["RC003", "src/c.ts:3"],
    ]);
    // A cluster keeps the position where it FIRST appeared even though it
    // finished filling up later.
    expect(summary.clusters[0]?.finding_ids).toEqual(["F001", "F003"]);
  });

  test("clusters partition the input: every finding appears exactly once", () => {
    const input = [
      f("F001", "src/a.ts:1 x"),
      f("F002"),
      f("F003", "src/a.ts:1 y"),
      f("F004", "src/b.ts:2 z"),
    ];
    const summary = clusterByRootCause(input);
    const placed = summary.clusters.flatMap((c) => c.finding_ids);
    expect(placed.sort()).toEqual(input.map((i) => i.id).sort());
    expect(placed.length).toBe(input.length);
  });

  test("distinct_root_causes always equals clusters.length", () => {
    const summary = clusterByRootCause([
      f("F001", "src/a.ts:1 x"),
      f("F002", "src/b.ts:2 y"),
      f("F003", "src/b.ts:2 z"),
    ]);
    expect(summary.distinct_root_causes).toBe(summary.clusters.length);
  });

  test("empty input yields no clusters", () => {
    expect(clusterByRootCause([])).toEqual({
      clusters: [],
      distinct_root_causes: 0,
    });
  });

  test("same input always produces the same output", () => {
    const input = [
      f("F001", `${DURATION} a`),
      f("F002"),
      f("F003", `${DURATION} b`),
      f("F004", "src/other.ts:7 c"),
    ];
    expect(clusterByRootCause(input)).toEqual(clusterByRootCause(input));
  });
});

describe("rootCauseIdByFinding", () => {
  test("maps every finding id to its cluster id", () => {
    const summary = clusterByRootCause([
      f("F001", "src/a.ts:1 x"),
      f("F002", "src/b.ts:2 y"),
      f("F003", "src/a.ts:1 z"),
      f("F004"),
    ]);
    const byFinding = rootCauseIdByFinding(summary);
    expect(byFinding.size).toBe(4);
    expect(byFinding.get("F001")).toBe("RC001");
    expect(byFinding.get("F002")).toBe("RC002");
    expect(byFinding.get("F003")).toBe("RC001");
    expect(byFinding.get("F004")).toBe("RC003");
  });

  test("an empty summary maps nothing", () => {
    expect(rootCauseIdByFinding(clusterByRootCause([])).size).toBe(0);
  });
});
