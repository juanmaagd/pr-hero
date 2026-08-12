// The plan card and its details view, as LINES. Both pairs of renderers
// (local mode's and PR mode's) were `(ctx) => void` runs of log() calls until
// WU4 and therefore had ZERO coverage: the card that decides whether an
// operator spends $4 was the least-tested output in the CLI, and the details
// pair could sit dead through a clean `bun run check` because biome does not
// flag exported symbols.
//
// Everything here asserts the RETURNED array. `styles` arrives as a parameter
// (ui.ts's contract), so both the painted and the unpainted shape are
// assertable offline with no TTY anywhere.

import { describe, expect, test } from "bun:test";
import {
  type PlanContext,
  type PrPlanContext,
  planDetails,
  prPlanDetails,
  renderPlan,
  renderPrPlan,
} from "../src/cli";
import type { CliOptions } from "../src/preflight";
import type { ParsedAgent } from "../src/prompt-set";
import { estimateCost } from "../src/report";
import type { SizeGateVerdict } from "../src/size-gate";
import type { ReviewSpec } from "../src/spec";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const joined = (lines: string[]): string => stripAnsi(lines.join("\n"));

const options = (over: Partial<CliOptions> = {}): CliOptions => ({
  repo: ".",
  head: "HEAD",
  hopBudget: 3,
  dryRun: false,
  yes: false,
  post: false,
  twoDot: false,
  onPush: false,
  force: false,
  ...over,
});

const spec: ReviewSpec = {
  agents: [
    { key: "reliability", file: "a.md", role: "hunter", model: "sonnet" },
    {
      key: "parity",
      file: "b.md",
      role: "hunter",
      model: "sonnet",
      trigger: ["packages/**"],
    },
    { key: "refuter", file: "c.md", role: "refuter", model: "opus" },
  ],
};

const agentFiles = new Map<string, ParsedAgent>();

const okGate: SizeGateVerdict = {
  ok: true,
  effectiveLines: 120,
  effectiveFiles: 4,
  excludedFiles: 0,
  excludedLines: 0,
};

const failedGate: SizeGateVerdict = {
  ok: false,
  reason: "lines",
  effectiveLines: 9000,
  effectiveFiles: 40,
  excludedFiles: 0,
  excludedLines: 0,
  limit: 800,
  message: "diff too big",
};

const diffStat = { files: 4, insertions: 90, deletions: 30 };

const planContext = (over: Partial<PlanContext> = {}): PlanContext => ({
  options: options(),
  repoRoot: "/tmp/pr-hero-fake-repo",
  baseRef: { ref: "main", source: "flag" },
  baseSha: "1111111111111111111111111111111111111111",
  diffFromSha: "2222222222222222222222222222222222222222",
  headSha: "3333333333333333333333333333333333333333",
  diffStat,
  diffPath: "/tmp/pr-hero-fake-repo/.prhero/runs/r1/diff.patch",
  agentsDir: "/tmp/agents",
  agentFiles,
  spec,
  runDir: "/tmp/pr-hero-fake-repo/.prhero/runs/local-abcdef",
  config: { parity_trigger_paths: ["packages/**"], suspicion_priors: [] },
  parityFires: true,
  codegraphAvailable: true,
  estimate: estimateCost(diffStat, 2),
  hunterCount: 2,
  sizeGate: okGate,
  droppedPaths: [],
  ...over,
});

const prPlanContext = (over: Partial<PrPlanContext> = {}): PrPlanContext => ({
  options: options({ pr: 6 }),
  operatorRoot: "/tmp/pr-hero-fake-repo",
  target: {
    number: 6,
    title: "terminal surface: print the findings",
    state: "OPEN",
    headSha: "3333333333333333333333333333333333333333",
    baseRef: "main",
    baseRefName: "main",
    baseSource: "base-branch",
    ghDiffStat: { files: 4, insertions: 90, deletions: 30 },
  },
  worktreePath: "/tmp/pr-hero-worktrees/pr-6",
  runDir: "/tmp/pr-hero-fake-repo/.prhero/runs/pr-6-17069c75-1",
  diffStat,
  agentsDir: "/tmp/agents",
  agentFiles,
  spec,
  config: { parity_trigger_paths: [], suspicion_priors: [] },
  estimate: estimateCost(diffStat, 2),
  hunterCount: 2,
  sizeGate: okGate,
  droppedPaths: [],
  ...over,
});

