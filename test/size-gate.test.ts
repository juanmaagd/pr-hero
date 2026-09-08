// The size gate is the one place that can decide, unattended, NOT to spend
// money — so every branch of it is pinned here, offline.

import { describe, expect, test } from "bun:test";
import { parseIgnoreFile } from "../src/ignore-file";
import { type NumstatFile, parseNumstatFiles } from "../src/preflight";
import {
  DEFAULT_SIZE_GATE,
  diffRecordPath,
  effectiveDiffStat,
  evaluateSizeGate,
  evaluateSizeGateAggregate,
  filterDiffByIgnoreRules,
  sizeGateConfig,
  sizeGateDisposition,
  sizeGateLine,
} from "../src/size-gate";

function file(
  path: string,
  insertions: number,
  deletions = 0,
  binary = false,
): NumstatFile {
  return { path, insertions, deletions, binary };
}

const CONFIG = {
  maxChangedLines: 100,
  maxChangedFiles: 5,
  excludeRules: DEFAULT_SIZE_GATE.excludeRules,
};

describe("evaluateSizeGate", () => {
  test("under both limits passes, and lines are insertions + deletions", () => {
    const verdict = evaluateSizeGate(
      [file("src/a.ts", 30, 20), file("src/b.ts", 10, 5)],
      CONFIG,
    );
    expect(verdict).toEqual({
      ok: true,
      effectiveLines: 65,
      effectiveFiles: 2,
      excludedFiles: 0,
      excludedLines: 0,
    });
  });

  // The boundary is exact: AT the limit passes, one line past it does not.
  test("the line boundary is exact", () => {
    expect(evaluateSizeGate([file("src/a.ts", 100)], CONFIG).ok).toBe(true);
    expect(evaluateSizeGate([file("src/a.ts", 101)], CONFIG).ok).toBe(false);
  });

  test("over the line limit names the reason, the limit and the escape hatch", () => {
    const verdict = evaluateSizeGate([file("src/a.ts", 200, 40)], CONFIG);
    if (verdict.ok) throw new Error("expected a skip");
    expect(verdict.reason).toBe("lines");
    expect(verdict.limit).toBe(100);
    expect(verdict.effectiveLines).toBe(240);
    expect(verdict.message).toContain("240 effective changed lines");
    expect(verdict.message).toContain("100-line limit");
    expect(verdict.message).toContain("--max-changed-lines");
    expect(verdict.message).toContain("--force");
    // The stated reason is COST. This gate makes no claim about quality,
    // and the message must never grow one.
    expect(verdict.message).toContain("Cost scales with diff size");
    expect(verdict.message.toLowerCase()).not.toContain("quality");
    // And it quotes the MEASUREMENT rather than predicting this diff's own
    // bill — the limit is configurable, so a hardcoded price would be false
    // at any threshold but the default.
    expect(verdict.message).toContain("bench tree billed");
  });

  // Lines are checked BEFORE files, so a diff over both reports "lines".
  test("over the file limit, with lines still under", () => {
    const many = Array.from({ length: 6 }, (_, i) => file(`src/${i}.ts`, 1));
    const verdict = evaluateSizeGate(many, CONFIG);
    if (verdict.ok) throw new Error("expected a skip");
    expect(verdict.reason).toBe("files");
    expect(verdict.limit).toBe(5);
    expect(verdict.effectiveFiles).toBe(6);
    expect(verdict.message).toContain("--max-changed-files");
  });

  test("lines are checked before files when both are over", () => {
    const many = Array.from({ length: 6 }, (_, i) => file(`src/${i}.ts`, 50));
    const verdict = evaluateSizeGate(many, CONFIG);
    if (verdict.ok) throw new Error("expected a skip");
    expect(verdict.reason).toBe("lines");
  });

  // The whole reason the exclusion list exists: a regenerated lockfile must
  // not push a small change over the gate.
  test("an exclusion rescues an otherwise-oversized diff", () => {
    const verdict = evaluateSizeGate(
      [file("src/a.ts", 10, 5), file("bun.lock", 1800, 90)],
      CONFIG,
    );
    expect(verdict).toEqual({
      ok: true,
      effectiveLines: 15,
      effectiveFiles: 1,
      excludedFiles: 1,
      excludedLines: 1890,
    });
  });

  test("the exclusion list covers root-level and nested generated files", () => {
    const verdict = evaluateSizeGate(
      [
        file("bun.lock", 100),
        file("apps/web/package-lock.json", 100),
        file("dist/app.min.js", 100),
        file("src/__snapshots__/x.test.ts.snap", 100),
        file("go.sum", 100),
      ],
      CONFIG,
    );
    expect(verdict.excludedFiles).toBe(5);
    expect(verdict.effectiveFiles).toBe(0);
  });

  test("an all-excluded diff passes with zero effective size", () => {
    const verdict = evaluateSizeGate(
      [file("bun.lock", 5000), file("yarn.lock", 4000)],
      CONFIG,
    );
    expect(verdict).toEqual({
      ok: true,
      effectiveLines: 0,
      effectiveFiles: 0,
      excludedFiles: 2,
      excludedLines: 9000,
    });
  });

  // 0 DISABLES a limit — it is a real value, never "unset".
  test("a zero limit disables that check and only that check", () => {
    const huge = [file("src/a.ts", 10_000)];
    expect(evaluateSizeGate(huge, { ...CONFIG, maxChangedLines: 0 }).ok).toBe(
      true,
    );
    const many = Array.from({ length: 50 }, (_, i) => file(`src/${i}.ts`, 1));
    expect(evaluateSizeGate(many, { ...CONFIG, maxChangedFiles: 0 }).ok).toBe(
      true,
    );
    // Files still bites when only the line limit was disabled.
    const verdict = evaluateSizeGate(many, {
      ...CONFIG,
      maxChangedLines: 0,
    });
    if (verdict.ok) throw new Error("expected a skip");
    expect(verdict.reason).toBe("files");
  });

  test("both limits disabled never skips", () => {
    const monster = Array.from({ length: 900 }, (_, i) =>
      file(`src/${i}.ts`, 500),
    );
    expect(
      evaluateSizeGate(monster, {
        maxChangedLines: 0,
        maxChangedFiles: 0,
        excludeRules: [],
      }).ok,
    ).toBe(true);
  });

  // A binary file counts as a changed FILE and contributes no lines — the
  // same rule parseNumstat has always applied to the cost estimate.
  test("binary files count toward files and contribute no lines", () => {
    const verdict = evaluateSizeGate(
      [file("assets/logo.png", 0, 0, true), file("src/a.ts", 3)],
      CONFIG,
    );
    expect(verdict).toEqual({
      ok: true,
      effectiveLines: 3,
      effectiveFiles: 2,
      excludedFiles: 0,
      excludedLines: 0,
    });
  });

  test("an empty file list passes", () => {
    expect(evaluateSizeGate([], CONFIG).ok).toBe(true);
  });
});

