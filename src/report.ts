// The human-facing half of local mode (ROADMAP B0): a pure renderer that
// turns a findings document into the markdown a developer actually reads, and
// a pure cost estimator that runs BEFORE the money is spent.
//
// Pure on purpose — no I/O, no git, no clock. The CLI owns every side effect,
// so the report can be re-rendered from an artifact on disk months later and
// come out byte-identical (the lab already replays old findings.json files;
// a renderer that reached for `new Date()` would make that a lie).

import type { Finding, FindingsDocument, Severity, Tier } from "./findings";
import { findingMarker, prCommentMarker } from "./pr-preflight";
import {
  clusterByRootCause,
  extractAnchor,
  type RootCauseSummary,
  rootCauseIdByFinding,
} from "./root-cause";

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface CostEstimate {
  low: number;
  high: number;
  // Plain-language statement of how coarse this is, meant to be printed next
  // to the numbers so nobody reads the band as a quote.
  basis: string;
}

// Per-hunter marginal cost, fitted to the measured runs (see BAND below).
// Deliberately three transparent coefficients instead of a regression: with
// this few calibration points anything fancier is false precision.
//
// The base is the load-bearing coefficient, recalibrated 2026-08-11 from
// 0.5 to 1.2: a hunter's floor is reading the TREE and the prompt
// machinery, nearly independent of a small diff. The proof was two PR-mode
// runs of the same 7-file / +21 −8 tree billing $4.74 and $3.92 against a
// $1.19–$2.39 band — both ~2x above the top, the exact under-estimate
// failure this band exists to prevent.
const USD_PER_AGENT_BASE = 1.2;
const USD_PER_CHANGED_LINE = 0.00021;
const USD_PER_FILE = 0.008;

// Skewed on purpose. Every recorded overrun was an UNDER-estimate, never
// over, so the upper arm is the wider one: a band that is too generous costs
// a second of hesitation, a band that is too tight costs real money.
const BAND_LOW = 0.65;
const BAND_HIGH = 1.4;

// WHY this function exists at all: the ROADMAP logs two cost overruns in a
// row — "~$21" against an actual bill, and "~$34" against an actual $48.30 —
// and both had the same cause. The estimate was carried over from the
// PREVIOUS arm instead of being computed from the tree about to be reviewed.
// So this estimates from the diff, and only from the diff.
//
// Calibration points, all measured on real runs of the current engine:
//   - PR 1682's tree (7 files / +21 −8, 3 hunters + refuter) billed $4.74
//     and $3.92 across two runs — the per-agent floor evidence;
//   - a 45-file / +2775 −1237 tree with 5 hunters + refuter billed ~$14.78,
//     and the same tree was recorded at ~$11/run elsewhere in the campaign;
//   - the first B0 local run (5 files / +484, 4 hunters + refuter), $3.68.
// A legacy "~$2.61 small tree" point from before PR mode existed was
// RETIRED by the 1682 evidence: two same-engine runs of a comparable tree
// both landed far above it, and a calibration point the instrument itself
// contradicts is decoration. The ~$11 vs ~$14.78 spread on ONE tree is the
// whole argument for returning a band: the same diff, the same agents, a
// 34% swing. A point estimate here would be a fiction with a decimal point.
//
// The refuter is not a separate term: its cost rides in the coefficients,
// because every calibration run had the refuter leg included and a
// refuter's size tracks how much the hunters found, which tracks diff size.
export function estimateCost(
  diffStat: DiffStat,
  hunterCount: number,
  summarizerEnabled = false,
): CostEstimate {
  const files = Math.max(0, diffStat.files);
  const lines =
    Math.max(0, diffStat.insertions) + Math.max(0, diffStat.deletions);
  // A validated ReviewSpec always carries at least one hunter, so a zero here
  // means a caller asked hypothetically. Clamping keeps the band from
  // collapsing to $0–$0, which would read as "this is free".
  const agents = Math.max(1, hunterCount + (summarizerEnabled ? 1 : 0));
  const mid =
    agents *
    (USD_PER_AGENT_BASE + USD_PER_CHANGED_LINE * lines + USD_PER_FILE * files);
  return {
    low: round2(mid * BAND_LOW),
    high: round2(mid * BAND_HIGH),
    basis:
      "coarse band from measured runs (a 7-file / +21 −8 tree with 3 " +
      "hunters + refuter, $3.92–$4.74 across two runs; a 45-file / " +
      "+2775 −1237 tree with 5 hunters + refuter, ~$11–$14.78): a " +
      `per-agent floor for hunters + refuter${summarizerEnabled ? " + summarizer" : ""} ` +
      "plus changed lines and files. An order-of-magnitude " +
      "guide, not a quote — the same tree has billed 34% apart across runs.",
  };
}

