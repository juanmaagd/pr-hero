// Differential test (PR1b Addition 3): our `.prheroignore` dialect is a
// SUBSET of git's own gitignore(5), and a user will assume full
// compatibility unless something proves otherwise. This runs a fixed table
// of patterns through REAL `git check-ignore` in a disposable scratch repo
// and compares the verdict against `compileIgnoreRules(parseIgnoreFile(...))`
// — the same layer test/ignore-file.test.ts's `excludes()` helper probes,
// never bare Bun.Glob (an isolated primitive can disagree with the actual
// translation pipeline; see the session lesson this repo already paid for).
//
// This is the first test in this repo to spawn a real `git` subprocess for
// assertions rather than fixture setup; `ci.yml` runs via `actions/checkout`,
// which guarantees git is present, so this is safe in CI as it is locally.
//
// `core.ignorecase=false` is set explicitly on the scratch repo: APFS (this
// machine) and most default git installs auto-detect a case-insensitive
// filesystem and set `core.ignorecase=true`, which `check-ignore` honors —
// without pinning it off, `*.MD` vs `a.md` would report "ignored" from git
// while our matcher (deliberately case-sensitive, see ignore-file.ts's own
// WHY comment) says "not ignored", a FALSE divergence from a filesystem
// default, not a real dialect difference. Git is case-sensitive for a
// case-sensitive tree; this test pins that tree, not the host filesystem.
//
// One row is EXCLUDED from the comparison loop, by name: re-inclusion under
// an excluded parent directory. gitignore(5) is explicit that git cannot do
// this ("It is not possible to re-include a file if a parent directory of
// that file is excluded... Git doesn't list excluded directories for
// performance reasons, so any patterns on contained files have no effect,
// no matter where they are defined."); this engine matches a finite diff
// file list, not a tree walk, so it can and does re-include. That row is
// asserted explicitly on BOTH sides instead of silently passing or being
// dropped — the point is to document the exact deviation, not to hide it.
//
// If a row here ever disagrees UNEXPECTEDLY, that is this test doing its
// job: stop and report the divergence rather than bending either side to
// match it.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileIgnoreRules, parseIgnoreFile } from "../src/ignore-file";

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

// Exit 0 = ignored, 1 = not ignored. Exit 128 means the HARNESS is broken
// (bad revision, no path, etc.) — that is a test-authoring bug, not a
// "not ignored" answer, so it fails loudly rather than being coerced into
// a boolean.
async function gitCheckIgnore(cwd: string, target: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "-C", cwd, "check-ignore", "-q", "--no-index", "--", target],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0 && exitCode !== 1) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `git check-ignore harness broken for ${JSON.stringify(target)}: ` +
        `exit ${exitCode} — ${stderr}`,
    );
  }
  return exitCode === 0;
}

function ours(patterns: string[], path_: string): boolean {
  const rules = parseIgnoreFile(patterns.join("\n"), "user");
  return compileIgnoreRules(rules).match(path_) !== undefined;
}

// What to create on disk before asking git — trailing-slash patterns need a
// REAL directory (or REAL file) present, or `--no-index` cannot tell a
// would-be directory from a nonexistent path and silently answers "not a
// directory" either way, which would make the row pass for the wrong
// reason.
type Entry = { path: string; kind: "file" | "dir" };

async function makeEntry(root: string, entry: Entry): Promise<void> {
  const full = path.join(root, entry.path);
  if (entry.kind === "dir") {
    await mkdir(full, { recursive: true });
  } else {
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "");
  }
}

interface Row {
  desc: string;
  patterns: string[];
  entries: Entry[];
  // path -> expected ignored/not-ignored, asserted identically on both sides
  cases: { path: string; ignored: boolean }[];
}