describe("renderPlan", () => {
  test("returns lines and prints nothing itself", () => {
    const lines = renderPlan(planContext(), false);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(8);
  });

  test("card, agent grid, both endpoints and the decision block, in order", () => {
    const lines = renderPlan(planContext(), false);
    const text = joined(lines);
    expect(lines[0]).toContain("╭─ pr-hero · review");
    expect(text).toContain("main..HEAD");
    expect(text).toContain("4 files  +90 −30");
    // Every spec agent, with the refuter's fixed trigger phrasing.
    expect(text).toContain("reliability");
    expect(text).toContain("per severe finding");
    // BOTH endpoints, short-sha'd — the rule the details view spells out.
    expect(text).toContain("main → 1111111111  (--base)");
    expect(text).toContain("2222222222 → 3333333333  (merge base)");
    expect(text).toContain("hop budget 3");
    // The decision block is LAST: gate verdict, then the money.
    const gateAt = lines.findIndex((l) => l.includes("size gate"));
    const moneyAt = lines.findIndex((l) => l.includes("estimate $"));
    expect(gateAt).toBeGreaterThan(0);
    expect(moneyAt).toBeGreaterThan(gateAt);
    expect(moneyAt).toBe(lines.length - 1);
  });

  test("a non-firing conditional hunter says so", () => {
    const text = joined(renderPlan(planContext({ parityFires: false }), false));
    expect(text).toContain("✗ will not fire");
  });

  test("--two-dot renames the range, and --force annotates a failed gate", () => {
    const text = joined(
      renderPlan(
        planContext({
          options: options({ twoDot: true, force: true }),
          sizeGate: failedGate,
        }),
        false,
      ),
    );
    expect(text).toContain("(--two-dot, two-point range)");
    expect(text).toContain("--force given: reviewing anyway.");
  });

  test("dropped paths are stated in the decision block", () => {
    const text = joined(
      renderPlan(planContext({ droppedPaths: ["bun.lock"] }), false),
    );
    expect(text).toContain("exclusions: 1 generated file(s) dropped");
    expect(text).toContain("diff.raw.patch");
  });

  test("styles off means not one escape byte; styles on paints", () => {
    expect(renderPlan(planContext(), false).join("\n")).not.toContain(ESC);
    expect(renderPlan(planContext(), true).join("\n")).toContain(ESC);
  });

  test("painting never changes the text, only the bytes around it", () => {
    expect(joined(renderPlan(planContext(), true))).toBe(
      joined(renderPlan(planContext(), false)),
    );
  });
});

describe("planDetails", () => {
  test("carries the full shas and the prose the card demoted", () => {
    const text = joined(planDetails(planContext(), false));
    expect(text.startsWith("details")).toBe(true);
    expect(text).toContain("1111111111111111111111111111111111111111");
    // Wrapped to the value column by row(), so the sentence is asserted in
    // the piece that cannot straddle the break.
    expect(text).toContain("merge base of main and");
    expect(text).toContain("only what this branch adds is reviewed");
    expect(text).toContain("bypassPermissions");
    expect(text).toContain("codegraph_explore is live");
  });

  test("--two-dot explains the reversal instead of the merge base", () => {
    const text = joined(
      planDetails(planContext({ options: options({ twoDot: true }) }), false),
    );
    expect(text).toContain("REVERSED");
    expect(text).not.toContain("merge base of");
  });

  test("a missing codegraph index is named, not implied", () => {
    const text = joined(
      planDetails(planContext({ codegraphAvailable: false }), false),
    );
    expect(text).toContain("NOT FOUND");
  });

  test("styles off means not one escape byte", () => {
    expect(planDetails(planContext(), false).join("\n")).not.toContain(ESC);
    expect(planDetails(planContext(), true).join("\n")).toContain(ESC);
  });
});

