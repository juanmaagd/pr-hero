// The end-of-run result block. Written twice (once per mode) and testable in
// neither until WU4 pulled it into one pure renderer — so these are the first
// assertions the last thing an operator reads has ever had.

import { describe, expect, test } from "bun:test";
import { type ResultInput, renderResult } from "../src/ui-result";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const joined = (lines: string[]): string => stripAnsi(lines.join("\n"));

const input = (over: Partial<ResultInput> = {}): ResultInput => ({
  runStatus: "complete",
  blocking: 1,
  advisory: 0,
  rootCauses: 1,
  refuted: 0,
  costUsd: 4.09,
  wallMs: 327_000,
  estimate: { low: 3.5, high: 5.25 },
  runDir: "/tmp/pr-hero-runs/pr-6-17069c75-1",
  artifacts: ["report.md", "findings.json"],
  sessionFailed: false,
  styles: false,
  ...over,
});

describe("renderResult", () => {
  test("the counts line keeps its wording, run_status included", () => {
    expect(joined(renderResult(input()))).toContain(
      "run complete: 1 blocking, 0 advisory, 1 distinct root cause(s), 0 refuted",
    );
  });

  test("a partial run says partial, never complete", () => {
    const text = joined(renderResult(input({ runStatus: "partial" })));
    expect(text).toContain("run partial:");
    expect(text).not.toContain("run complete:");
  });

  test("spend is reported against the band that was confirmed", () => {
    expect(joined(renderResult(input()))).toContain(
      "spent $4.09 in 327s (estimated $3.50–$5.25)",
    );
  });

  test("ONE run dir plus the basenames, never three absolute paths", () => {
    const text = joined(
      renderResult(
        input({
          artifacts: ["report.md", "findings.json", "comparison.md"],
        }),
      ),
    );
    expect(text).toContain("report.md · findings.json · comparison.md");
    // The prefix appears exactly once, on the run-dir row.
    const hits = text.split("/tmp/pr-hero-runs/pr-6-17069c75-1").length - 1;
    expect(hits).toBe(1);
  });

  test("local mode: no comparison row, no worktree hint", () => {
    const text = joined(renderResult(input()));
    expect(text).not.toContain("comparison");
    expect(text).not.toContain("worktree");
  });

  test("the comparison row carries the three buckets", () => {
    const text = joined(
      renderResult(
        input({
          comparison: {
            greptileFound: true,
            greptileOnly: 2,
            both: 1,
            prheroOnly: 3,
          },
        }),
      ),
    );
    expect(text).toContain("Greptile-only 2 · Both 1 · pr-hero-only 3");
    expect(text).not.toContain("no Greptile comment");
  });

  test("a PR Greptile never commented on says so, so 0 is not read as a miss", () => {
    // The note wraps to the value column at 80 columns, so it is asserted in
    // the piece that cannot straddle the break.
    const text = joined(
      renderResult(
        input({
          comparison: {
            greptileFound: false,
            greptileOnly: 0,
            both: 0,
            prheroOnly: 1,
          },
        }),
      ),
    );
    expect(text).toContain("— no Greptile comment on");
    expect(text).toContain("this PR");
  });

  test("the worktree hint hands over worktree remove, never rm -rf", () => {
    const text = joined(
      renderResult(
        input({
          worktree: { operatorRoot: "/repo", worktreePath: "/wt/pr-6" },
        }),
      ),
    );
    expect(text).toContain("worktree kept for finding-verification");
    expect(text).toContain("git -C /repo worktree remove --force /wt/pr-6");
    expect(text).not.toContain("rm -rf");
  });

  test("no `posted:` line — step 14 already printed one during the run", () => {
    const text = joined(
      renderResult(input({ artifacts: ["report.md", "post.json"] })),
    );
    expect(text).not.toContain("posted:");
    // The durable trace is the receipt in the artifact list instead.
    expect(text).toContain("post.json");
  });

  test("a dead session says so, last, after every count", () => {
    const lines = renderResult(input({ sessionFailed: true }));
    expect(lines[lines.length - 1]).toBe(
      "every hunter failed — this run reviewed nothing.",
    );
  });

  test("a live session never claims one failed", () => {
    expect(joined(renderResult(input()))).not.toContain("every hunter failed");
  });

  test("styles off means not one escape byte; styles on paints", () => {
    expect(renderResult(input()).join("\n")).not.toContain(ESC);
    expect(renderResult(input({ styles: true })).join("\n")).toContain(ESC);
  });

  test("painting changes the bytes around the text, never the text", () => {
    expect(joined(renderResult(input({ styles: true })))).toBe(
      joined(renderResult(input())),
    );
  });

  test("returns lines and prints nothing itself", () => {
    const lines = renderResult(input());
    expect(Array.isArray(lines)).toBe(true);
    // Leading blank: the block separates itself from the progress panel above.
    expect(lines[0]).toBe("");
  });
});
