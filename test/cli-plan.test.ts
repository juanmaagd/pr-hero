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

// The width every case below renders at. Same value ui-result.test.ts pins,
// so the two halves of the terminal surface are asserted against one grid.
const PINNED_WIDTH = 80;
// Narrow enough to move the wrap points: at 40 columns the decision block's
// money line is two rows, not one, which is exactly the failure an unpinned
// width used to produce inside a split pane.
const NARROW_WIDTH = 40;

// The gap between the label column and the value column, checked WITHOUT
// hard-coding either width — a pin on "11" or "12" would have to be edited by
// whoever adds a longer label, which is precisely the person it exists to
// stop. The value column is read off the wrapped continuation lines (row()
// indents them to exactly it), and every label-bearing line must then have a
// space in the position just before it.
function expectEveryLabelKeepsItsGap(lines: string[]): void {
  const indents = lines
    .filter((line) => /^ {3,}\S/.test(line))
    .map((line) => line.match(/^ +/)?.[0].length ?? 0);
  expect(indents.length).toBeGreaterThan(0);
  const valueCol = Math.min(...indents);
  for (const line of lines) {
    if (!/^ {2}\S/.test(line)) continue;
    expect(line.length).toBeGreaterThan(valueCol);
    expect(line[valueCol - 1]).toBe(" ");
    expect(line[valueCol]).not.toBe(" ");
  }
}

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
  all: false,
  fixes: false,
  incidents: false,
  issues: false,
  proximity: false,
  threads: false,
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
  summary: { enabled: true, model: "haiku" },
  parityFires: true,
  codegraphAvailable: true,
  estimate: estimateCost(diffStat, 2, true),
  hunterCount: 2,
  sizeGate: okGate,
  droppedPaths: [],
  // PINNED, on every case. Without it these renderers measured
  // process.stdout.columns — the terminal that happened to be running the
  // suite — so an assertion like "the money line is the last line" passed in
  // an 80-column pane and failed in a 40-column one. See the determinism
  // block at the bottom of this file.
  width: PINNED_WIDTH,
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
  summary: { enabled: true, model: "haiku" },
  estimate: estimateCost(diffStat, 2, true),
  hunterCount: 2,
  sizeGate: okGate,
  droppedPaths: [],
  // Pinned for the reason PlanContext's is.
  width: PINNED_WIDTH,
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
    expect(text).toContain("summarizer");
    expect(text).toContain("haiku");
    expect(text).toContain("+ summarizer");
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

  test("a disabled summarizer is visible and not billed", () => {
    const text = joined(
      renderPlan(
        planContext({
          summary: { enabled: false, model: "opus" },
          estimate: estimateCost(diffStat, 2, false),
        }),
        false,
      ),
    );
    expect(text).toContain("summarizer");
    expect(text).toContain("opus");
    expect(text).toContain("disabled");
    expect(text).toContain("+ summarizer disabled");
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

  test("the widest label keeps its gap — permissions did not", () => {
    // The live run printed `permissionssteps run with --permission-mode…`:
    // "permissions" is exactly as wide as row()'s default label field, so
    // padEnd() gave it nothing and the two columns welded together.
    const lines = planDetails(planContext(), false).map(stripAnsi);
    expect(lines.some((l) => /^ {2}permissions +steps run with /.test(l))).toBe(
      true,
    );
    expectEveryLabelKeepsItsGap(lines);
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
    expect(text).toContain("summarizer");
    expect(text).toContain("haiku");
    expect(text).toContain("+ summarizer");
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
    expect(text).toContain("summarizer");
    expect(text).toContain("haiku");
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

  test("an interactive override annotates confirmed, not --force", () => {
    const text = joined(
      renderPrPlan(
        prPlanContext({
          sizeGate: failedGate,
          sizeGateConfirmed: true,
        }),
        false,
      ),
    );
    expect(text).toContain("confirmed: reviewing anyway.");
    expect(text).not.toContain("--force given");
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

  test("the widest label keeps its gap here too", () => {
    // The same collision, in the view that actually printed it live (PR mode's
    // details is what `review --pr 7` shows).
    const lines = prPlanDetails(
      prPlanContext({ options: options({ pr: 7, post: true }) }),
      false,
    ).map(stripAnsi);
    expect(lines.some((l) => /^ {2}permissions +steps run with /.test(l))).toBe(
      true,
    );
    expectEveryLabelKeepsItsGap(lines);
  });
});

// ---------------------------------------------------------------------------
// The regression these four renderers were written to have and did not: WIDTH
// AS A PARAMETER. Before this block they passed no width at all, so every
// row() and box() inside them — including the ones under decisionLines,
// markerRowLines, planDetails and prPlanDetails — fell back to ui.ts's
// terminalWidth() and measured whatever terminal ran `bun test`. The suite was
// therefore green at 80 columns and red in a ~40-column pane, on assertions
// about wrap points nobody could stub.
//
// `process.stdout.columns` is stubbed rather than COLUMNS= set: the env var
// does not reach process.stdout.columns when stdout is a pipe, so it would
// prove nothing. stderr is stubbed too, because terminalWidth() falls through
// to it. Restored in a finally — bun runs a file's tests in one process, and a
// leaked stub would poison every other suite.
function stubColumns(columns: number): () => void {
  const streams = [process.stdout, process.stderr];
  const saved = streams.map((s) =>
    Object.getOwnPropertyDescriptor(s, "columns"),
  );
  for (const stream of streams) {
    Object.defineProperty(stream, "columns", {
      value: columns,
      configurable: true,
      writable: true,
    });
  }
  return () => {
    streams.forEach((stream, i) => {
      const descriptor = saved[i];
      if (descriptor === undefined) {
        delete (stream as { columns?: number }).columns;
        return;
      }
      Object.defineProperty(stream, "columns", descriptor);
    });
  };
}

// The same context with the width taken back off, to exercise the one
// remaining fallback (the renderer's own entry point) on purpose.
function unpinned<T extends { width?: number }>(ctx: T): T {
  const copy = { ...ctx };
  delete copy.width;
  return copy;
}

describe("plan renderers are deterministic offline", () => {
  test("the pinned width, not the terminal, decides the layout", () => {
    const before = {
      plan: renderPlan(planContext(), false),
      planDetails: planDetails(planContext(), false),
      prPlan: renderPrPlan(prPlanContext(), false),
      prPlanDetails: prPlanDetails(prPlanContext(), false),
    };
    const restore = stubColumns(NARROW_WIDTH);
    try {
      expect(renderPlan(planContext(), false)).toEqual(before.plan);
      expect(planDetails(planContext(), false)).toEqual(before.planDetails);
      expect(renderPrPlan(prPlanContext(), false)).toEqual(before.prPlan);
      expect(prPlanDetails(prPlanContext(), false)).toEqual(
        before.prPlanDetails,
      );
    } finally {
      restore();
    }
  });

  test("a different width really does change the output", () => {
    const wide = renderPlan(planContext(), false);
    const narrow = renderPlan(planContext({ width: NARROW_WIDTH }), false);
    expect(narrow).not.toEqual(wide);
    expect(narrow.length).toBeGreaterThan(wide.length);
    // The decision block is where the old flakiness lived: at 80 columns the
    // money line is one row (and therefore the last line), at 40 it wraps to
    // two — the exact assertion that used to fail for no reason but the pane.
    const wideMoney = wide.filter((l) => l.includes("estimate $"));
    expect(wideMoney).toHaveLength(1);
    expect(wide.indexOf(wideMoney[0] ?? "")).toBe(wide.length - 1);
    expect(narrow[narrow.length - 1]).not.toContain("estimate $");
  });

  test("every renderer threads the width all the way down", () => {
    // No width in the context: the entry point's terminalWidth() fallback
    // fires, and the result must be byte-identical to the same width pinned.
    // Anything inside these renderers still reaching for its own width would
    // break this, which is what makes it a threading test and not a restating
    // of the fallback.
    const restore = stubColumns(NARROW_WIDTH);
    try {
      expect(renderPlan(unpinned(planContext()), false)).toEqual(
        renderPlan(planContext({ width: NARROW_WIDTH }), false),
      );
      expect(planDetails(unpinned(planContext()), false)).toEqual(
        planDetails(planContext({ width: NARROW_WIDTH }), false),
      );
      expect(renderPrPlan(unpinned(prPlanContext()), false)).toEqual(
        renderPrPlan(prPlanContext({ width: NARROW_WIDTH }), false),
      );
      expect(prPlanDetails(unpinned(prPlanContext()), false)).toEqual(
        prPlanDetails(prPlanContext({ width: NARROW_WIDTH }), false),
      );
    } finally {
      restore();
    }
  });

  test("a failed gate with exclusions stays deterministic too", () => {
    // The longest decision block there is: gate verdict, exclusion note,
    // --force note, money. Every one of those four goes through
    // markerRowLines, so this is the case that catches a missed width
    // argument on any of them.
    const ctx = planContext({
      options: options({ force: true }),
      sizeGate: failedGate,
      droppedPaths: ["bun.lock", "dist/app.js"],
    });
    const pinned = renderPlan(ctx, false);
    const restore = stubColumns(NARROW_WIDTH);
    try {
      expect(renderPlan(ctx, false)).toEqual(pinned);
    } finally {
      restore();
    }
    expect(renderPlan({ ...ctx, width: NARROW_WIDTH }, false)).not.toEqual(
      pinned,
    );
  });
});