export interface ReportMeta {
  repo: string;
  base: string;
  head: string;
  // The stat of the EFFECTIVE diff — the one the hunters were handed, with
  // generated content already excluded. Never the raw range's stat: a report
  // that claims 5000 changed lines beside a review of 40 of them is lying
  // about what was read.
  diffStat: DiffStat;
  // Paths the exclusion filter dropped from the reviewed diff, if any. Stated
  // in the report because it is a mutation of the input, not a detail.
  excludedPaths?: string[];
  costUsd: number;
  wallMs: number;
}

// What the report needs from a per-agent telemetry row. Telemetry.per_agent's
// DECLARED value type is the lab-shared minimum (tokens_total + duration_ms),
// but this engine writes the richer PerAgentUsage, which carries `status`.
// Read through a runtime check rather than widening the shared schema type:
// the report stays useful on a rich document AND on an old lab artifact that
// only ever had the two fields, and neither one throws.
interface AgentRow {
  key: string;
  status: string;
}

function agentRows(doc: FindingsDocument): AgentRow[] {
  const perAgent = doc.telemetry.per_agent;
  if (!perAgent) return [];
  return Object.entries(perAgent).map(([key, value]) => {
    const status = (value as { status?: unknown }).status;
    return { key, status: typeof status === "string" ? status : "ran" };
  });
}

// The coverage sentence behind every incompleteness notice (GitHub #42,
// ROADMAP-DOORDASH M1). Shared with ui-result.ts — exported for the same
// reason blobUrl below is: the public comment and the terminal must name the
// SAME agents from the SAME bytes, and two derivations of "who did not
// finish" is exactly how one surface starts under-reporting the other.
// `quote` is the only difference between them (backticks in markdown, bare
// text on a terminal), so the prose itself is written once.
//
// WHY "agents" and not "hunters", which is the word the issue uses: the
// document does not record roles. `telemetry.per_agent` is keyed by
// AgentSpec.key and carries a status, but nothing in it says which key was a
// hunter — the refuter and the summarizer sit in the same map (pipeline.ts
// writes `refuter` and `summary` rows there). Excluding those two keys by
// name would be a hardcoded list that (a) breaks the moment a spec renames
// the refuter and (b) would print "all hunters completed" on a run that went
// partial BECAUSE the refuter died, which is the under-disclosure this whole
// notice exists to prevent. So every agent is named, and the prose says
// agent. Over-naming costs a word; under-naming costs the guarantee.
//
// Statuses are printed VERBATIM rather than bucketed into failed/ok: an old
// lab artifact whose rows predate the `status` field reads as "ran"
// (agentRows' fallback), and bucketing that into "failed" would invent a
// failure the run never recorded.
export function coverageSentence(
  doc: FindingsDocument,
  quote: (key: string) => string,
): string {
  const rows = agentRows(doc);
  const completed = rows.filter((r) => r.status === "ok").map((r) => r.key);
  const lost = rows.filter((r) => r.status !== "ok");
  // A partial run can name nobody at all, and the notice still has to be
  // honest about that instead of printing an empty list: the gotchas
  // early-return produces `run_status: "partial"` with an EMPTY per_agent map
  // (pipeline.ts), a pipeline timeout abandons in-flight steps whose rows are
  // never written, and a pre-v2 artifact has no per_agent at all. "Did not
  // complete: (none)" on any of those would read as "everything ran".
  const done =
    completed.length === 0
      ? "No agent is recorded as completed."
      : `Completed: ${completed.map(quote).join(", ")}.`;
  if (lost.length === 0) {
    return `${done} The run record does not name which agents were lost.`;
  }
  const missing = lost.map((r) => `${quote(r.key)} (${r.status})`).join(", ");
  return `${done} Did not complete: ${missing}.`;
}

type RenderableSummary = NonNullable<FindingsDocument["summary"]>;

function summaryLines(summary: RenderableSummary): string[] {
  return [
    "### Summary",
    "",
    oneLine(summary.prose),
    "",
    `**Confidence: ${summary.score}/5** — ${oneLine(summary.score_reason)}`,
  ];
}

export function renderReport(doc: FindingsDocument, meta: ReportMeta): string {
  const summary = doc.debug.root_causes ?? clusterByRootCause(doc.findings);
  const out: string[] = [];
  out.push(`# Review — ${meta.repo} ${meta.base}..${meta.head}`);
  out.push("");
  out.push(...runLines(doc, meta));
  if (doc.summary !== undefined) {
    out.push("");
    out.push(...summaryLines(doc.summary));
  }
  out.push("");
  out.push(...section("Blocking", doc, "blocking", summary));
  out.push("");
  out.push(...section("Advisory", doc, "advisory", summary));
  out.push("");
  out.push(...notReported(doc));
  out.push("");
  out.push(...closing(doc));
  // Trailing newline: these strings are written straight to report.md, and a
  // file without one makes every diff of a regenerated report noisy.
  return `${out.join("\n").trimEnd()}\n`;
}