describe("evaluateSizeGateAggregate", () => {
  // No paths, therefore no exclusions — an UPPER bound, wrong only in the
  // conservative direction.
  test("counts the aggregate whole, with nothing excluded", () => {
    expect(
      evaluateSizeGateAggregate(
        { files: 2, insertions: 40, deletions: 20 },
        CONFIG,
      ),
    ).toEqual({
      ok: true,
      effectiveLines: 60,
      effectiveFiles: 2,
      excludedFiles: 0,
      excludedLines: 0,
    });
  });

  test("a lockfile-dominated aggregate is rejected where per-file passes", () => {
    const stat = { files: 2, insertions: 1810, deletions: 95 };
    expect(evaluateSizeGateAggregate(stat, CONFIG).ok).toBe(false);
    expect(
      evaluateSizeGate(
        [file("src/a.ts", 10, 5), file("bun.lock", 1800, 90)],
        CONFIG,
      ).ok,
    ).toBe(true);
  });

  test("the file limit still applies, and zero still disables", () => {
    const stat = { files: 40, insertions: 1, deletions: 0 };
    const verdict = evaluateSizeGateAggregate(stat, CONFIG);
    if (verdict.ok) throw new Error("expected a skip");
    expect(verdict.reason).toBe("files");
    expect(
      evaluateSizeGateAggregate(stat, { ...CONFIG, maxChangedFiles: 0 }).ok,
    ).toBe(true);
  });
});

describe("sizeGateDisposition", () => {
  const over = evaluateSizeGate([file("src/a.ts", 200)], CONFIG);
  const under = evaluateSizeGate([file("src/a.ts", 10)], CONFIG);

  test("under the limit proceeds even without force", () => {
    expect(
      sizeGateDisposition(under, {
        force: false,
        yes: false,
        interactive: true,
      }),
    ).toEqual({ action: "proceed" });
  });

  test("--force proceeds even over the limit", () => {
    expect(
      sizeGateDisposition(over, {
        force: true,
        yes: false,
        interactive: false,
      }),
    ).toEqual({ action: "proceed" });
  });

  test("--yes skips with no prompt — that is the watcher", () => {
    const d = sizeGateDisposition(over, {
      force: false,
      yes: true,
      interactive: true,
    });
    expect(d.action).toBe("skip");
    if (d.action !== "skip" || over.ok) throw new Error("expected a skip");
    expect(d.message).toBe(over.message);
  });

  test("non-TTY skips even without --yes", () => {
    expect(
      sizeGateDisposition(over, {
        force: false,
        yes: false,
        interactive: false,
      }).action,
    ).toBe("skip");
  });

  test("an interactive TTY is prompted instead of dying", () => {
    expect(
      sizeGateDisposition(over, {
        force: false,
        yes: false,
        interactive: true,
      }),
    ).toEqual({ action: "prompt" });
  });

  test("--force wins over --yes: the cost band is the other gate", () => {
    expect(
      sizeGateDisposition(over, {
        force: true,
        yes: true,
        interactive: false,
      }),
    ).toEqual({ action: "proceed" });
  });
});

