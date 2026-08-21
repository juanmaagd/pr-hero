import { describe, expect, test } from "bun:test";
import {
  decideRereviewCase,
  planDiscovery,
  resolveLastReviewedHead,
  restrictedDiscoveryFiles,
} from "../src/rereview-plan";

const L = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "cccccccccccccccccccccccccccccccccccccccc";

describe("resolveLastReviewedHead — S-A", () => {
  test("the summary marker wins over finding-marker heads", () => {
    expect(
      resolveLastReviewedHead({
        summaryHead: L,
        findingMarkers: [{ headSha: OTHER, createdAt: "2026-08-21T00:00:00Z" }],
      }),
    ).toEqual({ L, source: "summary_marker" });
  });

  test("with the summary gone, L is the latest finding-marker created_at", () => {
    expect(
      resolveLastReviewedHead({
        summaryHead: null,
        findingMarkers: [
          { headSha: OTHER, createdAt: "2026-08-20T00:00:00Z" },
          { headSha: L, createdAt: "2026-08-21T00:00:00Z" },
        ],
      }),
    ).toEqual({ L, source: "finding_markers" });
  });

  test("no summary and no markers is case-A absent, not a guessed head", () => {
    expect(
      resolveLastReviewedHead({ summaryHead: null, findingMarkers: [] }),
    ).toEqual({ L: null, source: "absent" });
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
    const plan = planDiscovery({ case: "A", full: false });
    expect(plan).toMatchObject({
      discovery: "full",
      emptyDeltaIsError: true,
      skipDiscovery: false,
      verifyAll: false,
    });
  });

  test("S-empty — a re-review empty delta is not an error", () => {
    expect(planDiscovery({ case: "B", full: false }).emptyDeltaIsError).toBe(
      false,
    );
    expect(planDiscovery({ case: "C", full: false }).emptyDeltaIsError).toBe(
      false,
    );
    expect(planDiscovery({ case: "C", full: false }).discovery).toBe(
      "restricted",
    );
  });

  test("case B without --full skips discovery", () => {
    expect(planDiscovery({ case: "B", full: false })).toMatchObject({
      discovery: "none",
      skipDiscovery: true,
      discoveryRestricted: true,
    });
  });

  test("--full widens discovery and records the REAL case (R2-C5)", () => {
    const b = planDiscovery({ case: "B", full: true });
    expect(b.case).toBe("B");
    expect(b.discovery).toBe("full");
    expect(b.discoveryRestricted).toBe(false);
    expect(b.skipDiscovery).toBe(false);
    expect(b.verifyAll).toBe(false);

    const c = planDiscovery({ case: "C", full: true });
    expect(c.case).toBe("C");
    expect(c.discoveryRestricted).toBe(false);
    expect(c.verifyAll).toBe(false);

    const d = planDiscovery({ case: "D", full: true });
    expect(d.case).toBe("D");
    expect(d.verifyAll).toBe(true);
  });

  test("D and E verify-all on a full B..H range", () => {
    expect(planDiscovery({ case: "D", full: false })).toMatchObject({
      discovery: "full",
      verifyAll: true,
      emptyDeltaIsError: false,
    });
    expect(planDiscovery({ case: "E", full: false }).verifyAll).toBe(true);
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
