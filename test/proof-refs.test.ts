import { describe, expect, test } from "bun:test";
import {
  pathsNamedInDiff,
  proofRefPathClaim,
  unresolvedProofRefs,
} from "../src/proof-refs";

describe("proofRefPathClaim", () => {
  test("reads the path off every shape the prompts mandate", () => {
    expect(proofRefPathClaim("src/a.ts")).toEqual(["src/a.ts"]);
    expect(proofRefPathClaim("src/a.ts:12")).toEqual(["src/a.ts"]);
    expect(proofRefPathClaim("src/a.ts:12-20")).toEqual(["src/a.ts"]);
    expect(proofRefPathClaim("  src/a.ts:12  ")).toEqual(["src/a.ts"]);
    expect(proofRefPathClaim("./src/a.ts:12")).toEqual(["src/a.ts"]);
    expect(proofRefPathClaim("src/a.ts:12 (the guard)")).toEqual(["src/a.ts"]);
  });

  test("a bare filename counts as a claim through its line number", () => {
    // No slash and no dot, so only the `:12` makes this a citation rather
    // than a word — without that trigger it would be an easy way to smuggle
    // an unresolvable ref past the rule.
    expect(proofRefPathClaim("Makefile:12")).toEqual(["Makefile"]);
    expect(proofRefPathClaim("package.json:15-20")).toEqual(["package.json"]);
  });

  test("offers BOTH spellings of a git-prefixed ref, never just the stripped one", () => {
    // `a/` and `b/` are git diff notation a model copies out of the patch —
    // but `a/` is also a legal directory name. Returning both spellings means
    // the resolver decides from the tree instead of this parser guessing, so
    // a repo with a real top-level `a/` cannot be rejected for spelling.
    expect(proofRefPathClaim("b/src/a.ts:9")).toEqual([
      "b/src/a.ts",
      "src/a.ts",
    ]);
    expect(proofRefPathClaim("a/src/a.ts")).toEqual(["a/src/a.ts", "src/a.ts"]);
  });

  test("ABSTAINS on a ref that asserts no repo path", () => {
    // The distinction the failed fixture eval paid for: unverifiable is not
    // false. Everything here is left unjudged rather than called fabrication.
    expect(proofRefPathClaim("")).toBeUndefined();
    expect(proofRefPathClaim("   ")).toBeUndefined();
    expect(proofRefPathClaim(":12")).toBeUndefined();
    // A quoted gotcha — the exact ref that destroyed a correct finding and
    // both hunters on the first live run under the strict rule.
    expect(
      proofRefPathClaim(
        "gotcha: Volume values are 0-1 gain fractions everywhere in this codebase",
      ),
    ).toBeUndefined();
    // Prose that NAMES a file without claiming to be a citation of one.
    expect(
      proofRefPathClaim("the guard in src/player.ts is missing"),
    ).toBeUndefined();
    // A hunk label, not a path.
    expect(proofRefPathClaim("diff-hunk#1")).toBeUndefined();
  });

  test("ABSTAINS on paths outside the tree instead of accusing them", () => {
    // "Does the reviewed tree contain this" has no answer for a path outside
    // it, and the resolver must never be handed one. An absolute path to a
    // file that really exists is a spelling problem, not a lie.
    expect(proofRefPathClaim("/etc/passwd")).toBeUndefined();
    expect(proofRefPathClaim("~/secrets.txt")).toBeUndefined();
    expect(proofRefPathClaim("../outside.ts:3")).toBeUndefined();
    expect(proofRefPathClaim("src/../../outside.ts")).toBeUndefined();
  });
});

describe("pathsNamedInDiff", () => {
  const patch = [
    "diff --git a/src/kept.ts b/src/kept.ts",
    "--- a/src/kept.ts",
    "+++ b/src/kept.ts",
    "@@ -1,2 +1,3 @@",
    " ok",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 98%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "",
  ].join("\n");

  test("names both sides, so a deleted or renamed-from file stays citable", () => {
    // The reviewed target is the worktree AND the patch. A file the PR deletes
    // no longer exists on disk, yet a hunter reads it in the diff and can cite
    // it honestly — rejecting that would be a false accusation of fabrication.
    const named = pathsNamedInDiff(patch);
    expect([...named].sort()).toEqual([
      "src/gone.ts",
      "src/kept.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
  });

  test("never names /dev/null", () => {
    expect(pathsNamedInDiff(patch).has("/dev/null")).toBe(false);
  });

  test("is empty for an empty patch", () => {
    expect(pathsNamedInDiff("").size).toBe(0);
  });
});

describe("unresolvedProofRefs", () => {
  const tree = new Set(["src/a.ts", "src/b.ts", "a/legit.ts"]);
  const resolves = (p: string): boolean => tree.has(p);

  test("an empty evidence list is not an unresolved one", () => {
    expect(unresolvedProofRefs([], resolves)).toEqual([]);
  });

  test("passes refs whose path exists in the tree", () => {
    expect(
      unresolvedProofRefs(["src/a.ts:12", "b/src/b.ts:3-9"], resolves),
    ).toEqual([]);
  });

  test("passes a real top-level a/ directory on its unstripped spelling", () => {
    expect(unresolvedProofRefs(["a/legit.ts:4"], resolves)).toEqual([]);
  });

  test("returns the ORIGINAL ref text for every path the tree does not have", () => {
    // The original text, not the parsed path: the error message has to quote
    // back exactly what the model wrote, or a reader cannot tell which of its
    // citations was the invented one.
    expect(
      unresolvedProofRefs(
        ["src/a.ts:12", "src/index.ts:7-20", "package.json:15-20"],
        resolves,
      ),
    ).toEqual(["src/index.ts:7-20", "package.json:15-20"]);
  });

  test("REGRESSION — a real finding cited alongside a gotcha survives", () => {
    // The live draft the strict rule destroyed, verbatim in shape: four sound
    // citations plus one quoted gotcha. Rejecting this cost a correct BLOCKER
    // and both hunters of that run.
    expect(
      unresolvedProofRefs(
        [
          "src/a.ts:6",
          "src/a.ts:8",
          "src/b.ts:10",
          "src/b.ts:4",
          "gotcha: Volume values are 0-1 gain fractions everywhere in this codebase",
        ],
        resolves,
      ),
    ).toEqual([]);
  });

  test("a ref that asserts nothing is never judged, in either direction", () => {
    expect(
      unresolvedProofRefs(
        ["", "/etc/passwd", "../x.ts", "diff-hunk#1"],
        resolves,
      ),
    ).toEqual([]);
  });
});