describe("sizeGateConfig", () => {
  // Undefined means "not asked for"; 0 means "disabled". Collapsing the two
  // would silently disable the gate for anyone who passed nothing.
  test("unset overrides fall back to the shipped defaults", () => {
    expect(sizeGateConfig({})).toEqual(DEFAULT_SIZE_GATE);
  });

  test("a zero override survives as zero", () => {
    expect(sizeGateConfig({ maxChangedLines: 0 })).toEqual({
      ...DEFAULT_SIZE_GATE,
      maxChangedLines: 0,
    });
  });

  test("config layer values are picked up before falling back to defaults", () => {
    expect(
      sizeGateConfig({}, { max_changed_lines: 2000, max_changed_files: 80 }),
    ).toEqual({
      ...DEFAULT_SIZE_GATE,
      maxChangedLines: 2000,
      maxChangedFiles: 80,
    });
  });

  test("CLI overrides take precedence over config layer values", () => {
    expect(
      sizeGateConfig(
        { maxChangedLines: 500 },
        { max_changed_lines: 2000, max_changed_files: 80 },
      ),
    ).toEqual({
      ...DEFAULT_SIZE_GATE,
      maxChangedLines: 500,
      maxChangedFiles: 80,
    });
  });

  // Pins the shipped numbers to the README's profile table. Moving a default
  // must be a deliberate edit here, not a drift. The number moved 1500 → 2500
  // → 1500: this repo's own PR #1 (1603 lines) was refused while its cost
  // band read $3.18-6.86, which was read as "too tight" and answered with
  // 2500. The real cause was that the gate counted lines it did not filter
  // (F001) and counted formatting noise it should ignore; with both fixed,
  // 1500 stands. See the WHY on DEFAULT_SIZE_GATE.
  test("the shipped defaults are the documented ones", () => {
    expect(DEFAULT_SIZE_GATE.maxChangedLines).toBe(1500);
    expect(DEFAULT_SIZE_GATE.maxChangedFiles).toBe(150);
  });
});

describe("sizeGateLine", () => {
  test("a pass reports the effective size and any exclusions", () => {
    const line = sizeGateLine(
      evaluateSizeGate([file("src/a.ts", 10), file("bun.lock", 900)], CONFIG),
    );
    expect(line).toContain("size gate: pass");
    expect(line).toContain("10 effective line(s)");
    expect(line).toContain("excluded");
  });

  test("a skip carries the full message", () => {
    const line = sizeGateLine(
      evaluateSizeGate([file("src/a.ts", 500)], CONFIG),
    );
    expect(line).toContain("size gate: SKIP");
    expect(line).toContain("--force");
  });
});

// The exclusion list is only honest if the excluded files leave the diff the
// hunters are actually handed (F001). These pin the record splitter, because
// dropping the wrong record deletes real changed code out of a review.
const ORDINARY = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
`;

const LOCKFILE = `diff --git a/bun.lock b/bun.lock
index 3333333..4444444 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,2 +1,2 @@
-a
+b
`;

// A pure rename carries NO ---/+++ pair at all: \`rename to\` is the only
// path evidence in the record.
const RENAME = `diff --git a/vendor/lib.js b/vendor/lib.min.js
similarity index 100%
rename from vendor/lib.js
rename to vendor/lib.min.js
`;

// A binary record has no hunks and no ---/+++ pair either — only the header
// and git's one-line summary.
const BINARY = `diff --git a/dist/app.min.js b/dist/app.min.js
index 5555555..6666666 100644
GIT binary patch
literal 4
Mc$_
`;

const DELETED = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
deleted file mode 100644
index 7777777..0000000
--- a/pnpm-lock.yaml
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`;

const CREATED = `diff --git a/go.sum b/go.sum
new file mode 100644
index 0000000..8888888
--- /dev/null
+++ b/go.sum
@@ -0,0 +1,2 @@
+a
+b
`;