// The deterministic delta line (ROADMAP B6, design D5): computed by
// inline.ts's matcher from the live comment stream, never from a stored
// count. `previousHeadSha` is the PRIOR summary marker's `head=` value — free
// because the marker already carries it — and is absent on the very first
// run (no prior marked comment exists yet) or against a pre-B3 markerless
// comment (no `head=` to parse). Both cases render the counts WITHOUT a
// "since <sha>" clause rather than omitting the line: spec's own "First-ever
// run" scenario requires `0 resolved · K new · 0 persist` to be visible, not
// silent, on the first post.
export interface PrCommentDelta {
  resolved: number;
  new: number;
  persist: number;
  previousHeadSha?: string;
}

// One consistent severity → emoji mapping (Juanma's PR #2 feedback), shared
// by the summary's headline/index AND every per-finding body — a reader
// who learns 🔴 means BLOCKER/CRITICAL in one place must see the SAME
// mapping everywhere, or the emoji becomes noise instead of a scan aid.
// BLOCKER and CRITICAL share one glyph on purpose: both are the severities
// that can ever reach `tier: "blocking"` (deriveTier, findings.ts), so this
// is the same grouping the engine's own gate already makes. Used by the
// summary HEADLINE, which still counts by hunter severity (PR #2: a
// tier-based "0 blocking" hid that both findings were genuinely CRITICAL).
export function severityEmoji(severity: Severity): string {
  switch (severity) {
    case "BLOCKER":
    case "CRITICAL":
      return "🔴";
    case "WARNING":
      return "🟡";
    case "SUGGESTION":
      return "🔵";
  }
}

// GitHub #19 W0: the posted scan aid follows `tier`, not hunter severity.
// A BLOCKER/CRITICAL that deriveTier already made advisory must not scream
// 🔴 — that glyph is reserved for findings that can still block. SUGGESTION
// keeps its own 🔵 so hygiene stays distinct from a real-but-not-blocking
// WARNING (or a demoted CRITICAL). Does not change what was found; the
// hunter's severity word still sits in the header after the tier.
export function scanAidEmoji(
  finding: Pick<Finding, "severity" | "tier">,
): string {
  if (finding.tier === "blocking") return "🔴";
  if (finding.severity === "SUGGESTION") return "🔵";
  return "🟡";
}

// Priority order for the summary's compact index (Juanma: "priority ordering
// actually works" here — inline comments themselves sort by GitHub's own
// file/line order, not ours). Lower rank sorts first.
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

const LEAD_IN_MAX = 100;

// A short, single-line preview of a finding's claim for the summary's
// index — the claim's full text belongs on the finding's own comment, not
// duplicated here (the ROADMAP B6 "one finding, one place" decision this
// index partially reinstates — see renderPrComment's own WHY). Truncates at
// a word boundary so the ellipsis never lands mid-word.
function leadIn(claim: string): string {
  const text = oneLine(claim);
  if (text.length <= LEAD_IN_MAX) return text;
  const truncated = text.slice(0, LEAD_IN_MAX);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}

