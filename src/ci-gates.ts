// Bounded unattended spend (ROADMAP Pillar 3, GitHub Actions CI): the two
// gates that must clear BEFORE a CI run spawns a single agent, and the pure
// CI-mode skip payloads those gates produce when they don't.
//
// Phase 3 additions (this module's scope now covers the whole CI-mode
// policy layer, not just the two spend gates): `planCiSizeSkip`/
// `planCiBudgetSkip` are the ONE call reviewPr's shell makes per gate —
// comment + marker + step-summary markdown + $GITHUB_OUTPUT, all from the
// same numbers, so the shell has no decision left to make beyond "post it /
// write it". `budgetDisabledWarningMessage` covers spec 3.1's disabled-
// ceiling `::warning::` requirement. `ciExitCode` pins the assistant-posture
// exit-code contract (spec 2.1): findings, even blocking ones, never fail
// the job — only a fatal session failure or a genuine posting drop (design
// D6) does.
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
import {
  type CiOutputs,
  type CiSummaryData,
  renderStepSummary,
} from "./ci-reporter";
import {
  type CiReviewAdmissionVerdict,
  type CiReviewPolicyMode,
  ciAdmissionRemainingBudget,
  ciReviewManualRequiredDetail,
  ciReviewSkipDetail,
} from "./ci-review-admission";
import type { DeltaRiskAssessment } from "./ci-review-risk";
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

// Exported (Phase 3): both are legitimate consumers of these exact bytes —
// test/pr-preflight.test.ts's marker-prefix-disjointness registry (proving
// neither collides with PR_COMMENT/PR_FINDING/PR_STATE/TRIAGE, the pattern
// that test already established) and pr.ts's postPrComment, which now takes
// a `markerPrefix` parameter so a CI skip comment is idempotent — a second
// CI run on the same still-oversized PR (every `synchronize` push) updates
// the existing skip comment in place instead of stacking a new one. Both are
// self-closing, field-less tags (unlike the four `<!-- pr-hero-<noun> ` +
// trailing-space prefixes above): a skip decision has no code to anchor a
// `head=` declaration to, and no fields to encode — see the module header.
export const SKIP_SIZE_COMMENT_MARKER = "<!-- pr-hero-skip-size -->";
export const SKIP_BUDGET_COMMENT_MARKER = "<!-- pr-hero-skip-budget -->";
export const SKIP_COVERAGE_COMMENT_MARKER = "<!-- pr-hero-skip-coverage -->";
export const MANUAL_REQUIRED_COMMENT_MARKER =
  "<!-- pr-hero-manual-required -->";

// Same register as ci-reporter.ts's `skipSizeLines`/`skipBudgetLines` and
// project rule 4 (assistant posture): a gate skip is a courteous notice
// about SPEND, never a verdict on the diff's quality. "Split the PR" reads
// as a practical option, not a correction.
type SkipSizeSummary = Extract<CiSummaryData, { kind: "skipped-size" }>;
type SkipBudgetSummary = Extract<CiSummaryData, { kind: "skipped-budget" }>;
type SkipCoverageSummary = Extract<CiSummaryData, { kind: "skipped-coverage" }>;
type ManualRequiredSummary = Extract<
  CiSummaryData,
  { kind: "manual-required" }
>;

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

// ---------------------------------------------------------------------------
// Disabled-ceiling warning — spec 3.1: "Because a silent disable is
// indistinguishable from a passing gate, the CI shell MUST emit a
// `::warning::` workflow command noting that the budget ceiling is
// disabled." Only for an EXPLICIT <= 0 — `undefined` (the flag was never
// given) means no ceiling was ever configured, so there is nothing to warn
// about disabling. The shell wraps this message with
// `formatWorkflowCommand("warning", ...)` (ci-reporter.ts); this module only
// decides whether to and builds the text, never the annotation syntax.
// ---------------------------------------------------------------------------

export function budgetDisabledWarningMessage(
  budgetUsd: number | undefined,
): string | null {
  if (budgetUsd === undefined || budgetUsd > 0) return null;
  return (
    "budget-usd ceiling is disabled (<= 0 was configured); estimated cost " +
    "is unconstrained for this CI run. The size gate still applies " +
    "independently."
  );
}

// ---------------------------------------------------------------------------
// Route-aware ceiling resolution (issue #156). The budget gate compares
// `estimate.high` — a TOKEN-derived figure — against a real-dollar ceiling.
// On a Claude subscription route the real cash cost of a run is $0.00, so the
// shipped $10 default refused to do work over an overrun that cannot happen,
// and a skipped review is indistinguishable from a clean one to anyone
// reading the checks (this module's own doctrine, ~110-115; ci-setup.ts:50-63).
// So: no ceiling by default on a subscription route, the default ceiling on a
// metered one, and an explicit operator value honoured verbatim on either.
// ---------------------------------------------------------------------------

