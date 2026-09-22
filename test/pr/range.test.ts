import { describe, expect, test } from "bun:test";
import type { GitRunner } from "#git/git";
import { resolveBaseRefIgnore, resolveEagerLocalIgnore } from "#pr/range";
import { parseIgnoreFile } from "../../src/ignore-file";
import type { IgnoreFileReadResult } from "../../src/ignore-read";

const OPERATOR_RULES: IgnoreFileReadResult = {
  rules: parseIgnoreFile("operator-only.txt\n", "user"),
  found: true,
};
const OTHER_ROOT_RULES: IgnoreFileReadResult = {
  rules: parseIgnoreFile("wrong-root.txt\n", "user"),
  found: true,
};

// Invariant 7 (O-8): the eager, non-CI `.prheroignore` read must come from
// the OPERATOR root, never any other root (in production, `worktreePath` —
// which does not even exist yet at this point in reviewPr()). `readLocal` is
// the injected system boundary; keying its response by root proves the
// OUTCOME (which rules came back), not merely that some symbol was called.
describe("resolveEagerLocalIgnore — O-8", () => {
  test("under CI, no read happens at all and the result is undefined", async () => {
    const result = await resolveEagerLocalIgnore({
      isCi: true,
      operatorRoot: "/operator",
      readLocal: () => Promise.reject(new Error("must not be called under CI")),
    });
    expect(result).toBeUndefined();
  });

  test("outside CI, the rules returned are the ones scoped to the operator root", async () => {
    const readLocal = (root: string): Promise<IgnoreFileReadResult> =>
      Promise.resolve(root === "/operator" ? OPERATOR_RULES : OTHER_ROOT_RULES);
    const result = await resolveEagerLocalIgnore({
      isCi: false,
      operatorRoot: "/operator",
      readLocal,
    });
    expect(result).toEqual(OPERATOR_RULES);
  });
});

function fakeGit(
  script: (
    args: string[],
  ) => { ok: boolean; stdout?: string; stderr?: string } | null,
): GitRunner {
  return async (repo, args) => {
    const scripted = script(args);
    if (scripted === null) {
      throw new Error(`unscripted git call: ${repo} ${args.join(" ")}`);
    }
    return {
      ok: scripted.ok,
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
    };
  };
}

// Invariant 8 (design D1): CI must read `.prheroignore` at the RESOLVED base
// sha, never `target.baseRef`/`baseRefName` directly (a merged PR's baseRef
// is a `<sha>^1` EXPRESSION, not a valid ls-tree argument). The fake only
// answers `ls-tree` for the exact resolved sha, mirroring
// test/git/git.test.ts's own pattern for readBaseRefIgnoreRules — passing
// the raw expression instead of the resolved sha reads as "absent" here,
// exactly as it would against a real repository.
describe("resolveBaseRefIgnore — design D1", () => {
  const RESOLVED_SHA = "a".repeat(40);
  const UNRESOLVED_EXPRESSION = `${"b".repeat(40)}^1`;

  test("under CI, rules come from the git adapter at the resolved base sha", async () => {
    const runGit = fakeGit((args) =>
      args[0] === "ls-tree" && args.includes(RESOLVED_SHA)
        ? {
            ok: true,
            stdout:
              "100644 blob c000000000000000000000000000000000000000\t.prheroignore",
          }
        : args[0] === "cat-file"
          ? { ok: true, stdout: "dist/**\n" }
          : { ok: true, stdout: "" },
    );
    const result = await resolveBaseRefIgnore({
      isCi: true,
      localIgnore: undefined,
      runGit,
      gitDirOwner: "/gitdir",
      baseSha: RESOLVED_SHA,
    });
    expect(result.found).toBe(true);
  });

  // The falsifiable case for the invariant: if the call site regressed to
  // pass the raw `<sha>^1` EXPRESSION instead of the resolved sha, the same
  // fake (which only answers for RESOLVED_SHA) reads it as absent — this is
  // exactly the outcome that would silently defeat design D1.
  test("a raw baseRef expression in place of the resolved sha reads as absent, not the real rules", async () => {
    const runGit = fakeGit((args) =>
      args[0] === "ls-tree" && args.includes(RESOLVED_SHA)
        ? {
            ok: true,
            stdout:
              "100644 blob c000000000000000000000000000000000000000\t.prheroignore",
          }
        : args[0] === "ls-tree"
          ? { ok: true, stdout: "" }
          : { ok: true, stdout: "" },
    );
    const result = await resolveBaseRefIgnore({
      isCi: true,
      localIgnore: undefined,
      runGit,
      gitDirOwner: "/gitdir",
      baseSha: UNRESOLVED_EXPRESSION,
    });
    expect(result.found).toBe(false);
  });

  test("outside CI, the eager local read is reused rather than fetched again", async () => {
    const runGit = fakeGit(() => {
      throw new Error("must not be called outside CI");
    });
    const result = await resolveBaseRefIgnore({
      isCi: false,
      localIgnore: OPERATOR_RULES,
      runGit,
      gitDirOwner: "/gitdir",
      baseSha: RESOLVED_SHA,
    });
    expect(result).toEqual(OPERATOR_RULES);
  });
});

// resolvePrFetchAndRange itself (fetchPrRefs + two resolveCommit calls +
// resolveDiffFrom) is a genuine I/O shell with no injectable seam of its
// own — same limitation as ci-admission-gate.ts's `gh`-backed fetches — so
// the one thing resolveBaseRefIgnore's own tests above cannot prove is that
// THIS caller actually hands it the RESOLVED `baseSha` it just computed,
// rather than the raw `target.baseRef` sitting right next to it in scope. A
// narrow structural check for that one wiring fact, same class as the
// CI-admission marker-fields check in test/cli.test.ts.
describe("resolvePrFetchAndRange's own wiring", () => {
  test("hands resolveBaseRefIgnore the resolved baseSha, never target.baseRef", async () => {
    const source = await Bun.file(
      new URL("../../src/pr/range.ts", import.meta.url),
    ).text();
    const callStart = source.indexOf("resolveBaseRefIgnore({");
    const call = source.slice(callStart, source.indexOf("});", callStart));
    expect(call).toContain("baseSha,");
    expect(call).not.toContain("baseSha: params.target.baseRef");
  });
});
