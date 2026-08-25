// CI headless mode's reporter (ROADMAP Pillar 3, GitHub Actions): the pure
// half turns a review outcome into GitHub Actions workflow-command lines and
// `$GITHUB_STEP_SUMMARY` Markdown; the impure half appends those bytes to
// the two files GitHub Actions hands the job through the environment.
//
// Purity split, mirroring src/ui.ts's one documented impure pair
// (`styleEnabled()`/`terminalWidth()`): `formatWorkflowCommand`,
// `renderStepSummary`, and `formatCiOutputs` are total functions of their
// inputs — no file I/O, no `process.env` sniffing, no `log()` call. Every
// byte they need arrives as a parameter, so all three stay offline-testable
// and re-renderable from a stored artifact. `appendStepSummary` and
// `appendCiOutputs` are the ONLY functions in this module that touch the
// filesystem, and they do nothing but append the pure functions' output to
// a caller-supplied path — the exact shape GitHub Actions expects for
// `$GITHUB_STEP_SUMMARY` and `$GITHUB_OUTPUT` (both files a step appends to
// across multiple writes in the same job, never overwrites).
//
// Reuses report.ts/findings.ts rather than re-deriving their contracts:
// `Finding`/`Severity`/`Tier` (findings.ts) for finding shape, and
// `severityEmoji`, `blobUrl`, `formatElapsed`, `PrCommentDelta` (report.ts)
// for the emoji mapping, blob-link builder, compact duration format, and
// the re-review delta's data shape — the same severity glyph and blob URL a
// reader sees on the PR comment must be the one this job summary shows.
// `deltaLine`/`usd`/`code`/`severityRank` stay PRIVATE in report.ts, so this
// module writes small local equivalents rather than exporting report.ts
// internals for a single extra caller.

// Node's fs/promises, not Bun.write: Bun.write always OVERWRITES its target,
// and both $GITHUB_STEP_SUMMARY and $GITHUB_OUTPUT are files a single job
// step may append to more than once (progress groups, then a final summary;
// multiple output keys written across several tool calls). An overwrite here
// would silently destroy an earlier step's contribution to the same file.
import { appendFile } from "node:fs/promises";
import type { Finding, Severity } from "./findings";
import {
  blobUrl,
  formatElapsed,
  type PrCommentDelta,
  severityEmoji,
} from "./report";

// ---------------------------------------------------------------------------
// Workflow commands (`::group::`, `::endgroup::`, `::notice::`, `::warning::`,
// `::error::`) — https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
// ---------------------------------------------------------------------------

export type WorkflowCommandName =
  | "group"
  | "endgroup"
  | "notice"
  | "warning"
  | "error";

export interface WorkflowCommandOptions {
  file?: string;
  line?: number;
  endLine?: number;
  col?: number;
  endColumn?: number;
  title?: string;
}