export type CiBillingMode = "subscription" | "metered";

// A non-empty ANTHROPIC_API_KEY means metered. Everything else, including an
// OAuth token, means subscription.
//
// This repo does NOT settle which credential actually bills when BOTH
// CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are present, and it is worth
// being explicit that the gap is real rather than papering over it:
// action.yml:111-112 binds both into the child env unconditionally,
// test/harness/env-projection.test.ts:48-56 deliberately asserts both survive
// the projection with no precedence between them, and `defaultClaudeAuthProbe`
// (provider-capabilities.ts:402-405) ORs them into a single boolean. Whichever
// one the Claude CLI itself prefers wins, and that fact is recorded nowhere in
// this codebase.
//
// This rule does not need that answer, because the two errors are not
// symmetric. Guess "unlimited" wrongly and a real invoice arrives that nobody
// authorized. Guess "ceiling" wrongly and one review is skipped, which the
// operator clears with a single line of YAML (`budget-usd: 0`). So the mere
// PRESENCE of a key keeps the ceiling: we cannot rule out that it bills.
// README.md:38-45 already states the user-facing half of the same rule —
// sourcing ANTHROPIC_API_KEY into the shell "is what moves a run from quota to
// invoice".
//
// Trimming is load-bearing, not defensive: action.yml:111 binds the input
// UNCONDITIONALLY and GitHub renders an unset input as the empty string, so
// every subscription-route CI run carries `ANTHROPIC_API_KEY=""`. Without the
// trim, no route would ever resolve as a subscription in Actions.
//
// This is deliberately NOT `provider-capabilities.ts`'s
// `CLAUDE_CAPABILITY_STATICS.billingMode` (:354-362), and the two must not be
// "unified" later. That constant is static `"subscription"` and making it
// derived is an ADMISSION hazard, verified before this was written: metered →
// `pricingApplicability: "required"` (production-runtime.ts:263) →
// `tokenPricingAvailable = report.billing.pricingReady || tokenPricingAvailableFor(...)`
// (production-runtime.ts), and NEITHER disjunct answers for a claude-code
// route whose model the bundled table misses: `pricingReady` is false on the
// claude-code CLI transport (claude-code-cli.ts) and on the backend-wide
// report producer (provider-capabilities.ts) → `pricing_table_missing` with
// `blocking: true` (provider-capabilities.ts). A metered
// claude-code route would be refused admission outright, which is strictly
// worse than the skipped review this function exists to prevent. This one
// answers a narrower question — "should CI impose a spend ceiling?" — and
// reaches nothing but the ceiling.
export function deriveCiBillingMode(
  env: Record<string, string | undefined>,
): CiBillingMode {
  return env.ANTHROPIC_API_KEY?.trim() ? "metered" : "subscription";
}

export const CI_DEFAULT_METERED_BUDGET_USD = 10;

export interface CiBudgetCeiling {
  // `undefined` means NO ceiling — the gate does not run at all. Distinct from
  // a `0` ceiling, which reaches `evaluateBudgetGate` and is allowed there by
  // the `<= 0` convention; the two arrive by different routes and the shell
  // announces them with different messages.
  budgetUsd: number | undefined;
  source: "operator" | "default-metered" | "unlimited-subscription";
}

// Total over the four cases. `source` exists so the caller can tell the two
// no-ceiling outcomes apart without re-deriving why.
//
// An explicitly configured value is honoured verbatim on ANY route — that is
// how an operator imposes a ceiling on a subscription (`budget-usd: 5`) or
// removes one on a metered route (`budget-usd: 0`, which still reaches
// `budgetDisabledWarningMessage`). The `configured !== undefined` test is what
// keeps 0 and negatives on the operator branch: falling back to a truthiness
// check would swallow the explicit disable and silently reimpose the $10 the
// operator just removed.
export function resolveCiBudgetCeiling(input: {
  configured: number | undefined;
  billingMode: CiBillingMode;
}): CiBudgetCeiling {
  if (input.configured !== undefined) {
    return { budgetUsd: input.configured, source: "operator" };
  }
  if (input.billingMode === "metered") {
    return {
      budgetUsd: CI_DEFAULT_METERED_BUDGET_USD,
      source: "default-metered",
    };
  }
  return { budgetUsd: undefined, source: "unlimited-subscription" };
}