// The summary's one-line-per-finding index (Juanma's PR #2 feedback item 1:
// the earlier "one finding, one place" decision stripped this list entirely,
// leaving counts + delta + footer — on first contact that reads as empty).
// This partially reverses that decision, but the coherence obligation it
// reinstates is much smaller than the pre-B6 shape: a ONE-LINE index plus
// links, not a duplicated claim/evidence body, and the delta already had to
// be correct. `commentUrlByFindingId` is absent (or a finding's id is
// missing from it) before ids exist — the FIRST render of a freshly created
// summary, before any per-finding comment has been posted — in which case
// the line renders without a link; the closing PATCH (cli.ts) supplies the
// map once posting has happened.
function findingIndexLines(
  findings: Finding[],
  commentUrlByFindingId: ReadonlyMap<string, string> | undefined,
): string[] {
  const sorted = [...findings].sort((a, b) => {
    const rankDiff = severityRank(a.severity) - severityRank(b.severity);
    if (rankDiff !== 0) return rankDiff;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  return sorted.map((f) => {
    const loc = code(`${f.path}:${f.line}`);
    const url = commentUrlByFindingId?.get(f.id);
    const locRef = url === undefined ? loc : `[${loc}](${url})`;
    return `${scanAidEmoji(f)} ${locRef} — ${leadIn(f.claim)}`;
  });
}

// The PR-comment renderer (ROADMAP B2): the same findings document, shaped
// for a public GitHub comment instead of a run artifact. Pure for the same
// reason renderReport is — a posted comment must be re-renderable from the
// artifact and come out identical.
//
// Deliberately SPARSER than report.md: NO cost, NO token counts, no
// telemetry of any kind — the engine's internal economics never reach a
// public comment.
//
// The first line is the pr-hero marker carrying doc.head_sha: postPrComment
// (pr.ts) finds the previous comment by the marker PREFIX and updates it in
// place, so this renderer and that finder share one contract and posting
// stays idempotent — while the declared head lets the watch guard (B3) tell
// which head a posted comment covers.
//
// The summary line (not the footer) names the exact range reviewed:
// doc.base_sha IS the diff-from commit — the recorded rule in cli.ts.
//
// `repoWebUrl` (e.g. https://github.com/org/repo) turns locations into
// links pinned to doc.head_sha. It is OPTIONAL and cosmetic by contract:
// absent, the comment renders as plain code spans, byte-identical to the
// linkless shape — the renderer stays offline-testable and a posted comment
// stays re-renderable from the artifact alone.
//
// ROADMAP B6 reshape, W2 (issues #16/#17): the index stays one-liners;
// anchorable findings live on the review; un-anchorable (and 422-demoted)
// findings render their full body in this summary's Comments Outside Diff
// section — Greptile-shaped, never as standalone issue comments. `delta`
// may be absent — a caller with no prior-state knowledge (or a same-run
// first post) still gets a valid comment, just without the delta line —
// but the PARAMETER itself is REQUIRED, not optional (PR2 verification
// WARN-3, same fix shape as `consumedCommentIds` on `postPrReview`,
// a3b3d3a): an optional third argument is one a PR3 wiring call can
// simply forget, and the summary would then render silently without the
// delta line spec R13 requires. `delta: PrCommentDelta | undefined`
// forces every call site to say so explicitly, so the type system — not a
// missed review comment — catches the omission.
// `outsideDiffFindings` is the same WARN-3 shape: REQUIRED, not optional.
// An optional fourth argument is one a caller can forget, and the summary
// would then silently omit the Outside Diff bucket those findings reached.
// Pass `[]` when there are none — the section is omitted only when the
// array is empty, never because a call site skipped the argument.
// `commentUrlByFindingId` stays the last, OPTIONAL parameter (ROADMAP B6
// rework, Juanma's PR #2 feedback): a finding id → its own posted
// review-comment URL, so the index above can link straight to it. Absent
// on the summary's FIRST creation (cli.ts creates the summary BEFORE any
// per-finding comment exists, to fix its position in the PR timeline —
// see cli.ts's postInlineFindings WHY) and present on the closing PATCH
// once posting finished. Un-anchorable findings have no review-comment
// URL; their index line stays unlinked and the bucket below has the full
// body. A caller that omits the map gets a correct, link-free index —
// never a broken or empty one — so this stays additive, unlike `delta`
// and `outsideDiffFindings` above: a missing link map degrades the
// index's usefulness, it does not make the comment lie.
export function renderPrComment(
  doc: FindingsDocument,
  repoWebUrl: string | undefined,
  delta: PrCommentDelta | undefined,
  outsideDiffFindings: readonly Finding[],
  commentUrlByFindingId?: ReadonlyMap<string, string>,
): string {
  // Normalize away one trailing slash so `gh repo view` output and a
  // hand-typed URL build the same links.
  const webUrl = repoWebUrl?.endsWith("/")
    ? repoWebUrl.slice(0, -1)
    : repoWebUrl;
  // Counted by SEVERITY, not tier (Juanma's PR #2 feedback item 3: the old
  // tier-based "0 blocking · 2 advisory" headline hid that both findings
  // were actually CRITICAL, just downgraded — the exact contradiction that
  // made "CRITICAL (advisory)" read as a bug on the finding body itself).
  // SUGGESTION is deliberately excluded from the headline, mirroring the
  // two-bucket 🔴/🟡 shape Juanma specified — a SUGGESTION still appears in
  // the index below, just not double-counted in the headline.
  const critical = doc.findings.filter(
    (f) => f.severity === "BLOCKER" || f.severity === "CRITICAL",
  ).length;
  const warning = doc.findings.filter((f) => f.severity === "WARNING").length;
  const headSha8 = code(doc.head_sha.slice(0, 8));
  const headRef =
    webUrl === undefined
      ? headSha8
      : `[${headSha8}](${webUrl}/commit/${doc.head_sha})`;
  const out: string[] = [prCommentMarker(doc.head_sha)];
  out.push("## pr-hero review");
  out.push("");
  // GitHub #42. The defect: a run where SOME agents died and the survivors
  // found nothing posted "🔴 0 critical · 🟡 0 warning" followed by a ✅ clean
  // bill, and the only trace of the incompleteness was the word `partial`
  // inside the <sub> footer at the very bottom. A reader takes a green check
  // at face value; nobody audits a footer.
  //
  // So the notice goes ABOVE the counts, not below them and not in the
  // footer: the counts are the thing being qualified, and a qualifier a
  // reader meets after the number it qualifies has already done its damage.
  //
  // The decision the issue left open — should such a run post at all — is
  // POST (Juanma, ROADMAP-DOORDASH M1): "post, stating the incompleteness and
  // naming the hunters that did not run — visible noise beats invisible
  // loss". Direction of error: posting nothing hides that a review was even
  // attempted, and an invisible loss is the failure this project's own rule
  // ranks worst; a loud incomplete notice is merely noisy, and noise can be
  // read and dismissed. The two extremes stay where they were — every agent
  // dead is `sessionFailed` and never posts (cli.ts), a complete run keeps
  // its ✅ untouched. This is the middle case only.
  //
  // Unconditional on `partial`, NOT gated on zero findings: a partial run
  // that found three things is also reporting a floor, not a verdict. The
  // zero-findings branch below is only where the ✅ has to be replaced.
  if (doc.run_status === "partial") {
    out.push(
      "⚠️ **This review is incomplete.** At least one agent did not finish, " +
        "so the counts below are a floor, not a verdict: whatever the " +
        "missing agents would have found is missing with them.",
    );
    out.push("");
    out.push(coverageSentence(doc, code));
    out.push("");
  }
  out.push(
    `🔴 ${critical} critical · 🟡 ${warning} warning — ${headRef}, ` +
      `diff from ${code(doc.base_sha.slice(0, 8))}`,
  );
  out.push("");
  if (doc.summary !== undefined) {
    out.push(...summaryLines(doc.summary));
    out.push("");
  }
  if (doc.findings.length === 0) {
    // The ✅ is a statement about COVERAGE, not about the findings array: it
    // claims every hunter looked and nobody found anything. On a partial run
    // that claim is false, so the glyph is withdrawn and the line points back
    // at the notice above rather than leaving the body to jump from a zero
    // count straight to the footer (GitHub #42).
    out.push(
      doc.run_status === "partial"
        ? "The agents that completed reported nothing. That is not a clean " +
            "bill: read it against the coverage above."
        : "✅ pr-hero reviewed this PR and found nothing to report.",
    );
    out.push("");
  } else {
    out.push(...findingIndexLines(doc.findings, commentUrlByFindingId));
    out.push("");
  }
  if (outsideDiffFindings.length > 0) {
    out.push(...outsideDiffSection(outsideDiffFindings, doc.head_sha, webUrl));
    out.push("");
  }
  // Omit the "since <sha>" clause when the previous head equals the current
  // one (Juanma's PR #2 feedback: "Δ since f933fda8" printed on head
  // f933fda8 is noise) — a re-run on an unchanged head, not a genuinely
  // absent prior state (which deltaLine already renders bare).
  const normalizedDelta =
    delta && delta.previousHeadSha === doc.head_sha
      ? { ...delta, previousHeadSha: undefined }
      : delta;
  if (normalizedDelta) {
    out.push(deltaLine(normalizedDelta));
    out.push("");
  }
  out.push("---");
  out.push("");
  // The footer keeps the report's public register: a comment that says
  // "blocking" without the not-a-merge-gate sentence would overstate the
  // tool's own contract. Comment voice: no em dashes in prose — the
  // disclaimer joins with a colon.
  out.push(
    `<sub>run ${doc.run_status} · ${engineLabel(doc)} · Assistant report, ` +
      "not a merge gate: every line above is a claim to verify.</sub>",
  );
  return `${out.join("\n").trimEnd()}\n`;
}

function deltaLine(delta: PrCommentDelta): string {
  const since =
    delta.previousHeadSha === undefined
      ? "Δ"
      : `Δ since ${code(delta.previousHeadSha.slice(0, 8))}`;
  return `${since}: ${delta.resolved} resolved · ${delta.new} new · ${delta.persist} persist`;
}

// Greptile-shaped bucket (issues #16/#17): un-anchorable and 422-demoted
// findings live HERE, inside the one summary, never as `POST .../issues/<n>/comments`.
// Rendered only when N>0. Full per-finding body (header, blob-linked location,
// claim, tier explanation, evidence, prompt-to-fix) — the same shape as
// renderIssueFindingComment minus the finding marker (that marker would make
// fetchPostedFindingComments treat this summary as a finding comment) and
// minus the "Posted as a standalone comment" footer (#17's smell).
function outsideDiffSection(
  findings: readonly Finding[],
  headSha: string,
  webUrl: string | undefined,
): string[] {
  const out: string[] = [`### Comments Outside Diff (${findings.length})`, ""];
  for (const [i, finding] of findings.entries()) {
    if (i > 0) out.push("");
    out.push(...findingBodyLines(finding, headSha, webUrl, true));
  }
  return out;
}

// Per-finding comment bodies (ROADMAP B6, reworked per Juanma's PR #2
// feedback items 2-5). Every posted finding — anchored inline or standalone
// — carries the pr-preflight.ts identity marker as its FIRST line, mirroring
// prCommentMarker's own contract, so a second run can tell "already posted"
// from "new" (inline.ts's matcher) without ever touching dedupe_key or
// root_cause_id. Deliberately as sparse as renderPrComment on economics: no
// cost, no tokens, nothing internal.
//
// Shape (both renderers, `linkLocation` is the only structural difference —
// see below):
//   <marker>
//
//   🔴 blocking · CRITICAL · introduced · lifecycle
//   `path:line` — symbol()
//
//   <claim, as a single unbroken-but-readable paragraph — item 5: "es solo
//   texto y no se entiende bien" was the old five-line wall>
//
//   ⚖️ Downgraded to advisory — the refuter returned `downgraded-latent`
//      (only when tier disagrees with severity — item 3/4)
//
//   <details>Evidence (N)</details>
//   <details>Prompt to fix with AI</details>
function findingHeaderLine(finding: Finding): string {
  return (
    `${scanAidEmoji(finding)} ${finding.tier} · ${finding.severity} · ` +
    `${finding.causal_disposition} · ${finding.hunter}`
  );
}

function findingLocationLine(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
  linkLocation: boolean,
): string {
  const loc = code(`${finding.path}:${finding.line}`);
  const linked =
    linkLocation && webUrl !== undefined
      ? `[${loc}](${blobUrl(webUrl, headSha, finding.path, `L${finding.line}`)})`
      : loc;
  return finding.symbol === undefined
    ? linked
    : `${linked} — ${oneLine(finding.symbol)}`;
}

// Item 3/4 (Juanma's PR #2 feedback): "CRITICAL (advisory)" on screen with no
// explanation reads as a contradiction, and `causal_disposition` was never
// shown anywhere. This line closes both — but ONLY when severity and tier
// actually disagree (a CRITICAL/BLOCKER landed advisory); printing it when
// they agree would be a tautology ("CRITICAL, still CRITICAL"). Mirrors
// deriveTier's own gate (findings.ts): only BLOCKER/CRITICAL can ever
// disagree with their tier, since every other severity is advisory by
// definition and never needs explaining.
function tierExplanationLines(finding: Finding): string[] {
  const isBlockerClass =
    finding.severity === "BLOCKER" || finding.severity === "CRITICAL";
  if (!isBlockerClass || finding.tier !== "advisory") return [];
  const lines = [
    "⚖️ Downgraded to advisory — the refuter returned " +
      `\`${finding.refuter_verdict}\``,
  ];
  // `downgraded-latent` is the one verdict with a documented, human-legible
  // meaning worth spelling out inline (findings.ts's own WHY comment on the
  // type): a real defect the refuter could not currently trigger. The other
  // verdicts that can also land here (`inconclusive`, or an `insufficient`
  // evidence_class regardless of verdict) have no equally short gloss, so
  // they render with just the verdict name rather than a guessed one.
  if (finding.refuter_verdict === "downgraded-latent") {
    lines.push("   (real, but no live trigger today)");
  }
  return lines;
}

// Item "Prompt to fix with AI" (Juanma's PR #2 feedback): a copy-pasteable
// prompt, not a deep link — Greptile's equivalent hands off to a hosted IDE
// integration this project does not have, and inventing a link to a service
// that does not exist would be worse than omitting the feature.
function promptToFixBlock(finding: Finding): string[] {
  return [
    "",
    "<details><summary>Prompt to fix with AI</summary>",
    "",
    "```",
    `Fix this issue in ${finding.path} at line ${finding.line}:`,
    "",
    oneLine(finding.claim),
    "```",
    "",
    "</details>",
  ];
}

function findingBodyLines(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
  linkLocation: boolean,
): string[] {
  const out: string[] = [
    findingHeaderLine(finding),
    findingLocationLine(finding, headSha, webUrl, linkLocation),
    "",
    oneLine(finding.claim),
  ];
  const tierLines = tierExplanationLines(finding);
  if (tierLines.length > 0) {
    out.push("");
    out.push(...tierLines);
  }
  out.push(...evidenceBlock(finding, headSha, webUrl));
  out.push(...promptToFixBlock(finding));
  return out;
}

export function renderInlineComment(
  finding: Finding,
  headSha: string,
  webUrl?: string,
): string {
  const out: string[] = [
    findingMarker({
      path: finding.path,
      line: finding.line,
      headSha,
      claim: finding.claim,
    }),
    "",
    // No link on the location line: GitHub already anchors this comment to
    // the diff line itself, so a self-referential link would be redundant —
    // unlike the un-anchorable twin below, which has no anchor to point at.
    ...findingBodyLines(finding, headSha, webUrl, false),
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

// Kept for postIssueComment (src/pr.ts) and its tests: leftover W1 orphans
// from old runs still have this body shape. New posting (W2, issues #16/#17)
// does not call this — un-anchorable findings go into the summary Outside
// Diff section, which reuses findingBodyLines without the marker or this
// standalone-comment footer (#17's smell).
export function renderIssueFindingComment(
  finding: Finding,
  headSha: string,
  webUrl?: string,
): string {
  const out: string[] = [
    findingMarker({
      path: finding.path,
      line: finding.line,
      headSha,
      claim: finding.claim,
    }),
    "",
    ...findingBodyLines(finding, headSha, webUrl, true),
    "",
    "<sub>Posted as a standalone comment: pr-hero could not anchor this " +
      "finding to a line in the current diff.</sub>",
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

// Shared Evidence <details> block, extracted from the pre-B6
// commentTierSection so both per-finding renderers stay byte-identical on
// the blank-line discipline GitHub requires around <details> markdown.
function evidenceBlock(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
): string[] {
  if (finding.proof_refs.length === 0) return [];
  const out: string[] = [
    "",
    `<details><summary>Evidence (${finding.proof_refs.length})</summary>`,
    "",
  ];
  for (const ref of finding.proof_refs) {
    out.push(`- ${renderRef(ref, headSha, webUrl)}`);
  }
  out.push("");
  out.push("</details>");
  return out;
}

// One Evidence bullet. With a web URL, the ref's leading `path:line` /
// `path:start-end` anchor becomes a blob link and the trailing prose stays
// plain text; a ref whose anchor does not parse falls back to the plain
// backtick-guarded rendering — a broken link would be worse than none.
function renderRef(
  ref: string,
  headSha: string,
  webUrl: string | undefined,
): string {
  if (webUrl === undefined) return code(ref);
  const parsed = parseRefAnchor(ref);
  if (parsed === null) return code(ref);
  const fragment =
    parsed.end === undefined
      ? `L${parsed.start}`
      : `L${parsed.start}-L${parsed.end}`;
  const url = blobUrl(webUrl, headSha, parsed.path, fragment);
  const link = `[${code(`${parsed.path}:${parsed.lines}`)}](${url})`;
  return parsed.prose === "" ? link : `${link} ${oneLine(parsed.prose)}`;
}

// Splits one proof_ref into its leading location anchor and trailing prose,
// REUSING extractAnchor (root-cause.ts) so the comment and the root-cause
// clustering read the exact same token as "the location" — two parsers for
// one format would drift. On top of the shared token this only checks that
// the line part is numeric (`19` or `19-20`): extractAnchor accepts any
// non-empty text after the colon, but only numbers make a #L fragment.
function parseRefAnchor(ref: string): {
  path: string;
  lines: string;
  start: number;
  end?: number;
  prose: string;
} | null {
  const anchor = extractAnchor([ref]);
  if (anchor === null) return null;
  const colon = anchor.lastIndexOf(":");
  const path = anchor.slice(0, colon);
  const lines = anchor.slice(colon + 1);
  const match = /^(\d+)(?:-(\d+))?$/.exec(lines);
  if (path.length === 0 || match?.[1] === undefined) return null;
  return {
    path,
    lines,
    start: Number(match[1]),
    end: match[2] === undefined ? undefined : Number(match[2]),
    prose: ref.trim().slice(anchor.length).trim(),
  };
}

// Exported for ui-result.ts, the second surface that links a finding to its
// source. Deliberately SHARED rather than re-derived: the markdown report and
// the terminal block must point a reader at the same bytes, and two copies of
// `/blob/<sha>/<path>#<fragment>` is exactly how the pinned line of one
// surface drifts from the other.
export function blobUrl(
  webUrl: string,
  sha: string,
  path: string,
  fragment: string,
): string {
  return `${webUrl}/blob/${sha}/${path}#${fragment}`;
}

function runLines(doc: FindingsDocument, meta: ReportMeta): string[] {
  const { files, insertions, deletions } = meta.diffStat;
  const lines = [
    `${files} file${files === 1 ? "" : "s"}, +${insertions} −${deletions}` +
      ` · run ${doc.run_status} · ${usd(meta.costUsd)} · ${duration(meta.wallMs)}`,
  ];
  const excluded = meta.excludedPaths ?? [];
  if (excluded.length > 0) {
    lines.push("");
    lines.push(
      `${excluded.length} generated file${excluded.length === 1 ? " was" : "s were"} ` +
        `excluded from the reviewed diff: ${excluded.join(", ")}. The counts ` +
        "above, and the diff the hunters read, are after that exclusion " +
        "(`diff.raw.patch` holds the unfiltered diff).",
    );
  }
  const rows = agentRows(doc);
  if (rows.length > 0) {
    lines.push("");
    lines.push(
      `Agents: ${rows.map((r) => `${r.key} ${r.status}`).join(" · ")}`,
    );
  }
  if (!doc.parity_hunter_fired) {
    lines.push("");
    lines.push(
      "The parity hunter did not fire: no changed path matched its trigger.",
    );
  }
  return lines;
}

// Grouping is the entire point of this section. ONE systemic defect reported
// at N call sites is one thing to fix, and a flat list of N findings reads as
// N problems — the same misreading that turns a correct review into an
// apparent precision collapse (see the note on clusterByRootCause). So the
// cluster is the unit of presentation here, and the finding is a site inside
// it.
function section(
  title: string,
  doc: FindingsDocument,
  tier: Tier,
  summary: RootCauseSummary,
): string[] {
  const findings = doc.findings.filter((f) => f.tier === tier);
  const byFinding = rootCauseIdByFinding(summary);
  const anchorById = new Map(summary.clusters.map((c) => [c.id, c.anchor]));
  // Clusters can straddle the tier split (two sites blocking, one advisory).
  // Group WITHIN the section: a section must never claim sites it is not
  // showing, so K counts the sites rendered right here.
  const groups: Array<{ key: string; findings: Finding[] }> = [];
  const index = new Map<string, { key: string; findings: Finding[] }>();
  for (const finding of findings) {
    // A finding the clusterer never placed is its own group, keyed by its own
    // id — an unclustered finding must never fall into a shared bucket.
    const key = byFinding.get(finding.id) ?? `finding:${finding.id}`;
    const existing = index.get(key);
    if (existing) {
      existing.findings.push(finding);
      continue;
    }
    const group = { key, findings: [finding] };
    index.set(key, group);
    groups.push(group);
  }
  const out = [
    `## ${title} (${findings.length} finding${findings.length === 1 ? "" : "s"}` +
      `, ${groups.length} root cause${groups.length === 1 ? "" : "s"})`,
  ];
  if (findings.length === 0) {
    out.push("");
    out.push(`_Nothing ${title.toLowerCase()}._`);
    return out;
  }
  for (const group of groups) {
    out.push("");
    const first = group.findings[0];
    if (!first) continue;
    if (group.findings.length === 1) {
      out.push(...renderSingleton(first));
      continue;
    }
    out.push(
      ...renderFanOut(
        group.findings,
        anchorById.get(group.key) ?? null,
        group.key,
      ),
    );
  }
  return out;
}

function renderFanOut(
  findings: Finding[],
  anchor: string | null,
  clusterId: string,
): string[] {
  const label = anchor === null ? "(no shared anchor)" : code(anchor);
  const out = [
    `### ${clusterId} — ${label}`,
    "",
    `One defect reported at ${findings.length} sites — fix the root cause ` +
      "once and every site below goes with it.",
    "",
  ];
  for (const finding of findings) {
    out.push(
      `- ${finding.id} ${code(`${finding.path}:${finding.line}`)} — ` +
        `${oneLine(finding.claim)} (${finding.severity}, ${finding.hunter})`,
    );
  }
  return out;
}

function renderSingleton(finding: Finding): string[] {
  const symbol = finding.symbol ? ` (${oneLine(finding.symbol)})` : "";
  const out = [
    `### ${finding.id} — ${code(`${finding.path}:${finding.line}`)}${symbol}`,
    "",
    oneLine(finding.claim),
    "",
    `- ${finding.severity} · evidence ${finding.evidence_class} · ` +
      `${finding.causal_disposition} · hunter ${finding.hunter} · ` +
      `refuter ${finding.refuter_verdict}`,
  ];
  if (finding.proof_refs.length === 0) {
    out.push("- Proof: none cited");
    return out;
  }
  out.push("- Proof:");
  for (const ref of finding.proof_refs) out.push(`  - ${oneLine(ref)}`);
  return out;
}

// The audit trail. A finding the engine dropped is invisible in findings[],
// and an invisible drop is an unattributable miss: "no hunter saw it" and "a
// hunter saw it and the refuter killed it" must not look the same to a human
// reading this file.
function notReported(doc: FindingsDocument): string[] {
  const refuted = doc.debug.refuted;
  const dedupedCount = doc.debug.deduped?.length ?? 0;
  const out = ["## Not reported", ""];
  if (refuted.length === 0 && dedupedCount === 0) {
    out.push("Nothing was refuted, and nothing was merged as a duplicate.");
    return out;
  }
  out.push(`${refuted.length} refuted, ${dedupedCount} merged as duplicates.`);
  if (refuted.length > 0) out.push("");
  for (const finding of refuted) {
    out.push(
      `- ${finding.id} ${code(`${finding.path}:${finding.line}`)} — ` +
        `${oneLine(finding.claim)} — ${finding.refuter_verdict}`,
    );
  }
  return out;
}

// The engine identity as prose, shared by the report's closing note and the
// PR comment's footer: absent engine info degrades to a name, never a lie.
function engineLabel(doc: FindingsDocument): string {
  return doc.engine
    ? `${doc.engine.name} ${doc.engine.version}`
    : "pr-hero (version not recorded)";
}

function closing(doc: FindingsDocument): string[] {
  return [
    "---",
    "",
    `Generated by ${engineLabel(doc)}. This is an assistant report, not a merge gate: ` +
      'every line above is a claim to verify, and `blocking` means "a human ' +
      'should look before this ships", never "the merge is blocked".',
  ];
}

// Hunter-authored text lands inside code spans and list items. A stray
// backtick in a path or proof_ref would break out of its span and mangle
// every line after it, so spans are built here and never by hand.
function code(text: string): string {
  return `\`${oneLine(text).replaceAll("`", "'")}\``;
}

// Claims arrive as free prose and sometimes carry newlines; a raw newline
// inside a list item silently ends the item.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Elapsed time as the compact `3m12s` the CLI's live progress prefixes onto
// every event line. Floor, never round: 59.9s read as "60s" would tick the
// minute early. Minutes deliberately never roll into hours — a review past
// the hour reading "61m..." is itself information.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
