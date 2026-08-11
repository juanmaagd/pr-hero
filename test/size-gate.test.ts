// The size gate is the one place that can decide, unattended, NOT to spend
// money — so every branch of it is pinned here, offline.

import { describe, expect, test } from "bun:test";
import type { NumstatFile } from "../src/preflight";
import {
  DEFAULT_SIZE_GATE,
  evaluateSizeGate,
  evaluateSizeGateAggregate,
  sizeGateConfig,
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
  excludeGlobs: DEFAULT_SIZE_GATE.excludeGlobs,
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
        excludeGlobs: [],
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

  // Pins the shipped numbers to the README's profile table. Moving a default
  // must be a deliberate edit here, not a drift — 1500 became 2500 once this
  // repo's own PR #1 (1603 lines) was refused while its cost band read
  // $3.18-6.86, which is the gate firing where its stated reason does not
  // hold. See the WHY on DEFAULT_SIZE_GATE.
  test("the shipped defaults are the documented ones", () => {
    expect(DEFAULT_SIZE_GATE.maxChangedLines).toBe(2500);
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