// A record whose hunk body contains a line that LOOKS like a diff header:
// content lines always carry a prefix character, so the splitter must not be
// fooled by one.
const NESTED = `diff --git a/test/fixture.md b/test/fixture.md
index 9999999..aaaaaaa 100644
--- a/test/fixture.md
+++ b/test/fixture.md
@@ -1,2 +1,3 @@
 sample patch:
+ diff --git a/bun.lock b/bun.lock
 end
`;

describe("diffRecordPath", () => {
  test("an ordinary modification resolves to its path", () => {
    expect(diffRecordPath(ORDINARY)).toBe("src/a.ts");
  });

  // The DESTINATION, for the same reason resolveNumstatPath resolves it: a
  // renamed lockfile that resolved to its old name would stop being excluded.
  test("a rename resolves to the destination, from `rename to`", () => {
    expect(diffRecordPath(RENAME)).toBe("vendor/lib.min.js");
  });

  test("a binary record falls back to the header", () => {
    expect(diffRecordPath(BINARY)).toBe("dist/app.min.js");
  });

  test("a deletion resolves to the source (+++ is /dev/null)", () => {
    expect(diffRecordPath(DELETED)).toBe("pnpm-lock.yaml");
  });

  test("an addition resolves to the destination (--- is /dev/null)", () => {
    expect(diffRecordPath(CREATED)).toBe("go.sum");
  });

  test("hunk content is never read as metadata", () => {
    expect(diffRecordPath(NESTED)).toBe("test/fixture.md");
  });

  test("a non-record resolves to nothing", () => {
    expect(diffRecordPath("not a diff at all\n")).toBeUndefined();
  });
});

describe("filterDiffByIgnoreRules", () => {
  const rules = DEFAULT_SIZE_GATE.excludeRules;

  test("drops whole excluded records and keeps the rest byte-for-byte", () => {
    const result = filterDiffByIgnoreRules(
      `${ORDINARY}${LOCKFILE}${NESTED}`,
      rules,
    );
    expect(result.patch).toBe(`${ORDINARY}${NESTED}`);
    expect(result.droppedPaths).toEqual(["bun.lock"]);
  });

  // Nothing excluded must be a strict no-op: diff.patch is the provenance
  // artifact, and a filter that reflows bytes would break replay.
  test("with nothing to drop the patch is byte-identical", () => {
    const patch = `${ORDINARY}${NESTED}`;
    const result = filterDiffByIgnoreRules(patch, rules);
    expect(result.patch).toBe(patch);
    expect(result.droppedPaths).toEqual([]);
  });

  test("renames, binaries, deletions and additions all drop by destination", () => {
    const result = filterDiffByIgnoreRules(
      `${RENAME}${ORDINARY}${BINARY}${DELETED}${CREATED}`,
      rules,
    );
    expect(result.patch).toBe(ORDINARY);
    expect(result.droppedPaths).toEqual([
      "vendor/lib.min.js",
      "dist/app.min.js",
      "pnpm-lock.yaml",
      "go.sum",
    ]);
  });

  // The case the CLI turns into "nothing to review": every record excluded
  // leaves an EMPTY patch, never three hunters spawned on nothing.
  test("an all-excluded diff produces an empty patch", () => {
    const result = filterDiffByIgnoreRules(`${LOCKFILE}${CREATED}`, rules);
    expect(result.patch).toBe("");
    expect(result.droppedPaths).toEqual(["bun.lock", "go.sum"]);
  });

  test("an empty patch stays empty", () => {
    expect(filterDiffByIgnoreRules("", rules)).toEqual({
      patch: "",
      droppedPaths: [],
      exclusions: [],
    });
  });

  // Failing OPEN is deliberate and PRESERVED across the rename/consolidation:
  // an unresolvable record is kept, because the cost of keeping it is money
  // and the cost of dropping it is a silent hole in the review — deleting
  // real changed code out of the diff the hunters are handed.
  test("a record with no resolvable path is kept (fail-open, pinned)", () => {
    const weird = "diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n";
    expect(filterDiffByIgnoreRules(weird, rules).patch).toBe(weird);
    expect(filterDiffByIgnoreRules(weird, rules).droppedPaths).toEqual([]);
  });

  test("no rules drops nothing", () => {
    const patch = `${ORDINARY}${LOCKFILE}`;
    expect(filterDiffByIgnoreRules(patch, []).patch).toBe(patch);
  });

  // Per-path exclusion provenance: which rule and source excluded a path,
  // for pipeline.json (a later PR) and any diagnostic message that needs to
  // answer "why was this file not reviewed".
  test("provenance names the excluding rule and its source", () => {
    const result = filterDiffByIgnoreRules(LOCKFILE, rules);
    expect(result.exclusions).toEqual([
      {
        path: "bun.lock",
        pattern: "bun.lock",
        source: "builtin",
        line: undefined,
      },
    ]);
  });

  test("a user rule's provenance carries its line number", () => {
    const userRules = parseIgnoreFile("vendor/**\n", "user");
    const patch =
      "diff --git a/vendor/lib.js b/vendor/lib.js\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/vendor/lib.js\n" +
      "+++ b/vendor/lib.js\n" +
      "@@ -1 +1 @@\n" +
      "-a\n" +
      "+b\n";
    const result = filterDiffByIgnoreRules(patch, userRules);
    expect(result.exclusions).toEqual([
      { path: "vendor/lib.js", pattern: "vendor/**", source: "user", line: 1 },
    ]);
  });
});

