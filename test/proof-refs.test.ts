import { describe, expect, test } from "bun:test";
import {
  pathsNamedInDiff,
  proofRefCandidates,
  unresolvedProofRefs,
} from "../src/proof-refs";

describe("proofRefCandidates", () => {
  test("reads the path off every shape the prompts mandate", () => {
    expect(proofRefCandidates("src/a.ts")).toEqual(["src/a.ts"]);
    expect(proofRefCandidates("src/a.ts:12")).toEqual(["src/a.ts"]);
    expect(proofRefCandidates("src/a.ts:12-20")).toEqual(["src/a.ts"]);
    expect(proofRefCandidates("  src/a.ts:12  ")).toEqual(["src/a.ts"]);
    expect(proofRefCandidates("./src/a.ts:12")).toEqual(["src/a.ts"]);
    expect(proofRefCandidates("src/a.ts:12 (the guard)")).toEqual(["src/a.ts"]);
  });

  test("offers BOTH spellings of a git-prefixed ref, never just the stripped one", () => {
    // `a/` and `b/` are git diff notation a model copies out of the patch —
    // but `a/` is also a legal directory name. Returning both spellings means
    // the resolver decides from the tree instead of this parser guessing, so
    // a repo with a real top-level `a/` cannot be rejected for spelling.
    expect(proofRefCandidates("b/src/a.ts:9")).toEqual([
      "b/src/a.ts",
      "src/a.ts",
    ]);
    expect(proofRefCandidates("a/src/a.ts")).toEqual([
      "a/src/a.ts",
      "src/a.ts",
    ]);
  });

  test("offers nothing for a ref that names no path inside the tree", () => {
    expect(proofRefCandidates("")).toEqual([]);
    expect(proofRefCandidates("   ")).toEqual([]);
    expect(proofRefCandidates(":12")).toEqual([]);
    // Absolute and escaping refs are unresolvable BY DEFINITION here: the
    // question this module answers is "does the reviewed tree contain this",
    // and neither spelling is a path inside it.
    expect(proofRefCandidates("/etc/passwd")).toEqual([]);
    expect(proofRefCandidates("~/secrets.txt")).toEqual([]);
    expect(proofRefCandidates("../outside.ts:3")).toEqual([]);
    expect(proofRefCandidates("src/../../outside.ts")).toEqual([]);
  });

  test("treats prose as a path candidate, leaving the verdict to the tree", () => {
    // Not this module's call: prose that happens to name a real file must
    // still resolve, and prose that names nothing fails at the resolver.
    expect(proofRefCandidates("diff-hunk#1")).toEqual(["diff-hunk#1"]);
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

  test("an unusable ref is unresolved, never silently skipped", () => {
    expect(
      unresolvedProofRefs(["", "/etc/passwd", "../x.ts"], resolves),
    ).toEqual(["", "/etc/passwd", "../x.ts"]);
  });
});
