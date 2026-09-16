// CLI decomposition P2.1 (odd/tasks/cli-decomposition.md): the pure stages
// shared by `review()` and `reviewPr()` in cli.ts. A block detector found 28
// verbatim-duplicated blocks (205 lines) between the two orchestrators; they
// walk the same sequence of stages, and `reviewPr` interleaves PR-only ones
// around them. This module extracts the PURE stages only — no `await`, no
// I/O — so each one gets a test and replaces its copy in BOTH orchestrators.
//
// Design rule (accepted 2026-09-16, see the task doc's "Design decision"):
// compose, never unify with a mode flag. Where the two orchestrators diverge
// (the working root, index_ms, ...), the difference is an explicit parameter
// here, never a branch on an `isPr`-shaped flag.

import path from "node:path";
import type { Telemetry } from "#review/findings";
import type { PipelineResult } from "#review/pipeline";
import {
  CliError,
  type CliOptions,
  type SummarySettings,
} from "#review/preflight";
import type { AgentSpec } from "#review/spec";
import { scoutLabel, summarizerLabel } from "#ui/plan";

// Shared range guard. Both orchestrators check the same thing right after
// resolving base/head — the copies are byte-identical apart from
// indentation — and both throw before spending anything on a range that
// reviews nothing.
export function assertDistinctRange(baseSha: string, headSha: string): void {
  if (baseSha === headSha) {
    throw new CliError(
      `base and head resolve to the same commit (${headSha}); there is ` +
        "nothing to review",
    );
  }
}

// The gotchas file path: an explicit `--gotchas` flag always wins (resolved
// against cwd, exactly like path.resolve did inline); otherwise it is
// `<root>/.prhero/gotchas.md`. `root` is the caller's own root — repoRoot in
// review(), operatorRoot in reviewPr(), repoDir in doctor.ts's default-branch
// check — never resolved here, so this stays agnostic of which mode called
// it.
export function resolveGotchasPath(
  flag: string | undefined,
  root: string,
): string {
  return flag !== undefined
    ? path.resolve(flag)
    : path.join(root, ".prhero", "gotchas.md");
}

// Which hunters actually run: every unconditional hunter, plus every
// conditional (triggered) hunter when the parity trigger fired. Refuters are
// never included — they are a different role. Identical in both
// orchestrators; `reviewPr()`'s own `skipDiscovery` short-circuit to `[]`
// stays a call-site concern (a re-review with no delta to discover), not a
// parameter here.
export function selectActiveHunters(
  agents: readonly AgentSpec[],
  parityFires: boolean,
): AgentSpec[] {
  return agents.filter(
    (a) => a.role === "hunter" && (a.trigger === undefined || parityFires),
  );
}

// The one-line expectation printed just before the pipeline starts. Returns
// the string only — the orchestrator still calls log(), because withCiWorkflowGroup
// wraps the two call sites differently (PR mode groups it in a CI log group;
// local mode does not).
export function reviewingLine(
  hunterCount: number,
  summary: SummarySettings,
  options: Pick<CliOptions, "scout">,
): string {
  return (
    `reviewing — ${hunterCount} hunter${hunterCount === 1 ? "" : "s"} + ` +
    `refuter ${summarizerLabel(summary)}${scoutLabel(options)}; ` +
    "comparable trees have taken " +
    "8–25 minutes"
  );
}

// The Telemetry artifact built right after runPipeline returns. Identical in
// both orchestrators except `index_ms`: local mode hardcodes 0 (it neither
// builds nor syncs a codegraph index), PR mode passes the measured build
// time.
export function buildTelemetry(
  result: PipelineResult,
  wallMs: number,
  indexMs: number,
): Telemetry {
  return {
    index_ms: indexMs,
    index_mode: "sync",
    index_disk_mb: 0,
    // Driver-MEASURED elapsed time, never the sum of the steps: hunters run
    // in parallel, so summing their wall clocks reports a number the run
    // never took — and this engine exists to be compared on time and cost.
    wall_ms: wallMs,
    tokens_in: result.usage.tokens_in,
    tokens_out: result.usage.tokens_out,
    tokens_total: result.usage.tokens_total,
    cost_usd_est: result.usage.cost_usd_est,
    ...(result.unresolved.length > 0 ? { cost_usd_est_is_floor: true } : {}),
    per_agent: result.perAgent,
  };
}
