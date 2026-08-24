// Bounded unattended spend (ROADMAP Pillar 3, GitHub Actions CI): the two
// gates that must clear BEFORE a CI run spawns a single agent, and the pure
// CI-mode skip payloads those gates produce when they don't.
//
// This module does NOT reimplement the size gate — that gate (deterministic
// line/file counting, exclusion globs, the whole cost-predictability
// rationale) already exists in size-gate.ts and is already wired into local
// review, PR review and the watcher via `sizeGateDisposition`. What CI mode
// needs on top is different: outside CI, an over-limit diff can PROMPT an
// interactive operator or fall back to `--yes`/non-TTY `skip`; inside CI
// there is nobody to prompt AND the run must still exit 0 with a courteous
// PR notice (assistant posture — see proposal.md's Invariants). So this
// module adds exactly that CI-mode handling on top of an already-computed
// `SizeGateVerdict`, plus the budget gate's own threshold check (there is no
// pre-existing budget gate to reuse).
//
// Purity (project rule 1): every function here is a total function of its
// arguments. No file I/O, no `process.env` sniffing, no `log()`, no network,
// no clock. Posting the comment and writing `$GITHUB_STEP_SUMMARY` /
// `$GITHUB_OUTPUT` are impure edges that belong to the CI headless shell
// (Phase 3, src/pr.ts / src/cli.ts) — this module only builds the bytes.
//
// Reuse: `CiSummaryData` (ci-reporter.ts) is the exported contract for the
// step-summary payload. Its `skipped-size`/`skipped-budget` members stay
// UNEXPORTED there by design (see that module's header) — this file names
// them with `Extract<CiSummaryData, { kind: "..." }>` against the exported
// union rather than asking ci-reporter.ts to promote either member. Nothing
// here needed a member exported on its own: an object literal typed against
// the union already type-checks structurally (renderStepSummary's own tests
// construct `CiSummaryData` values in the exact same way), and `Extract`
// gives this module named, narrowed types for its own signatures without
// touching Phase 1's frozen module or its "promote on real need" comment.
// The two skip functions below build their `CiSummaryData` value through the
// SAME code path that also builds the PR comment, so the comment and the
// step summary can never independently drift on the numbers they report.
//
// PR comment marker: design.md's draft proposed a colon-style tag
// (`<!-- pr-hero:skip-size -->`). The convention actually shipped in this
// codebase is hyphenated and namespaced under `pr-hero-<noun>`
// (`PR_COMMENT_MARKER_PREFIX = "<!-- pr-hero-report "`,
// `PR_FINDING_MARKER_PREFIX = "<!-- pr-hero-finding "`,
// `PR_STATE_MARKER_PREFIX = "<!-- pr-hero-state "`,
// `TRIAGE_MARKER_PREFIX = "<!-- pr-hero-triage "` — pr-preflight.ts,
// rereview-state.ts, triage.ts). This module follows the shipped
// convention, not the draft: `<!-- pr-hero-skip-size -->` /
// `<!-- pr-hero-skip-budget -->`. Deliberately WITHOUT a `head=` field —
// unlike `prCommentMarker`, the two `CiSummaryData` skip members this phase
// builds from (already landed in Phase 1) carry no `headSha` at all, and a
// gate skip has no code to anchor a head declaration to. Wiring these
// markers into the idempotent find-or-create flow (`findMarkedCommentId`)
// is Phase 3's job, once a real poster exists to consume them.
import type { CiSummaryData } from "./ci-reporter";
import type { SizeGateVerdict } from "./size-gate";

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Budget gate — spec.md 3.1: "If estimated cost exceeds --budget-usd ...".
// The one comparison this module owns outright (no pre-existing gate to
// reuse, unlike size).
// ---------------------------------------------------------------------------

export interface BudgetGateVerdict {
  allowed: boolean;
  // Present only when `allowed` is false — mirrors SizeGateVerdict's own
  // discriminated shape (size-gate.ts) in spirit, kept optional-on-a-flat-
  // object here per the task's own stated signature rather than a second
  // discriminated union for a single string field.
  reason?: string;
}

// Inclusive boundary: a cost exactly AT the ceiling is allowed, matching
// size-gate.ts's own `>` (not `>=`) comparison against its limits.
//
// A non-positive ceiling DISABLES the gate. That is not this module's
// invention — size-gate.ts:20 already settled it for the sibling knobs
// ("<= 0 disables the limit. Both knobs, independently."), and all three
// ship side by side in one action.yml feeding one preflight, so `budget-usd:
// 0` has to mean what `max-changed-lines: 0` means. The external convention
// does cut the other way (a $0 spend cap elsewhere often means "spend
// nothing"), which is why it is written down here rather than assumed.
//
// What settles it is that the failure modes are not symmetric. Read as "no
// ceiling" when the operator meant "spend nothing", being wrong costs one
// visible review, still bounded by the size gate running independently. Read
// as "always skip" when the operator meant "no ceiling", being wrong makes
// pr-hero go dark on every PR while each run still exits 0 green — the same
// shape as a lint gate that checks nothing and passes, which this repo has
// already paid for once (docs/research/scout-design.md:344). A disable is only safe
// when it is loud, so the CI shell warns on a disabled ceiling.
export function evaluateBudgetGate(
  estimatedCostUsd: number,
  budgetUsd: number,
): BudgetGateVerdict {
  if (budgetUsd <= 0) return { allowed: true };
  if (estimatedCostUsd <= budgetUsd) return { allowed: true };
  return {
    allowed: false,
    reason:
      `estimated cost ${usd(estimatedCostUsd)} exceeds the ` +
      `${usd(budgetUsd)} budget ceiling`,
  };
}