// The loudness half. `unlimited-subscription` produces no ceiling and would
// otherwise be silent, which is the exact shape this module already refuses
// for the `<= 0` case: a disable is only safe when it is loud.
//
// Kept SEPARATE from `budgetDisabledWarningMessage`, and separate in register
// too — a NOTE, not a warning. The operator chose nothing wrong here; they
// configured nothing and the policy resolved. Merging the two would tell
// someone who never set `budget-usd` that they disabled something.
export function budgetUnlimitedNoticeMessage(
  ceiling: CiBudgetCeiling,
): string | null {
  if (ceiling.source !== "unlimited-subscription") return null;
  return (
    "no budget-usd ceiling was applied: this route authenticates against a " +
    "Claude subscription, where a run draws on quota rather than a " +
    "per-token invoice, so the estimated cost is not a dollar figure to " +
    "gate on. The size gate still applies independently. Set `budget-usd: " +
    "<n>` to impose a ceiling anyway."
  );
}

// ---------------------------------------------------------------------------
// CI skip plan — the ONE call reviewPr's shell makes per gate. Composes
// ciSizeGateSkip/ciBudgetGateSkip's {comment, summary} with renderStepSummary
// (ci-reporter.ts) and the $GITHUB_OUTPUT contract into everything the shell
// needs to publish, so the shell's own job is pure mechanical glue: post
// `comment` under `markerPrefix` if `--post`, append `summaryMarkdown` if
// step-summary is on, append `outputs` if $GITHUB_OUTPUT is set, return 0.
// ---------------------------------------------------------------------------

export interface CiGateSkipPlan {
  comment: string;
  // Fed to pr.ts's postPrComment as its `markerPrefix` — idempotent per gate
  // kind, so a repeat CI run on the same still-failing PR updates the
  // existing skip comment instead of stacking a new one on every push.
  markerPrefix: string;
  summaryMarkdown: string;
  outputs: CiOutputs;
}

// Spec 1.1's $GITHUB_OUTPUT contract for a skip: no review ran, so every
// finding count is 0 and there is no run dir. `estimatedCostUsd` is 0 for a
// size skip (the gate fires before any cost estimate exists) and the
// estimate that tripped the ceiling for a budget skip — the same number the
// comment and summary already show (this module's own "same numbers"
// doctrine, see the module header).
export function ciGateSkipOutputs(
  status:
    | "skipped-size"
    | "skipped-budget"
    | "skipped-coverage"
    | "manual-required",
  estimatedCostUsd: number,
): CiOutputs {
  return {
    status,
    findings_count: 0,
    blocking_count: 0,
    advisory_count: 0,
    cost_usd_est: estimatedCostUsd,
    run_dir: "",
  };
}

export function planCiSizeSkip(
  input: CiSizeGateSkipInput,
): CiGateSkipPlan | null {
  const skip = ciSizeGateSkip(input);
  if (skip === null) return null;
  return {
    comment: skip.comment,
    markerPrefix: SKIP_SIZE_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(skip.summary),
    outputs: ciGateSkipOutputs("skipped-size", 0),
  };
}

export function planCiBudgetSkip(
  input: CiBudgetGateSkipInput,
): CiGateSkipPlan | null {
  const skip = ciBudgetGateSkip(input);
  if (skip === null) return null;
  return {
    comment: skip.comment,
    markerPrefix: SKIP_BUDGET_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(skip.summary),
    outputs: ciGateSkipOutputs("skipped-budget", input.estimatedCostUsd),
  };
}

const COVERAGE_REASON_LABEL: Record<
  Extract<CiReviewAdmissionVerdict, { action: "skip" }>["reason"],
  string
> = {
  "same-head": "already reviewed at this commit",
  "once-per-pr": "once_per_pr policy allows one automatic review",
  "below-threshold": "prior findings below the re-review score floor",
  "low-risk-delta": "delta touches only low-risk paths",
};

function buildCoverageSkipComment(data: SkipCoverageSummary): string {
  const lines = [
    SKIP_COVERAGE_COMMENT_MARKER,
    "## pr-hero review skipped",
    "",
    "⚠️ This push did not justify another review run.",
    "",
    `**${data.detail}**`,
    "",
    `Prior score: ${data.priorScore} (re-review needs ≥ ${data.minScore}). ` +
      `Attempts on this PR: ${data.reviewCount}/${data.maxAttempts}.`,
    "",
    "The existing review comment still describes the last head pr-hero " +
      "reviewed. Push a fix for the posted findings, or run " +
      "`pr-hero review --pr <n> --post --force` locally to override.",
  ];
  return `${lines.join("\n")}\n`;
}

function buildManualRequiredComment(data: ManualRequiredSummary): string {
  const lines = [
    MANUAL_REQUIRED_COMMENT_MARKER,
    "## pr-hero review requires manual override",
    "",
    "🛑 Automatic review did not run on this push.",
    "",
    `**${data.detail}**`,
    "",
    `Attempts on this PR: ${data.reviewCount}/${data.maxAttempts}.`,
    "",
    "The existing review comment still describes the last head pr-hero " +
      "reviewed. To force another review, run " +
      "`pr-hero review --pr <n> --post --force` locally.",
  ];
  return `${lines.join("\n")}\n`;
}

