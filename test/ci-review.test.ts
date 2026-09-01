// Phase 3 (Pillar 3, GitHub Actions CI): Review CLI Integration & CI
// Headless Shell. Ties Phase 1's reporter (ci-reporter.ts) and Phase 2's
// gates (ci-gates.ts) into the CLI surface: `--ci`/`--budget-usd`/
// `--step-summary` parsing, environment auto-detection, the assistant-
// posture exit-code contract, and the pure "what to publish" compositions
// reviewPr's shell calls mechanically (see cli.ts's reviewPr — the size-gate
// and budget-gate CI branches, and the final `ciExitCode` return).
//
// Style mirrors ci-gates.test.ts / ci-reporter.test.ts: no mocks, no I/O,
// plain literals for the upstream types.

import { describe, expect, test } from "bun:test";
import {
  budgetDisabledWarningMessage,
  budgetUnlimitedNoticeMessage,
  CI_DEFAULT_METERED_BUDGET_USD,
  type CiGateSkipPlan,
  ciExitCode,
  ciGateSkipOutputs,
  deriveCiBillingMode,
  planCiBudgetSkip,
  planCiSizeSkip,
  resolveCiBudgetCeiling,
  SKIP_BUDGET_COMMENT_MARKER,
  SKIP_SIZE_COMMENT_MARKER,
} from "../src/ci-gates";
import type { CiOutputs } from "../src/ci-reporter";
import {
  planCiReview,
  shouldPublishCiReview,
  shouldWriteCiOutputs,
  shouldWriteStepSummary,
  withCiWorkflowGroup,
} from "../src/cli";
import type { Finding } from "../src/findings";
import { isCiEnvironment, parseArgs } from "../src/preflight";
import type { SizeGateVerdict } from "../src/size-gate";

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    category: 12,
    path: "src/app.ts",
    line: 42,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "the value is stored in seconds and read as milliseconds",
    proof_refs: [],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 2,
    hop_trail: [],
    dedupe_key: `${overrides.path ?? "src/app.ts"}::12`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isCiEnvironment — design 3.1: Boolean(GITHUB_ACTIONS || CI || options.ci)
// ---------------------------------------------------------------------------

describe("isCiEnvironment", () => {
  test("false with no --ci flag and no env vars", () => {
    expect(isCiEnvironment({}, {})).toBe(false);
  });

  test("true when GITHUB_ACTIONS is set (auto-detection)", () => {
    expect(isCiEnvironment({}, { GITHUB_ACTIONS: "true" })).toBe(true);
  });

  test("true when CI is set", () => {
    expect(isCiEnvironment({}, { CI: "true" })).toBe(true);
  });

  test("true when --ci is explicitly passed, regardless of env", () => {
    expect(isCiEnvironment({ ci: true }, {})).toBe(true);
  });

  test("an explicit --ci: false does not override a true env var", () => {
    // options.ci is `boolean | undefined`; false is a real value here only
    // when parseArgs never actually produces it (there is no --no-ci flag —
    // this is the "OR", not "AND", boundary named in design 3.1).
    expect(isCiEnvironment({ ci: false }, { GITHUB_ACTIONS: "true" })).toBe(
      true,
    );
  });

  test("GITHUB_ACTIONS=false (the literal string) is still truthy per Boolean() semantics", () => {
    // Matches design 3.1's literal formula exactly: Boolean(process.env.X)
    // treats ANY non-empty string as true, including the string "false" —
    // GitHub Actions itself never sets the var to that, but the formula is
    // pinned here so a future "helpful" `=== "true"` rewrite is caught.
    expect(isCiEnvironment({}, { GITHUB_ACTIONS: "false" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — --ci / --budget-usd / --step-summary / --no-step-summary
// ---------------------------------------------------------------------------

describe("parseArgs — --ci", () => {
  test("parses --ci on review --pr", () => {
    const { options } = parseArgs(["review", "--pr", "5", "--ci"]);
    expect(options.ci).toBe(true);
  });

  test("--ci without --pr is a silently dropped intention — rejected", () => {
    expect(() => parseArgs(["review", "--ci"])).toThrow(/--pr/);
  });

  test("--ci only applies to the review or setup command", () => {
    // Phase 4 (CI Scaffolding) gave --ci a second, command-scoped meaning on
    // `setup`; the "which commands accept it" error message widened to
    // match. Every other command is still rejected.
    expect(() =>
      parseArgs(["post", "--pr", "5", "--from", "run1", "--ci"]),
    ).toThrow(/review or setup command/);
  });
});

describe("parseArgs — --budget-usd", () => {
  test("parses a float", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--budget-usd",
      "7.5",
    ]);
    expect(options.budgetUsd).toBe(7.5);
  });

  test("accepts 0 (disables the ceiling, per size-gate's convention)", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--budget-usd",
      "0",
    ]);
    expect(options.budgetUsd).toBe(0);
  });

  test("accepts a negative number (also disables the ceiling)", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--budget-usd",
      "-1",
    ]);
    expect(options.budgetUsd).toBe(-1);
  });

  test("a non-numeric value fails loud", () => {
    expect(() =>
      parseArgs(["review", "--pr", "5", "--ci", "--budget-usd", "lots"]),
    ).toThrow(/--budget-usd/);
  });

  test("--budget-usd without --ci is a silently dropped intention — rejected", () => {
    expect(() =>
      parseArgs(["review", "--pr", "5", "--budget-usd", "5"]),
    ).toThrow(/--ci/);
  });
});