describe("renderPrPlan", () => {
  test("the PR card, its endpoints post-fetch, and the decision block", () => {
    const lines = renderPrPlan(
      prPlanContext({
        resolved: {
          baseSha: "1111111111111111111111111111111111111111",
          diffFromSha: "2222222222222222222222222222222222222222",
          diffPath: "/tmp/run/diff.patch",
          parityFires: false,
        },
      }),
      false,
    );
    const text = joined(lines);
    expect(lines[0]).toContain("╭─ pr-hero · PR #6");
    expect(text).toContain("terminal surface: print the findings");
    expect(text).toContain("OPEN · base main");
    expect(text).toContain("main → 1111111111  (PR base tip)");
    expect(text).toContain("2222222222 → 3333333333  (merge base)");
    expect(text).toContain("worktree will be created");
    expect(joined([lines[lines.length - 1] ?? ""])).toContain("estimate $");
  });

  test("pre-fetch the plan admits both unknowns instead of guessing", () => {
    const text = joined(renderPrPlan(prPlanContext(), false));
    expect(text).toContain("resolved after fetch");
    // The unresolved endpoint names the OPERATION, never a placeholder where a
    // sha belongs: a bare "?" was equally honest and read as a bug.
    expect(text).toContain(
      "merge base of main → 3333333333  (exact sha after fetch)",
    );
    expect(text).not.toContain("?");
    expect(text).toContain("decided by the diff after fetch");
  });

  test("gh counters are labelled as such", () => {
    const text = joined(renderPrPlan(prPlanContext(), false));
    expect(text).toContain("(gh counters)");
  });

  test("--post announces the one idempotent comment", () => {
    const text = joined(
      renderPrPlan(
        prPlanContext({ options: options({ pr: 6, post: true }) }),
        false,
      ),
    );
    expect(text).toContain("one marked PR comment");
  });

  test("an estimated gate verdict carries its note", () => {
    const text = joined(
      renderPrPlan(
        prPlanContext({
          sizeGate: failedGate,
          sizeGateNote: "(estimate from GitHub's aggregate counters)",
        }),
        false,
      ),
    );
    expect(text).toContain("size gate");
    expect(text).toContain("(estimate from GitHub's aggregate counters)");
  });

  test("styles off means not one escape byte; painting keeps the text", () => {
    expect(renderPrPlan(prPlanContext(), false).join("\n")).not.toContain(ESC);
    expect(renderPrPlan(prPlanContext(), true).join("\n")).toContain(ESC);
    expect(joined(renderPrPlan(prPlanContext(), true))).toBe(
      joined(renderPrPlan(prPlanContext(), false)),
    );
  });
});

describe("prPlanDetails", () => {
  test("names both roots and the resolved range", () => {
    const text = joined(
      prPlanDetails(
        prPlanContext({
          resolved: {
            baseSha: "1111111111111111111111111111111111111111",
            diffFromSha: "2222222222222222222222222222222222222222",
            diffPath: "/tmp/run/diff.patch",
            parityFires: true,
          },
        }),
        false,
      ),
    );
    expect(text).toContain("operator checkout; gh and git run here");
    expect(text).toContain("the PR's head commit");
    expect(text).toContain("2222222222222222222222222222222222222222");
    expect(text).toContain("bypassPermissions");
  });

  test("pre-fetch the diff row says where the band came from", () => {
    const text = joined(prPlanDetails(prPlanContext(), false));
    expect(text).toContain("band from gh; exact numstat after fetch");
    expect(text).toContain("resolved after fetch");
  });

  test("--post gets its own row", () => {
    const text = joined(
      prPlanDetails(
        prPlanContext({ options: options({ pr: 6, post: true }) }),
        false,
      ),
    );
    expect(text).toContain("idempotent — one comment per PR");
  });

  test("styles off means not one escape byte", () => {
    expect(prPlanDetails(prPlanContext(), false).join("\n")).not.toContain(ESC);
    expect(prPlanDetails(prPlanContext(), true).join("\n")).toContain(ESC);
  });
});
