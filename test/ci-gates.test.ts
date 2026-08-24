// Phase 2 (Pillar 3, GitHub Actions CI): bounded unattended spend. Pure
// budget-gate evaluation plus the CI-mode skip payload builders that turn an
// already-computed size-gate verdict or budget comparison into the two
// things a CI run needs to publish — a PR comment and a step-summary
// payload — without spawning agents or touching the filesystem/network.
//
// Mirrors ci-reporter.test.ts's style: no mocks, no I/O, plain literals for
// the upstream types (SizeGateVerdict from size-gate.ts, CiSummaryData from
// ci-reporter.ts).

import { describe, expect, test } from "bun:test";
import {
  type BudgetGateVerdict,
  type CiBudgetGateSkipInput,
  type CiGateSkip,
  type CiSizeGateSkipInput,
  ciBudgetGateSkip,
  ciSizeGateSkip,
  evaluateBudgetGate,
} from "../src/ci-gates";
import { renderStepSummary } from "../src/ci-reporter";
import type { SizeGateVerdict } from "../src/size-gate";

// ---------------------------------------------------------------------------
// evaluateBudgetGate
// ---------------------------------------------------------------------------

describe("evaluateBudgetGate", () => {
  test("allows a cost strictly below the budget, with no reason", () => {
    const verdict: BudgetGateVerdict = evaluateBudgetGate(4.5, 10);
    expect(verdict).toEqual({ allowed: true });
  });

  test("allows a cost exactly equal to the budget (inclusive boundary)", () => {
    const verdict = evaluateBudgetGate(10, 10);
    expect(verdict).toEqual({ allowed: true });
  });

  test("disallows a cost above the budget and states both figures", () => {
    const verdict = evaluateBudgetGate(12.5, 10);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("$12.50");
    expect(verdict.reason).toContain("$10.00");
  });

  // size-gate.ts:20 already settled what a non-positive spend knob means in
  // this repo: "<= 0 disables the limit. Both knobs, independently." The
  // budget ceiling ships beside max-changed-lines / max-changed-files in the
  // same action.yml and feeds the same preflight, so it has to read the same
  // way — a non-positive ceiling is NO ceiling, not a $0 one.
  //
  // The two failure modes are not symmetric, which is what decides it. Read
  // as "no ceiling" when the operator meant "spend nothing", the cost of
  // being wrong is one visible review, still bounded by the size gate that
  // runs independently. Read as "always skip" when the operator meant "no
  // ceiling", pr-hero goes silently dark and every run still exits 0 green —
  // the same shape of failure as a lint gate that checks nothing and passes.
  test("treats a zero budget as no ceiling, matching size-gate's <= 0 convention", () => {
    expect(evaluateBudgetGate(0, 0)).toEqual({ allowed: true });
    expect(evaluateBudgetGate(0.01, 0)).toEqual({ allowed: true });
    expect(evaluateBudgetGate(9999, 0)).toEqual({ allowed: true });
  });

  test("treats a negative budget as no ceiling too", () => {
    expect(evaluateBudgetGate(12.5, -1)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// ciSizeGateSkip
// ---------------------------------------------------------------------------

const failedLinesGate: SizeGateVerdict = {
  ok: false,
  reason: "lines",
  effectiveLines: 1200,
  effectiveFiles: 60,
  excludedFiles: 0,
  excludedLines: 0,
  limit: 1000,
  message: "1200 effective changed lines exceeds the 1000-line limit",
};

const failedFilesGate: SizeGateVerdict = {
  ok: false,
  reason: "files",
  effectiveLines: 300,
  effectiveFiles: 90,
  excludedFiles: 0,
  excludedLines: 0,
  limit: 50,
  message: "90 effective changed files exceeds the 50-file limit",
};

const passingGate: SizeGateVerdict = {
  ok: true,
  effectiveLines: 40,
  effectiveFiles: 3,
  excludedFiles: 0,
  excludedLines: 0,
};

describe("ciSizeGateSkip", () => {
  test("returns null outside CI mode, even when the gate failed", () => {
    expect(
      ciSizeGateSkip({
        isCi: false,
        verdict: failedLinesGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  test("returns null in CI mode when the gate passed", () => {
    expect(
      ciSizeGateSkip({
        isCi: true,
        verdict: passingGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  test("in CI mode with a failed (lines) verdict, builds a comment and a skipped-size summary without throwing", () => {
    const input: CiSizeGateSkipInput = {
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    };
    const skip: CiGateSkip | null = ciSizeGateSkip(input);
    expect(skip).not.toBeNull();
    expect(skip?.summary).toEqual({
      kind: "skipped-size",
      prNumber: 55,
      changedLines: 1200,
      changedFiles: 60,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
  });

  test("in CI mode with a failed (files) verdict, still builds a valid payload", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedFilesGate,
      prNumber: 12,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip?.summary).toEqual({
      kind: "skipped-size",
      prNumber: 12,
      changedLines: 300,
      changedFiles: 90,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
  });

  test("the comment markdown starts with a machine-readable pr-hero marker", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip?.comment.startsWith("<!-- pr-hero-skip-size -->")).toBe(true);
  });

  test("the comment reports the changed lines/files against their limits", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip?.comment).toContain("1200");
    expect(skip?.comment).toContain("60");
    expect(skip?.comment).toContain("1000");
    expect(skip?.comment).toContain("50");
  });

  test("the comment never reads as a reprimand — no quality/blame language", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    const lowered = skip?.comment.toLowerCase() ?? "";
    expect(lowered).not.toContain("bad");
    expect(lowered).not.toContain("low quality");
    expect(lowered).not.toContain("reject");
  });

  test("the summary payload renders cleanly through ci-reporter's renderStepSummary (shape compatibility)", () => {
    const skip = ciSizeGateSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(skip).not.toBeNull();
    if (skip === null) throw new Error("unreachable");
    expect(() => renderStepSummary(skip.summary)).not.toThrow();
    const rendered = renderStepSummary(skip.summary);
    expect(rendered).toContain("PR #55");
    expect(rendered).toContain("1200 (limit 1000)");
  });
});

// ---------------------------------------------------------------------------
// ciBudgetGateSkip
// ---------------------------------------------------------------------------

describe("ciBudgetGateSkip", () => {
  test("returns null outside CI mode, even when the cost exceeds the budget", () => {
    expect(
      ciBudgetGateSkip({
        isCi: false,
        estimatedCostUsd: 12.5,
        budgetUsd: 10,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  test("returns null in CI mode when the cost is within budget", () => {
    expect(
      ciBudgetGateSkip({
        isCi: true,
        estimatedCostUsd: 8,
        budgetUsd: 10,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  // The disable convention has to survive the whole path, not just the
  // predicate: a CI run configured with no ceiling must publish nothing at
  // all, rather than a courteous notice explaining it skipped everything.
  test("returns null in CI mode when the budget is disabled with <= 0", () => {
    expect(
      ciBudgetGateSkip({
        isCi: true,
        estimatedCostUsd: 999,
        budgetUsd: 0,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  test("in CI mode with an over-budget estimate, builds a comment and a skipped-budget summary without throwing", () => {
    const input: CiBudgetGateSkipInput = {
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    };
    const skip: CiGateSkip | null = ciBudgetGateSkip(input);
    expect(skip).not.toBeNull();
    expect(skip?.summary).toEqual({
      kind: "skipped-budget",
      prNumber: 56,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
    });
  });

  test("the comment markdown starts with a machine-readable pr-hero marker", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    expect(skip?.comment.startsWith("<!-- pr-hero-skip-budget -->")).toBe(true);
  });

  test("the comment states both the estimated cost and the budget ceiling", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    expect(skip?.comment).toContain("$12.50");
    expect(skip?.comment).toContain("$10.00");
  });

  test("the comment never reads as a reprimand — no quality/blame language", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    const lowered = skip?.comment.toLowerCase() ?? "";
    expect(lowered).not.toContain("bad");
    expect(lowered).not.toContain("low quality");
    expect(lowered).not.toContain("reject");
  });

  test("the summary payload renders cleanly through ci-reporter's renderStepSummary (shape compatibility)", () => {
    const skip = ciBudgetGateSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    expect(skip).not.toBeNull();
    if (skip === null) throw new Error("unreachable");
    expect(() => renderStepSummary(skip.summary)).not.toThrow();
    const rendered = renderStepSummary(skip.summary);
    expect(rendered).toContain("PR #56");
    expect(rendered).toContain("$12.50 (budget $10.00)");
  });
});