describe("effectiveDiffStat", () => {
  // The cost basis and the gate must agree about which files exist: the band
  // prices what the hunters read, and they read the filtered diff.
  test("sums only the files that survive the exclusions", () => {
    expect(
      effectiveDiffStat(
        [file("src/a.ts", 10, 5), file("bun.lock", 900, 800)],
        DEFAULT_SIZE_GATE.excludeRules,
      ),
    ).toEqual({ files: 1, insertions: 10, deletions: 5 });
  });

  // The regression: git C-quotes non-ASCII paths, and a quoted path matches no
  // glob. The file was dropped from diff.patch while its lines stayed here, so
  // the gate over-counted a diff the hunters never saw.
  test("a C-quoted excluded path is not counted", () => {
    expect(
      effectiveDiffStat(
        parseNumstatFiles(
          '10\t5\tsrc/a.ts\n900\t800\t"canci\\303\\263n.min.js"\n',
        ),
        DEFAULT_SIZE_GATE.excludeRules,
      ),
    ).toEqual({ files: 1, insertions: 10, deletions: 5 });
  });

  test("everything excluded is a zero stat", () => {
    expect(
      effectiveDiffStat(
        [file("bun.lock", 900), file("dist/x.min.js", 40)],
        DEFAULT_SIZE_GATE.excludeRules,
      ),
    ).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

// THE ORDER-SWAP TEST, at the size-gate integration level (the unit-level
// version lives in test/ignore-file.test.ts). This is the only test that
// proves the THREE consumers were actually consolidated onto ONE per-RULE
// last-match-wins fold, rather than cosmetically renamed while still
// running `.some()` under the hood: `.some()` over a flat glob list cannot
// tell forward order from swapped order, so it would return the SAME
// verdict for both and this test would fail to discriminate.
describe("consolidated fold — order-swap discriminates all three consumers", () => {
  const forward = [
    ...parseIgnoreFile("*.md", "user"),
    ...parseIgnoreFile("!docs/a.md", "user"),
  ];
  const swapped = [
    ...parseIgnoreFile("!docs/a.md", "user"),
    ...parseIgnoreFile("*.md", "user"),
  ];
  const DOC_DIFF =
    "diff --git a/docs/a.md b/docs/a.md\n" +
    "index 1111111..2222222 100644\n" +
    "--- a/docs/a.md\n" +
    "+++ b/docs/a.md\n" +
    "@@ -1 +1 @@\n" +
    "-old\n" +
    "+new\n";

  test("evaluateSizeGate: forward includes, swapped excludes", () => {
    const gateConfig = { maxChangedLines: 100, maxChangedFiles: 5 };
    const forwardVerdict = evaluateSizeGate([file("docs/a.md", 10)], {
      ...gateConfig,
      excludeRules: forward,
    });
    expect(forwardVerdict.effectiveFiles).toBe(1);
    const swappedVerdict = evaluateSizeGate([file("docs/a.md", 10)], {
      ...gateConfig,
      excludeRules: swapped,
    });
    expect(swappedVerdict.effectiveFiles).toBe(0);
  });

  test("filterDiffByIgnoreRules: forward keeps, swapped drops", () => {
    expect(filterDiffByIgnoreRules(DOC_DIFF, forward).droppedPaths).toEqual([]);
    expect(filterDiffByIgnoreRules(DOC_DIFF, swapped).droppedPaths).toEqual([
      "docs/a.md",
    ]);
  });

  test("effectiveDiffStat: forward counts, swapped does not", () => {
    expect(effectiveDiffStat([file("docs/a.md", 10)], forward).files).toBe(1);
    expect(effectiveDiffStat([file("docs/a.md", 10)], swapped).files).toBe(0);
  });
});