const ROWS: Row[] = [
  {
    desc: "any-depth, no trailing slash: dual-emits into a directory's contents",
    patterns: ["node_modules"],
    entries: [{ path: "pkg/node_modules/x.js", kind: "file" }],
    cases: [{ path: "pkg/node_modules/x.js", ignored: true }],
  },
  {
    desc: "trailing slash excludes a directory's contents",
    patterns: ["build/"],
    entries: [{ path: "src/build/x.txt", kind: "file" }],
    cases: [{ path: "src/build/x.txt", ignored: true }],
  },
  {
    desc: "trailing slash does NOT match a same-named FILE",
    patterns: ["build/"],
    entries: [{ path: "other/build", kind: "file" }],
    cases: [{ path: "other/build", ignored: false }],
  },
  {
    desc: "anchored, no trailing slash: dual-emits root AND contents",
    patterns: ["/openspec"],
    entries: [
      { path: "openspec", kind: "dir" },
      { path: "openspec/changes/x/y.md", kind: "file" },
    ],
    cases: [
      { path: "openspec", ignored: true },
      { path: "openspec/changes/x/y.md", ignored: true },
    ],
  },
  {
    // Bare directory NAMES ("frotz" or "a/frotz" with nothing after them)
    // are deliberately excluded from this row — see the documented
    // divergence test below the table: our matcher treats a bare path as
    // possibly a FILE (there is no way to tell from a string alone), which
    // is the correct caution for THIS engine's domain, but disagrees with
    // git when the path happens to be a real directory on disk.
    desc: "trailing-only slash does not anchor: matches nested contents at any depth",
    patterns: ["frotz/"],
    entries: [{ path: "a/frotz/x.ts", kind: "file" }],
    cases: [{ path: "a/frotz/x.ts", ignored: true }],
  },
  {
    desc: "`*` does not cross a path separator (anchored form)",
    patterns: ["docs/*.md"],
    entries: [
      { path: "docs/a.md", kind: "file" },
      { path: "docs/sub/a.md", kind: "file" },
    ],
    cases: [
      { path: "docs/a.md", ignored: true },
      { path: "docs/sub/a.md", ignored: false },
    ],
  },
  {
    desc: "`[a-z]`-style character classes",
    patterns: ["file[0-9].txt"],
    entries: [
      { path: "file1.txt", kind: "file" },
      { path: "filea.txt", kind: "file" },
    ],
    cases: [
      { path: "file1.txt", ignored: true },
      { path: "filea.txt", ignored: false },
    ],
  },
  {
    desc: "middle `**` matches zero directories",
    patterns: ["a/**/b"],
    entries: [{ path: "a/b", kind: "file" }],
    cases: [{ path: "a/b", ignored: true }],
  },
  {
    desc: "3+ consecutive asterisks are tolerated, not rejected (shallow — the only depth this dialect asserts)",
    patterns: ["***/foo"],
    entries: [{ path: "x/foo", kind: "file" }],
    cases: [{ path: "x/foo", ignored: true }],
  },
  {
    desc: "literal braces: no alternation introduced",
    patterns: ["{a,b}.md"],
    entries: [
      { path: "{a,b}.md", kind: "file" },
      { path: "a.md", kind: "file" },
    ],
    cases: [
      { path: "{a,b}.md", ignored: true },
      { path: "a.md", ignored: false },
    ],
  },
  {
    desc: "escaped comment marker is a literal `#`",
    patterns: ["\\#literal.txt"],
    entries: [{ path: "#literal.txt", kind: "file" }],
    cases: [{ path: "#literal.txt", ignored: true }],
  },
  {
    desc: "escaped negation marker is a literal `!`",
    patterns: ["\\!important.txt"],
    entries: [{ path: "!important.txt", kind: "file" }],
    cases: [{ path: "!important.txt", ignored: true }],
  },
  {
    desc: "escaped trailing space survives as a literal character",
    patterns: ["foo\\ "],
    entries: [
      { path: "foo ", kind: "file" },
      { path: "foo", kind: "file" },
    ],
    cases: [
      { path: "foo ", ignored: true },
      { path: "foo", ignored: false },
    ],
  },
  {
    // The mandatory order-swap discriminator (#5515): a single negation
    // example cannot tell a correct last-match-wins matcher from a broken
    // `.some()`-based one. File-level patterns only (`*.md`, never a bare
    // directory-shaped pattern like `foo`) — a directory pattern would
    // trigger git's OWN re-inclusion restriction (the row excluded below)
    // and the two effects would be indistinguishable.
    desc: "negation order decides the outcome — rules AFTER win",
    patterns: ["*.md", "!docs2/a.md"],
    entries: [{ path: "docs2/a.md", kind: "file" }],
    cases: [{ path: "docs2/a.md", ignored: false }],
  },
  {
    desc: "the SAME rules, swapped order — the opposite outcome",
    patterns: ["!docs2/a.md", "*.md"],
    entries: [{ path: "docs2/a.md", kind: "file" }],
    cases: [{ path: "docs2/a.md", ignored: true }],
  },
];