// ---------------------------------------------------------------------------
// CI skip payloads — one PR comment + one step-summary payload, built from
// the SAME numbers so the two surfaces can't disagree.
// ---------------------------------------------------------------------------

export interface CiGateSkip {
  // Markdown for the PR comment. Posting it (or not, per `--post`) is the
  // caller's job.
  comment: string;
  // Feeds directly into ci-reporter.ts's `renderStepSummary`.
  summary: CiSummaryData;
}

const SKIP_SIZE_COMMENT_MARKER = "<!-- pr-hero-skip-size -->";
const SKIP_BUDGET_COMMENT_MARKER = "<!-- pr-hero-skip-budget -->";

// Same register as ci-reporter.ts's `skipSizeLines`/`skipBudgetLines` and
// project rule 4 (assistant posture): a gate skip is a courteous notice
// about SPEND, never a verdict on the diff's quality. "Split the PR" reads
// as a practical option, not a correction.
type SkipSizeSummary = Extract<CiSummaryData, { kind: "skipped-size" }>;
type SkipBudgetSummary = Extract<CiSummaryData, { kind: "skipped-budget" }>;

function buildSizeSkipComment(data: SkipSizeSummary): string {
  const lines = [
    SKIP_SIZE_COMMENT_MARKER,
    "## pr-hero review skipped",
    "",
    `⚠️ This diff changes ${data.changedLines} line(s) across ` +
      `${data.changedFiles} file(s), exceeding the configured size gate ` +
      `(max ${data.maxChangedLines} lines / ${data.maxChangedFiles} files).`,
    "",
    "pr-hero did not run to avoid reviewing an unbounded diff. Split the " +
      "PR or raise `max-changed-lines` / `max-changed-files` to review it " +
      "anyway.",
  ];
  return `${lines.join("\n")}\n`;
}

function buildBudgetSkipComment(data: SkipBudgetSummary): string {
  const lines = [
    SKIP_BUDGET_COMMENT_MARKER,
    "## pr-hero review skipped",
    "",
    `⚠️ The estimated review cost (${usd(data.estimatedCostUsd)}) exceeds ` +
      `the configured CI budget ceiling (${usd(data.budgetUsd)}).`,
    "",
    "pr-hero did not run to stay within the configured `--budget-usd` " +
      "ceiling.",
  ];
  return `${lines.join("\n")}\n`;
}

export interface CiSizeGateSkipInput {
  // Whether this run is in CI headless mode (Phase 3's `isCiEnvironment()`
  // / `--ci`). Outside CI, the existing `sizeGateDisposition` prompt/skip
  // flow (size-gate.ts) already handles an over-limit diff — this function
  // is a no-op there, on purpose, so the two paths cannot both fire.
  isCi: boolean;
  // The already-computed verdict (size-gate.ts's `evaluateSizeGate` /
  // `evaluateSizeGateAggregate`). This module never counts lines or files
  // itself.
  verdict: SizeGateVerdict;
  prNumber: number;
  // The configured ceilings, reported alongside whichever one the verdict
  // actually tripped — a verdict only carries the single `limit` that
  // failed (size-gate.ts), but the summary/comment show both metrics.
  maxChangedLines: number;
  maxChangedFiles: number;
}

// `null` means "nothing to publish": either this isn't a CI run, or the
// gate passed. Callers branch on `=== null`, never on truthiness of a
// partially-built object.
export function ciSizeGateSkip(input: CiSizeGateSkipInput): CiGateSkip | null {
  if (!input.isCi || input.verdict.ok) return null;
  const summary: SkipSizeSummary = {
    kind: "skipped-size",
    prNumber: input.prNumber,
    changedLines: input.verdict.effectiveLines,
    changedFiles: input.verdict.effectiveFiles,
    maxChangedLines: input.maxChangedLines,
    maxChangedFiles: input.maxChangedFiles,
  };
  return { comment: buildSizeSkipComment(summary), summary };
}

export interface CiBudgetGateSkipInput {
  isCi: boolean;
  estimatedCostUsd: number;
  budgetUsd: number;
  prNumber: number;
}

export function ciBudgetGateSkip(
  input: CiBudgetGateSkipInput,
): CiGateSkip | null {
  const verdict = evaluateBudgetGate(input.estimatedCostUsd, input.budgetUsd);
  if (!input.isCi || verdict.allowed) return null;
  const summary: SkipBudgetSummary = {
    kind: "skipped-budget",
    prNumber: input.prNumber,
    estimatedCostUsd: input.estimatedCostUsd,
    budgetUsd: input.budgetUsd,
  };
  return { comment: buildBudgetSkipComment(summary), summary };
}
