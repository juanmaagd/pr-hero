import { describe, expect, test } from "bun:test";
import { FINDING_LINE_WINDOW } from "../src/inline";
import {
  findingsMatch,
  formatLocs,
  IDENTITY_LINE_WINDOW,
  identityFromFinding,
  identityFromLocs,
  parseProofRefLocs,
} from "../src/rereview-identity";

// Transcribed from the on-disk pair that decided D1
// (`docs/item7-rereview-design.md` §0.6):
// ~/.prhero/repos/github.com/musivetech/musive/runs/pr-1759-8da9fad5-{2,3}
const RUN2_F001 = {
  path: "packages/app/hooks/publicLinks/useRetrivePublicLinks.ts",
  line: 36,
  proof_refs: [
    "packages/app/hooks/publicLinks/useRetrivePublicLinks.ts:36-41 (error branch returns without setLibraryProjects)",
    "packages/app/pages/publicLinks/index.tsx:64,78-90 (isLoading = !libraryProjects gates both skeletons with no other disarm path)",
  ],
};
const RUN2_F002 = {
  path: "packages/web/src/views/PublicLinks/index.tsx",
  line: 81,
  proof_refs: [
    "packages/web/src/views/PublicLinks/index.tsx:81-84 (error branch returns without setLibraryProjects)",
    "packages/web/src/views/PublicLinks/index.tsx:99,122-125 (isLoading = !libraryProjects gates LoadingWrapper with no other disarm path)",
  ],
};
const RUN3_F001 = {
  path: "packages/web/src/views/PublicLinks/index.tsx",
  line: 99,
  proof_refs: [
    "packages/web/src/views/PublicLinks/index.tsx:99 (arm: isLoading = !libraryProjects)",
    "packages/web/src/views/PublicLinks/index.tsx:81-86 (error branch returns at :83 without calling setLibraryProjects; the only disarm, setLibraryProjects at :86, is success-only)",
  ],
};
const RUN3_F002 = {
  path: "packages/app/pages/publicLinks/index.tsx",
  line: 64,
  proof_refs: [
    "packages/app/pages/publicLinks/index.tsx:64 (arm: isLoading = !libraryProjects)",
    "packages/app/hooks/publicLinks/useRetrivePublicLinks.ts:36-44 (error branch returns at :41 without calling setLibraryProjects; the only disarm, setLibraryProjects at :44, is success-only)",
  ],
};

describe("IDENTITY_LINE_WINDOW", () => {
  test("is FINDING_LINE_WINDOW — one number, two names", () => {
    expect(IDENTITY_LINE_WINDOW).toBe(FINDING_LINE_WINDOW);
  });
});

describe("parseProofRefLocs", () => {
  test("takes a single line and a range, dropping the prose", () => {
    expect(
      parseProofRefLocs("src/app.ts:36-41 (error branch returns)"),
    ).toEqual([{ path: "src/app.ts", span: { start: 36, end: 41 } }]);
    expect(parseProofRefLocs("src/app.ts:64 (arm)")).toEqual([
      { path: "src/app.ts", span: { start: 64, end: 64 } },
    ]);
  });

  test("splits comma-separated specs on the same path (PR 1759 shape)", () => {
    expect(parseProofRefLocs("src/view.tsx:64,78-90 (gates both)")).toEqual([
      { path: "src/view.tsx", span: { start: 64, end: 64 } },
      { path: "src/view.tsx", span: { start: 78, end: 90 } },
    ]);
  });

  test("drops non-path:line refs instead of guessing (S10)", () => {
    expect(parseProofRefLocs("diff-hunk#1")).toEqual([]);
    expect(parseProofRefLocs("src/app.ts:handleFetch")).toEqual([]);
    expect(
      parseProofRefLocs("src/app.ts: 12,36-38 (space after colon)"),
    ).toEqual([]);
  });

  test("drops a leading ./ the same way compare.normalizePath does", () => {
    expect(parseProofRefLocs("./src/app.ts:12")).toEqual([
      { path: "src/app.ts", span: { start: 12, end: 12 } },
    ]);
  });
});

describe("D5c — PR 1759 pair and the over-match table", () => {
  test("defect A: run-2 F001 matches run-3 F002 (equal 2-set, spans overlap)", () => {
    expect(findingsMatch(RUN2_F001, RUN3_F002)).toBe(true);
  });

  test("defect B: run-2 F002 matches run-3 F001 (equal 1-set, spans overlap)", () => {
    expect(findingsMatch(RUN2_F002, RUN3_F001)).toBe(true);
  });

  test("does not over-merge the two defects (disjoint paths)", () => {
    expect(findingsMatch(RUN2_F001, RUN3_F001)).toBe(false);
    expect(findingsMatch(RUN2_F002, RUN3_F002)).toBe(false);
  });

  test("incidental shared helper does not match", () => {
    expect(
      findingsMatch(
        {
          path: "a.ts",
          line: 1,
          proof_refs: ["a.ts:1", "util.ts:10"],
        },
        {
          path: "b.ts",
          line: 2,
          proof_refs: ["b.ts:2", "util.ts:10"],
        },
      ),
    ).toBe(false);
  });

  test("single-path vs multi-path is not a match, even with a shared file", () => {
    expect(
      findingsMatch(
        { path: "util.ts", line: 14, proof_refs: ["util.ts:14"] },
        {
          path: "a.ts",
          line: 1,
          proof_refs: ["a.ts:1", "util.ts:12"],
        },
      ),
    ).toBe(false);
  });

  test("same file, spans outside the window, do not match (R2-C3-A)", () => {
    expect(
      findingsMatch(
        { path: "util.ts", line: 14, proof_refs: ["util.ts:14"] },
        { path: "util.ts", line: 50, proof_refs: ["util.ts:50"] },
      ),
    ).toBe(false);
  });

  test("the window boundary is exact: window itself matches, window+1 does not", () => {
    expect(
      findingsMatch(
        { path: "util.ts", line: 10, proof_refs: ["util.ts:10"] },
        { path: "util.ts", line: 10 + IDENTITY_LINE_WINDOW, proof_refs: [] },
      ),
    ).toBe(true);
    expect(
      findingsMatch(
        { path: "util.ts", line: 10, proof_refs: ["util.ts:10"] },
        {
          path: "util.ts",
          line: 10 + IDENTITY_LINE_WINDOW + 1,
          proof_refs: [],
        },
      ),
    ).toBe(false);
  });
});

describe("S10 — invalid refs drop; anchor remains", () => {
  test("a finding whose proof_refs are all non-locations still identities on path:line", () => {
    const identity = identityFromFinding({
      path: "src/app.ts",
      line: 12,
      proof_refs: ["diff-hunk#1", "not-a-location"],
    });
    expect(formatLocs(identity)).toEqual(["src/app.ts:12"]);
  });
});

describe("formatLocs / identityFromLocs", () => {
  test("round-trips the PR 1759 defect A locs without the prose", () => {
    const identity = identityFromFinding(RUN2_F001);
    const locs = formatLocs(identity);
    expect(identityFromLocs(locs)).toEqual(identity);
  });
});
