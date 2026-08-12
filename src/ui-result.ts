// The end-of-run result block, as LINES. Third member of the terminal
// surface's pure half (ui.ts formats, ui-select.ts asks, this one reports):
// same contract as both — everything is a total function of its inputs, the
// style flag arrives as a PARAMETER, and the I/O shell in cli.ts owns the
// printing and every exit code.
//
// WHY it exists at all: this block was written TWICE, once at the end of
// local mode and once at the end of PR mode, with different label padding and
// a `posted:` line that duplicated one already printed during the run. Two
// copies of the last thing an operator reads is two chances to drift, and
// neither copy could be tested because both were a run of `log()` calls
// inside a 400-line async shell. The mode-specific parts (comparison,
// worktree hint, extra artifacts) are optional inputs, not a second renderer.

import type { RunStatus } from "./findings";
import { row, shortPath } from "./ui";

// Counts only, from the caller's already-computed tally. Deliberately NOT the
// FindingsDocument: this half of the block reports the run, and taking the
// whole document here would invite it to start re-deriving numbers the shell
// already owns.
export interface ResultComparison {
  greptileFound: boolean;
  greptileOnly: number;
  both: number;
  prheroOnly: number;
}

export interface ResultWorktree {
  operatorRoot: string;
  worktreePath: string;
}

export interface ResultInput {
  runStatus: RunStatus;
  blocking: number;
  advisory: number;
  rootCauses: number;
  refuted: number;
  costUsd: number;
  wallMs: number;
  estimate: { low: number; high: number };
  // One directory plus the basenames written inside it. The full paths still
  // go to pipeline.json — three absolute paths sharing a 60-char prefix cost
  // three lines and carry one bit each (the shortPath rule, applied to the
  // place that motivated it).
  runDir: string;
  artifacts: string[];
  comparison?: ResultComparison;
  // PR mode only: the worktree is kept and reused BY DECISION, so the block
  // hands over the exact removal command. `worktree remove`, never `rm -rf` —
  // a live codegraph daemon holds .codegraph/daemon.sock.
  worktree?: ResultWorktree;
  sessionFailed: boolean;
  styles: boolean;
}

export function renderResult(input: ResultInput): string[] {
  const lines = [
    "",
    `run ${input.runStatus}: ${input.blocking} blocking, ` +
      `${input.advisory} advisory, ${input.rootCauses} distinct root ` +
      `cause(s), ${input.refuted} refuted`,
    `spent $${input.costUsd.toFixed(2)} in ` +
      `${Math.round(input.wallMs / 1000)}s (estimated ` +
      `$${input.estimate.low.toFixed(2)}–$${input.estimate.high.toFixed(2)})`,
    ...row("run dir", shortPath(input.runDir), { styles: input.styles }),
    ...row("artifacts", input.artifacts.join(" · "), {
      styles: input.styles,
    }),
  ];
  if (input.comparison) {
    lines.push(
      ...row(
        "comparison",
        `Greptile-only ${input.comparison.greptileOnly} · Both ` +
          `${input.comparison.both} · pr-hero-only ` +
          `${input.comparison.prheroOnly}` +
          (input.comparison.greptileFound
            ? ""
            : " — no Greptile comment on this PR"),
        { styles: input.styles },
      ),
    );
  }
  if (input.worktree) {
    lines.push(
      "worktree kept for finding-verification; remove it later with:",
      `  git -C ${input.worktree.operatorRoot} worktree remove --force ` +
        input.worktree.worktreePath,
    );
  }
  // The line that outranks every count above it. The exit code is the SHELL's
  // (return 1 in local mode, postingExitCode in PR mode) — this only says so.
  if (input.sessionFailed) {
    lines.push("every hunter failed — this run reviewed nothing.");
  }
  return lines;
}