describe("differential: .prheroignore vs real `git check-ignore`", () => {
  test.each(ROWS.map((row) => [row.desc, row] as const))(
    "%s",
    async (_desc, row) => {
      const repo = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-diff-"));
      try {
        await runGit(repo, ["init", "-q"]);
        // Pin OFF the host's case-folding default — see the file header WHY.
        await runGit(repo, ["config", "core.ignorecase", "false"]);
        await writeFile(
          path.join(repo, ".gitignore"),
          `${row.patterns.join("\n")}\n`,
        );
        for (const entry of row.entries) {
          await makeEntry(repo, entry);
        }
        for (const { path: target, ignored } of row.cases) {
          const gitVerdict = await gitCheckIgnore(repo, target);
          const ourVerdict = ours(row.patterns, target);
          expect(gitVerdict).toBe(ignored);
          expect(ourVerdict).toBe(ignored);
        }
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    },
  );

  // Deliberate divergence, documented rather than silently passing or being
  // dropped from the suite. gitignore(5), quoted exactly: "It is not
  // possible to re-include a file if a parent directory of that file is
  // excluded... Git doesn't list excluded directories for performance
  // reasons, so any patterns on contained files have no effect, no matter
  // where they are defined." This engine matches a finite diff file list,
  // not a tree walk, so the tree-walk optimization git relies on does not
  // apply — see ignore-file.ts's module comment.
  test("re-inclusion under an excluded directory: git and ours DISAGREE on purpose", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-diff-"));
    try {
      await runGit(dir, ["init", "-q"]);
      await runGit(dir, ["config", "core.ignorecase", "false"]);
      const patterns = ["docs/", "!docs/keep.md"];
      await writeFile(path.join(dir, ".gitignore"), `${patterns.join("\n")}\n`);
      await makeEntry(dir, { path: "docs/keep.md", kind: "file" });

      const gitVerdict = await gitCheckIgnore(dir, "docs/keep.md");
      const ourVerdict = ours(patterns, "docs/keep.md");

      expect(gitVerdict).toBe(true); // git: still ignored, cannot re-include
      expect(ourVerdict).toBe(false); // ours: re-included
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // SECOND documented divergence, DISCOVERED by this test (not previously
  // written down anywhere): a trailing-slash rule's directory-only
  // restriction is implemented, on our side, by requiring the glob to match
  // CONTENT after the directory name (`**/frotz/**`) — a bare path string
  // has no way to say "I am a directory", so our matcher never matches one.
  // Real git, given an ACTUAL directory on disk, knows better and matches
  // it. UNREACHABLE in practice: this engine only ever matches paths drawn
  // from a diff's changed-FILE list (`git diff --numstat`), which never
  // contains a bare directory entry — only leaves. Left as a known, narrow,
  // architecturally-forced gap rather than "fixed" by teaching the matcher
  // to stat the filesystem, which would break the "pure, offline, hands text
  // in" contract every other part of this module relies on.
  test("a bare directory-shaped path under a trailing-slash rule: git and ours DISAGREE (unreachable via a diff's file list)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-ignore-diff-"));
    try {
      await runGit(dir, ["init", "-q"]);
      await runGit(dir, ["config", "core.ignorecase", "false"]);
      const patterns = ["frotz/"];
      await writeFile(path.join(dir, ".gitignore"), `${patterns.join("\n")}\n`);
      await makeEntry(dir, { path: "a/frotz", kind: "dir" });

      const gitVerdict = await gitCheckIgnore(dir, "a/frotz");
      const ourVerdict = ours(patterns, "a/frotz");

      expect(gitVerdict).toBe(true); // git: knows it's a real directory
      expect(ourVerdict).toBe(false); // ours: a bare string could be a file
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