describe("parseArgs — --step-summary / --no-step-summary", () => {
  test("--step-summary sets stepSummary true", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--step-summary",
    ]);
    expect(options.stepSummary).toBe(true);
  });

  test("--no-step-summary sets stepSummary false", () => {
    const { options } = parseArgs([
      "review",
      "--pr",
      "5",
      "--ci",
      "--no-step-summary",
    ]);
    expect(options.stepSummary).toBe(false);
  });

  test("unset stepSummary defaults to undefined (the shell treats it as on)", () => {
    const { options } = parseArgs(["review", "--pr", "5", "--ci"]);
    expect(options.stepSummary).toBeUndefined();
  });

  test("--step-summary without --ci is a silently dropped intention — rejected", () => {
    expect(() => parseArgs(["review", "--pr", "5", "--step-summary"])).toThrow(
      /--ci/,
    );
  });
});

// ---------------------------------------------------------------------------
// Assistant posture — spec 2.1: findings (even blocking ones) never fail
// the job. Only sessionFailed / a genuine posting drop do.
// ---------------------------------------------------------------------------

describe("ciExitCode — assistant posture (reviewer, not a merge gate)", () => {
  test("blocking findings exit 0 in CI — reviewer, not a merge gate", () => {
    expect(
      ciExitCode({
        sessionFailed: false,
        droppedFindingIds: 0,
        blockingCount: 7,
      }),
    ).toBe(0);
  });

  test("zero findings also exit 0", () => {
    expect(
      ciExitCode({
        sessionFailed: false,
        droppedFindingIds: 0,
        blockingCount: 0,
      }),
    ).toBe(0);
  });

  test("a fatal session failure exits 1 regardless of findings", () => {
    expect(
      ciExitCode({
        sessionFailed: true,
        droppedFindingIds: 0,
        blockingCount: 3,
      }),
    ).toBe(1);
  });

  test("a genuine posting drop (design D6) exits 1 regardless of findings", () => {
    expect(
      ciExitCode({
        sessionFailed: false,
        droppedFindingIds: 2,
        blockingCount: 0,
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// budgetDisabledWarningMessage — spec 3.1: a silent disable is
// indistinguishable from a passing gate, so a <= 0 ceiling MUST warn.
// ---------------------------------------------------------------------------

describe("budgetDisabledWarningMessage", () => {
  test("undefined (flag never given) warns nothing — nothing was disabled", () => {
    expect(budgetDisabledWarningMessage(undefined)).toBeNull();
  });

  test("a positive ceiling warns nothing — the gate is active", () => {
    expect(budgetDisabledWarningMessage(10)).toBeNull();
  });

  test("0 warns — the ceiling is disabled", () => {
    expect(budgetDisabledWarningMessage(0)).not.toBeNull();
    expect(budgetDisabledWarningMessage(0)).toContain("disabled");
  });

  test("a negative value warns too", () => {
    expect(budgetDisabledWarningMessage(-5)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ciGateSkipOutputs — spec 1.1's $GITHUB_OUTPUT contract for a skip.
// ---------------------------------------------------------------------------

describe("ciGateSkipOutputs", () => {
  test("skipped-size: cost_usd_est is 0 — no estimate exists yet, the gate fired before it", () => {
    const outputs: CiOutputs = ciGateSkipOutputs("skipped-size", 0);
    expect(outputs).toEqual({
      status: "skipped-size",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      cost_usd_est: 0,
      run_dir: "",
    });
  });

  test("skipped-budget: cost_usd_est carries the estimate that tripped the gate", () => {
    const outputs = ciGateSkipOutputs("skipped-budget", 12.5);
    expect(outputs.status).toBe("skipped-budget");
    expect(outputs.cost_usd_est).toBe(12.5);
    expect(outputs.run_dir).toBe("");
  });
});

// ---------------------------------------------------------------------------
// planCiSizeSkip / planCiBudgetSkip — the ONE pure call reviewPr's shell
// makes for a gate skip: everything it needs (comment, marker, summary
// markdown, outputs) built from the SAME numbers, so the PR comment and the
// step summary can never independently drift.
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

const passingGate: SizeGateVerdict = {
  ok: true,
  effectiveLines: 40,
  effectiveFiles: 3,
  excludedFiles: 0,
  excludedLines: 0,
};

describe("planCiSizeSkip", () => {
  test("null when the gate passed", () => {
    expect(
      planCiSizeSkip({
        isCi: true,
        verdict: passingGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  test("null outside CI even when the gate failed", () => {
    expect(
      planCiSizeSkip({
        isCi: false,
        verdict: failedLinesGate,
        prNumber: 55,
        maxChangedLines: 1000,
        maxChangedFiles: 50,
      }),
    ).toBeNull();
  });

  test("builds the full plan: comment, marker, summary markdown, and status=skipped-size outputs", () => {
    const plan: CiGateSkipPlan | null = planCiSizeSkip({
      isCi: true,
      verdict: failedLinesGate,
      prNumber: 55,
      maxChangedLines: 1000,
      maxChangedFiles: 50,
    });
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("unreachable");
    expect(plan.markerPrefix).toBe(SKIP_SIZE_COMMENT_MARKER);
    expect(plan.comment.startsWith(SKIP_SIZE_COMMENT_MARKER)).toBe(true);
    expect(plan.summaryMarkdown).toContain("PR #55");
    expect(plan.outputs).toEqual({
      status: "skipped-size",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      cost_usd_est: 0,
      run_dir: "",
    });
  });
});

describe("planCiBudgetSkip", () => {
  test("null when within budget", () => {
    expect(
      planCiBudgetSkip({
        isCi: true,
        estimatedCostUsd: 8,
        budgetUsd: 10,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  test("null when the ceiling is disabled (<= 0)", () => {
    expect(
      planCiBudgetSkip({
        isCi: true,
        estimatedCostUsd: 999,
        budgetUsd: 0,
        prNumber: 56,
      }),
    ).toBeNull();
  });

  test("builds the full plan: comment, marker, summary markdown, and outputs carrying the estimate that tripped it", () => {
    const plan = planCiBudgetSkip({
      isCi: true,
      estimatedCostUsd: 12.5,
      budgetUsd: 10,
      prNumber: 56,
    });
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("unreachable");
    expect(plan.markerPrefix).toBe(SKIP_BUDGET_COMMENT_MARKER);
    expect(plan.comment.startsWith(SKIP_BUDGET_COMMENT_MARKER)).toBe(true);
    expect(plan.summaryMarkdown).toContain("PR #56");
    expect(plan.outputs.status).toBe("skipped-budget");
    // The plan card and the skip comment must show the SAME number (ci-gates
    // header doctrine) — estimatedCostUsd here is estimate.high, per
    // report.ts's own documented under-estimate bias (see report.ts ~97-98).
    expect(plan.outputs.cost_usd_est).toBe(12.5);
  });
});

// ---------------------------------------------------------------------------
// The CI budget gate's route-aware resolution (issue #156). The gate compared
// `estimate.high` — a token-derived figure — against a real-dollar ceiling.
// On a subscription route the real cash cost is $0.00, so a $10 default
// refused work for an overrun that could not happen, and a skipped review is
// indistinguishable from a clean one on the checks page (ci-setup.ts:50-63).
//
// These compose the same three pure functions cli.ts's gate composes, in the
// same order, so a wiring change that drops one has to break a test here.
// ---------------------------------------------------------------------------

function budgetGateFor(input: {
  env: Record<string, string | undefined>;
  configured: number | undefined;
  estimatedCostUsd: number;
}): CiGateSkipPlan | null {
  const ceiling = resolveCiBudgetCeiling({
    configured: input.configured,
    billingMode: deriveCiBillingMode(input.env),
  });
  if (ceiling.budgetUsd === undefined) return null;
  return planCiBudgetSkip({
    isCi: true,
    estimatedCostUsd: input.estimatedCostUsd,
    budgetUsd: ceiling.budgetUsd,
    prNumber: 156,
  });
}

describe("CI budget gate resolution by billing mode", () => {
  test("subscription route, no configured budget: no gate runs at any estimate", () => {
    expect(
      budgetGateFor({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
        configured: undefined,
        estimatedCostUsd: 999,
      }),
    ).toBeNull();
  });

  test("subscription route with no ceiling announces itself — a silent no-gate is the failure this repo has already paid for", () => {
    const ceiling = resolveCiBudgetCeiling({
      configured: undefined,
      billingMode: deriveCiBillingMode({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      }),
    });
    expect(budgetUnlimitedNoticeMessage(ceiling)).not.toBeNull();
    // and the <= 0 warning stays silent: nothing was disabled here.
    expect(budgetDisabledWarningMessage(ceiling.budgetUsd)).toBeNull();
  });

  test("metered route, no configured budget: the default ceiling applies", () => {
    const plan = budgetGateFor({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      configured: undefined,
      estimatedCostUsd: CI_DEFAULT_METERED_BUDGET_USD + 2.5,
    });
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("unreachable");
    expect(plan.outputs.status).toBe("skipped-budget");
    expect(plan.comment).toContain(
      `$${CI_DEFAULT_METERED_BUDGET_USD.toFixed(2)}`,
    );
  });

  test("metered route, no configured budget, estimate under the default: no skip", () => {
    expect(
      budgetGateFor({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        configured: undefined,
        estimatedCostUsd: CI_DEFAULT_METERED_BUDGET_USD - 1,
      }),
    ).toBeNull();
  });

  test("an explicit ceiling wins on a subscription route", () => {
    const plan = budgetGateFor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
      configured: 5,
      estimatedCostUsd: 6,
    });
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("unreachable");
    expect(plan.comment).toContain("$5.00");
  });

  test("an explicit ceiling wins on a metered route, including an explicit disable", () => {
    expect(
      budgetGateFor({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        configured: 0,
        estimatedCostUsd: 999,
      }),
    ).toBeNull();
    const plan = budgetGateFor({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      configured: 20,
      estimatedCostUsd: 25,
    });
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("unreachable");
    expect(plan.comment).toContain("$20.00");
  });
});

// ---------------------------------------------------------------------------
// planCiReview — the "reviewed" (non-skip) outcome's summary + outputs.
// Exercises the assistant-posture bullet directly: blocking findings still
// publish, and the outputs/summary never encode a pass/fail verdict.
// ---------------------------------------------------------------------------

describe("planCiReview", () => {
  test("blocking findings are published in the summary, not suppressed", () => {
    const findings = [
      finding({ id: "F001", tier: "blocking", severity: "BLOCKER" }),
      finding({ id: "F002", tier: "advisory", severity: "SUGGESTION" }),
    ];
    const plan = planCiReview({
      prNumber: 5,
      headSha: "a".repeat(40),
      findings,
      costUsdEst: 3.2,
      wallMs: 90_000,
      model: "sonnet",
      runDir: "/tmp/run",
    });
    expect(plan.summaryMarkdown).toContain("src/app.ts");
    expect(plan.summaryMarkdown).toContain("blocking");
    expect(plan.outputs.status).toBe("reviewed");
    expect(plan.outputs.findings_count).toBe(2);
    expect(plan.outputs.blocking_count).toBe(1);
    expect(plan.outputs.advisory_count).toBe(1);
    expect(plan.outputs.cost_usd_est).toBe(3.2);
    expect(plan.outputs.run_dir).toBe("/tmp/run");
  });

  test("a clean review (no findings) still status=reviewed, not skipped", () => {
    const plan = planCiReview({
      prNumber: 5,
      headSha: "a".repeat(40),
      findings: [],
      costUsdEst: 1.1,
      wallMs: 30_000,
      model: "sonnet",
      runDir: "/tmp/run",
    });
    expect(plan.outputs.status).toBe("reviewed");
    expect(plan.outputs.findings_count).toBe(0);
    expect(plan.summaryMarkdown).toContain("No findings detected");
  });
});

// ---------------------------------------------------------------------------
// shouldWriteCiOutputs / shouldWriteStepSummary — the pure decision behind
// "Step summary file writing when $GITHUB_STEP_SUMMARY is provided" /
// "Output parameter writing when $GITHUB_OUTPUT is provided".
// ---------------------------------------------------------------------------

describe("shouldWriteCiOutputs", () => {
  test("true when in CI and the output path is a non-empty string", () => {
    expect(shouldWriteCiOutputs(true, "/tmp/gh-output")).toBe(true);
  });

  test("false when not in CI, even with a path present", () => {
    expect(shouldWriteCiOutputs(false, "/tmp/gh-output")).toBe(false);
  });

  test("false when the path is undefined", () => {
    expect(shouldWriteCiOutputs(true, undefined)).toBe(false);
  });

  test("false when the path is an empty string", () => {
    expect(shouldWriteCiOutputs(true, "")).toBe(false);
  });
});

describe("shouldWriteStepSummary", () => {
  test("true when in CI, the flag is unset (default on), and the path is present", () => {
    expect(shouldWriteStepSummary(true, undefined, "/tmp/summary.md")).toBe(
      true,
    );
  });

  test("true when the flag is explicitly on", () => {
    expect(shouldWriteStepSummary(true, true, "/tmp/summary.md")).toBe(true);
  });

  test("false when the flag is explicitly off (--no-step-summary)", () => {
    expect(shouldWriteStepSummary(true, false, "/tmp/summary.md")).toBe(false);
  });

  test("false when not in CI", () => {
    expect(shouldWriteStepSummary(false, undefined, "/tmp/summary.md")).toBe(
      false,
    );
  });

  test("false when the path is undefined", () => {
    expect(shouldWriteStepSummary(true, undefined, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldPublishCiReview — design D6's "a failed session publishes nothing",
// applied to the CI headless channel. `sessionFailed` means EVERY hunter
// died, which leaves `doc.findings` empty; publishing that as
// `status=reviewed` + a "No findings detected" step summary would tell a
// human the PR came back clean from a review that never ran. The job still
// exits non-zero, but a red job whose own artifacts assert a clean review is
// worse than a red job with no artifacts at all.
// ---------------------------------------------------------------------------

describe("shouldPublishCiReview", () => {
  test("true for a CI run whose session completed", () => {
    expect(shouldPublishCiReview(true, false)).toBe(true);
  });

  test("a crashed CI session publishes NO reviewed outputs or step summary", () => {
    expect(shouldPublishCiReview(true, true)).toBe(false);
  });

  test("false outside CI, session outcome notwithstanding", () => {
    expect(shouldPublishCiReview(false, false)).toBe(false);
    expect(shouldPublishCiReview(false, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withCiWorkflowGroup — spec 2.1's `::group::` / `::endgroup::` pairing.
// An unclosed group is not a cosmetic defect: everything the runner logs
// afterwards, the `::error::` annotation explaining the crash included, stays
// folded inside a collapsed section. The pairing therefore has to hold on the
// FAILURE path, which is the only path where reading the log matters.
// ---------------------------------------------------------------------------

describe("withCiWorkflowGroup", () => {
  test("wraps the body in a matched group/endgroup pair", async () => {
    const lines: string[] = [];
    const result = await withCiWorkflowGroup(
      true,
      "pr-hero review",
      (line) => lines.push(line),
      async () => {
        lines.push("body");
        return "value";
      },
    );
    expect(result).toBe("value");
    expect(lines).toEqual(["::group::pr-hero review", "body", "::endgroup::"]);
  });

  test("emits ::endgroup:: even when the body throws, and rethrows", async () => {
    const lines: string[] = [];
    await expect(
      withCiWorkflowGroup(
        true,
        "pr-hero review",
        (line) => lines.push(line),
        async () => {
          throw new Error("EROFS: read-only file system");
        },
      ),
    ).rejects.toThrow("EROFS: read-only file system");
    expect(lines).toEqual(["::group::pr-hero review", "::endgroup::"]);
  });

  test("emits no workflow commands at all outside CI", async () => {
    const lines: string[] = [];
    const result = await withCiWorkflowGroup(
      false,
      "pr-hero review",
      (line) => lines.push(line),
      async () => "value",
    );
    expect(result).toBe("value");
    expect(lines).toEqual([]);
  });
});