// GitHub's documented data-escaping table for a command's message body.
function escapeData(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

// The property-value table additionally escapes `:` and `,` — those are the
// two characters the `key=value,key=value` property list itself uses as
// delimiters, so a raw one in a value (a Windows path's drive colon, a
// title with a comma) would silently split into the wrong property.
function escapeProperty(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

// Fixed emission order so the same options object always renders the same
// property string — a test asserting an exact command line would otherwise
// be at the mercy of `Object.entries`' insertion order at each call site.
const PROPERTY_ORDER = [
  "file",
  "line",
  "endLine",
  "col",
  "endColumn",
  "title",
] as const satisfies readonly (keyof WorkflowCommandOptions)[];

// Pure emitter for one GitHub Actions workflow-command line. `group` carries
// its title as the message (GitHub's own convention — `::group::<title>`
// has no property list); `endgroup` takes neither message nor properties.
export function formatWorkflowCommand(
  command: WorkflowCommandName,
  message = "",
  options?: WorkflowCommandOptions,
): string {
  if (command === "endgroup") return "::endgroup::";
  if (command === "group") return `::group::${escapeData(message)}`;
  const props = PROPERTY_ORDER.filter(
    (key) => options?.[key] !== undefined,
  ).map((key) => `${key}=${escapeProperty(String(options?.[key]))}`);
  const head =
    props.length > 0 ? `::${command} ${props.join(",")}::` : `::${command}::`;
  return `${head}${escapeData(message)}`;
}

// ---------------------------------------------------------------------------
// $GITHUB_STEP_SUMMARY — the job summary Markdown (spec 2.1).
// ---------------------------------------------------------------------------

// The three CiSummaryData members stay UNEXPORTED: `CiSummaryData` itself is
// the whole public contract a caller needs — a discriminated-union literal
// (`{ kind: "reviewed", ... }`) type-checks against it directly, exactly as
// every renderStepSummary test below constructs one. Exporting the members
// individually before a real caller needs to name one on its own would be
// an export for a hypothetical consumer (project rule 2) — Phase 3 either
// keeps using the union the same way or promotes exactly the member it
// needs, once it exists.
interface CiReviewSummary {
  kind: "reviewed";
  prNumber: number;
  headSha: string;
  findings: readonly Finding[];
  costUsdEst: number;
  wallMs: number;
  model: string;
  // Cosmetic and optional, same contract as renderPrComment's repoWebUrl
  // (report.ts): absent renders plain code spans instead of blob links.
  repoWebUrl?: string;
  delta?: PrCommentDelta;
}

interface CiSkipSizeSummary {
  kind: "skipped-size";
  prNumber: number;
  changedLines: number;
  changedFiles: number;
  maxChangedLines: number;
  maxChangedFiles: number;
}

interface CiSkipBudgetSummary {
  kind: "skipped-budget";
  prNumber: number;
  estimatedCostUsd: number;
  budgetUsd: number;
}

export type CiSummaryData =
  | CiReviewSummary
  | CiSkipSizeSummary
  | CiSkipBudgetSummary;

// Assistant-posture footer (spec 2.1: "Footer attributing pr-hero as an AI
// code review assistant"), shared by all three variants — the summary must
// carry the same "not a merge gate" register the PR comment's own footer
// does (renderPrComment, report.ts), even when the job was skipped.
const FOOTER =
  "<sub>pr-hero — AI code review assistant. Assistant report, not a merge gate.</sub>";

function severityRank(severity: Severity): number {
  switch (severity) {
    case "BLOCKER":
      return 0;
    case "CRITICAL":
      return 1;
    case "WARNING":
      return 2;
    case "SUGGESTION":
      return 3;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Grouped by file (spec 2.1: "grouped by file and severity tier"), sorted
// so the summary is deterministic regardless of hunter fan-out order: path
// ascending, then severity rank, then line. Map preserves insertion order,
// and every finding for a path is inserted contiguously because the source
// array is pre-sorted by path first — so iterating the map yields paths in
// alphabetical order without a second sort pass.
function groupFindingsByPath(
  findings: readonly Finding[],
): Map<string, Finding[]> {
  const sorted = [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const rankDiff = severityRank(a.severity) - severityRank(b.severity);
    if (rankDiff !== 0) return rankDiff;
    return a.line - b.line;
  });
  const groups = new Map<string, Finding[]>();
  for (const finding of sorted) {
    const existing = groups.get(finding.path);
    if (existing) existing.push(finding);
    else groups.set(finding.path, [finding]);
  }
  return groups;
}

function findingLine(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
): string {
  const loc = `${finding.path}:${finding.line}`;
  const linked =
    webUrl === undefined
      ? `\`${loc}\``
      : `[\`${loc}\`](${blobUrl(webUrl, headSha, finding.path, `L${finding.line}`)})`;
  return (
    `- ${severityEmoji(finding.severity)} ${finding.severity} · ` +
    `${finding.tier} — ${linked} — ${oneLine(finding.claim)}`
  );
}

// Local equivalent of report.ts's private `deltaLine` — same PrCommentDelta
// shape and wording, kept in sync by convention since that helper is not
// exported for a single extra caller (see module header).
function formatDeltaLine(delta: PrCommentDelta): string {
  const since =
    delta.previousHeadSha === undefined
      ? "Δ"
      : `Δ since \`${delta.previousHeadSha.slice(0, 8)}\``;
  if (delta.rereview !== undefined) {
    const r = delta.rereview;
    const parts: string[] = [];
    if (r.verifiedGone > 0) parts.push(`${r.verifiedGone} resolved (verified)`);
    parts.push(`${r.unconfirmed} unconfirmed`);
    parts.push(`${r.carried} carried`);
    parts.push(`${r.deferred} deferred`);
    parts.push(`${r.new} new`);
    return `${since}: ${parts.join(" · ")}`;
  }
  return `${since}: ${delta.resolved} resolved · ${delta.new} new · ${delta.persist} persist`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function skipSizeLines(data: CiSkipSizeSummary): string[] {
  return [
    `### ⚠️ pr-hero Review Skipped — PR #${data.prNumber}`,
    "",
    "**Reason:** the diff exceeds the configured size gate limits.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Changed lines | ${data.changedLines} (limit ${data.maxChangedLines}) |`,
    `| Changed files | ${data.changedFiles} (limit ${data.maxChangedFiles}) |`,
    "",
    "pr-hero did not run to avoid reviewing an unbounded diff. Split the " +
      "PR or raise `max-changed-lines` / `max-changed-files`.",
  ];
}

function skipBudgetLines(data: CiSkipBudgetSummary): string[] {
  return [
    `### ⚠️ pr-hero Review Skipped — PR #${data.prNumber}`,
    "",
    "**Reason:** the estimated cost exceeds the configured budget ceiling.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Estimated cost | ${usd(data.estimatedCostUsd)} (budget ${usd(data.budgetUsd)}) |`,
    "",
    "pr-hero did not run to stay within the configured `--budget-usd` " +
      "ceiling.",
  ];
}

function reviewedLines(data: CiReviewSummary): string[] {
  const blocking = data.findings.filter((f) => f.tier === "blocking");
  const advisory = data.findings.filter((f) => f.tier === "advisory");
  const out = [
    `### 🔍 pr-hero Review — PR #${data.prNumber}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Findings | ${data.findings.length} (${blocking.length} blocking · ` +
      `${advisory.length} advisory) |`,
    `| Estimated cost | ${usd(data.costUsdEst)} |`,
    `| Duration | ${formatElapsed(data.wallMs)} |`,
    `| Model | ${data.model} |`,
    "",
  ];
  if (data.findings.length === 0) {
    out.push("✅ No findings detected.");
  } else {
    out.push("#### Findings", "");
    for (const [filePath, group] of groupFindingsByPath(data.findings)) {
      out.push(`**\`${filePath}\`**`);
      for (const finding of group) {
        out.push(findingLine(finding, data.headSha, data.repoWebUrl));
      }
      out.push("");
    }
  }
  if (data.delta !== undefined) {
    out.push(formatDeltaLine(data.delta));
    out.push("");
  }
  return out;
}

// Formatted Markdown for `$GITHUB_STEP_SUMMARY` (spec 2.1). Pure — the
// caller supplies every byte, so the summary is re-renderable from a stored
// findings.json/comparison.json months later, same contract as
// renderReport/renderPrComment (report.ts).
export function renderStepSummary(data: CiSummaryData): string {
  const body =
    data.kind === "skipped-size"
      ? skipSizeLines(data)
      : data.kind === "skipped-budget"
        ? skipBudgetLines(data)
        : reviewedLines(data);
  const out = [...body, "---", "", FOOTER];
  return `${out.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// $GITHUB_OUTPUT — the action's structured outputs (spec 1.1).
// ---------------------------------------------------------------------------

export interface CiOutputs {
  status: string;
  findings_count: number;
  blocking_count: number;
  advisory_count: number;
  // Spec 1.1: "cost-usd-est: ... (float string, e.g. `"2.45"`)" — formatted
  // to 2 decimals here so every consumer of $GITHUB_OUTPUT reads the same
  // fixed-precision string the action.yml output contract promises.
  cost_usd_est: number;
  run_dir: string;
}

// Pure `key=value` line formatter for `$GITHUB_OUTPUT`. One name per line,
// GitHub Actions' own format for scalar outputs (no multiline heredoc
// delimiter needed — every value here is a single-line scalar).
export function formatCiOutputs(outputs: CiOutputs): string {
  const lines = [
    `status=${outputs.status}`,
    `findings_count=${outputs.findings_count}`,
    `blocking_count=${outputs.blocking_count}`,
    `advisory_count=${outputs.advisory_count}`,
    `cost_usd_est=${outputs.cost_usd_est.toFixed(2)}`,
    `run_dir=${outputs.run_dir}`,
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Impure edge — the ONLY functions in this module that touch the filesystem.
// ---------------------------------------------------------------------------

// Appends `markdown` to the file `$GITHUB_STEP_SUMMARY` points at, adding
// exactly one trailing newline when the caller's Markdown does not already
// end with one — GitHub renders the file as-is, and two summaries glued
// together without a newline between them would merge into one line.
export async function appendStepSummary(
  summaryFilePath: string,
  markdown: string,
): Promise<void> {
  const text = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  await appendFile(summaryFilePath, text);
}

// Appends `formatCiOutputs(outputs)` to the file `$GITHUB_OUTPUT` points at.
export async function appendCiOutputs(
  outputFilePath: string,
  outputs: CiOutputs,
): Promise<void> {
  await appendFile(outputFilePath, formatCiOutputs(outputs));
}