export interface AdmissionContext {
  currentHead: string;
  reviewedHead: string | null;
  policyMode: CiReviewPolicyMode;
  policyHash: string;
  deltaRisk?: DeltaRiskAssessment | null;
}

function skipAdmissionSummaryFields(
  verdict: Extract<CiReviewAdmissionVerdict, { action: "skip" }>,
  context?: AdmissionContext,
): Partial<SkipCoverageSummary> {
  if (context === undefined) return {};
  return {
    decision: "skip",
    admissionReason: verdict.reason,
    currentHead: context.currentHead,
    reviewedHead: context.reviewedHead,
    riskClass: context.deltaRisk?.class,
    riskReason: context.deltaRisk?.reason,
    remainingBudget: ciAdmissionRemainingBudget(
      verdict.reviewCount,
      verdict.maxAttempts,
    ),
    policyMode: context.policyMode,
    policyHash: context.policyHash,
  };
}

function manualAdmissionSummaryFields(
  verdict: Extract<CiReviewAdmissionVerdict, { action: "manual-required" }>,
  context?: AdmissionContext,
): Partial<ManualRequiredSummary> {
  if (context === undefined) return {};
  return {
    decision: "manual-required",
    admissionReason: verdict.reason,
    currentHead: context.currentHead,
    reviewedHead: context.reviewedHead,
    riskClass: context.deltaRisk?.class,
    riskReason: context.deltaRisk?.reason,
    remainingBudget: ciAdmissionRemainingBudget(
      verdict.reviewCount,
      verdict.maxAttempts,
    ),
    policyMode: context.policyMode,
    policyHash: context.policyHash,
  };
}

export function planCiReviewSkip(input: {
  prNumber: number;
  verdict: Extract<CiReviewAdmissionVerdict, { action: "skip" }>;
  admission?: AdmissionContext;
}): CiGateSkipPlan {
  const detail = ciReviewSkipDetail(input.verdict);
  const summary: SkipCoverageSummary = {
    kind: "skipped-coverage",
    prNumber: input.prNumber,
    reason: COVERAGE_REASON_LABEL[input.verdict.reason],
    detail,
    priorScore: input.verdict.prior.score,
    minScore: input.verdict.minScore,
    reviewCount: input.verdict.reviewCount,
    maxAttempts: input.verdict.maxAttempts,
    ...skipAdmissionSummaryFields(input.verdict, input.admission),
  };
  return {
    comment: buildCoverageSkipComment(summary),
    markerPrefix: SKIP_COVERAGE_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(summary),
    outputs: ciGateSkipOutputs("skipped-coverage", 0),
  };
}

export function planCiReviewManualRequired(input: {
  prNumber: number;
  verdict: Extract<CiReviewAdmissionVerdict, { action: "manual-required" }>;
  admission?: AdmissionContext;
}): CiGateSkipPlan {
  const detail = ciReviewManualRequiredDetail(input.verdict);
  const summary: ManualRequiredSummary = {
    kind: "manual-required",
    prNumber: input.prNumber,
    reason:
      input.verdict.reason === "max-attempts-exhausted"
        ? "automatic attempt budget exhausted"
        : "manual_only policy",
    detail,
    priorScore: input.verdict.prior.score,
    reviewCount: input.verdict.reviewCount,
    maxAttempts: input.verdict.maxAttempts,
    ...manualAdmissionSummaryFields(input.verdict, input.admission),
  };
  return {
    comment: buildManualRequiredComment(summary),
    markerPrefix: MANUAL_REQUIRED_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(summary),
    outputs: ciGateSkipOutputs("manual-required", 0),
  };
}

// ---------------------------------------------------------------------------
// Assistant posture — spec 2.1: "The CLI MUST NOT exit with a non-zero code
// merely because findings (even `blocking` ones) were discovered ... exit
// non-zero ONLY on fatal execution failures." `blockingCount` is accepted
// and deliberately NEVER read: its only job is to let a test construct a
// high-blocking-count input and assert the result is still 0, so a future
// change that wires it into this function's logic (the exact regression
// this rule guards against) fails that test rather than shipping silently.
// ---------------------------------------------------------------------------

export function ciExitCode(input: {
  sessionFailed: boolean;
  droppedFindingIds: number;
  blockingCount: number;
}): 0 | 1 {
  if (input.sessionFailed) return 1;
  if (input.droppedFindingIds > 0) return 1;
  return 0;
}
