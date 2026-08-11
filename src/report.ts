// The human-facing half of local mode (ROADMAP B0): a pure renderer that
// turns a findings document into the markdown a developer actually reads, and
// a pure cost estimator that runs BEFORE the money is spent.
//
// Pure on purpose — no I/O, no git, no clock. The CLI owns every side effect,
// so the report can be re-rendered from an artifact on disk months later and
// come out byte-identical (the lab already replays old findings.json files;
// a renderer that reached for `new Date()` would make that a lie).

import type { Finding, FindingsDocument, Tier } from "./findings";
import { PR_COMMENT_MARKER } from "./pr-preflight";
import {
  clusterByRootCause,
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
): CostEstimate {
  const files = Math.max(0, diffStat.files);
  const lines =
    Math.max(0, diffStat.insertions) + Math.max(0, diffStat.deletions);
  // A validated ReviewSpec always carries at least one hunter, so a zero here
  // means a caller asked hypothetically. Clamping keeps the band from
  // collapsing to $0–$0, which would read as "this is free".
  const agents = Math.max(1, hunterCount);
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
      "per-hunter floor plus changed lines and files. An order-of-magnitude " +
      "guide, not a quote — the same tree has billed 34% apart across runs.",
  };
}

export interface ReportMeta {
  repo: string;
  base: string;
  head: string;
  diffStat: DiffStat;
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

export function renderReport(doc: FindingsDocument, meta: ReportMeta): string {
  const summary = doc.debug.root_causes ?? clusterByRootCause(doc.findings);
  const out: string[] = [];
  out.push(`# Review — ${meta.repo} ${meta.base}..${meta.head}`);
  out.push("");
  out.push(...runLines(doc, meta));
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

// The PR-comment renderer (ROADMAP B2): the same findings document, shaped
// for a public GitHub comment instead of a run artifact. Pure for the same
// reason renderReport is — a posted comment must be re-renderable from the
// artifact and come out identical.
//
// Deliberately SPARSER than report.md: NO cost, NO token counts, no
// telemetry of any kind — the engine's internal economics never reach a
// public comment.
//
// The first line is PR_COMMENT_MARKER, verbatim: postPrComment (pr.ts) finds
// the previous comment by that prefix and updates it in place, so this
// renderer and that finder share one constant and posting stays idempotent.
export function renderPrComment(doc: FindingsDocument): string {
  const blocking = doc.findings.filter((f) => f.tier === "blocking");
  const advisory = doc.findings.filter((f) => f.tier === "advisory");
  const out: string[] = [PR_COMMENT_MARKER];
  out.push(
    `## pr-hero review — ${blocking.length} blocking, ` +
      `${advisory.length} advisory`,
  );
  out.push("");
  if (doc.findings.length === 0) {
    out.push("pr-hero reviewed this PR and found nothing to report.");
  }
  // Blocking first, then advisory — the same order the report's sections use.
  for (const finding of [...blocking, ...advisory]) {
    out.push(
      `- **${finding.tier}** ${code(`${finding.path}:${finding.line}`)} — ` +
        oneLine(finding.claim),
    );
  }
  out.push("");
  out.push("---");
  out.push("");
  // The footer names the exact range reviewed (doc.base_sha IS the diff-from
  // commit — the recorded rule in cli.ts) and keeps the report's public
  // register: a comment that says "blocking" without the not-a-merge-gate
  // sentence would overstate the tool's own contract.
  out.push(
    `Reviewed \`${doc.head_sha.slice(0, 8)}\` (diff from ` +
      `\`${doc.base_sha.slice(0, 8)}\`) · run ${doc.run_status} · ` +
      `${engineLabel(doc)}. Assistant report, not a merge gate — every ` +
      "line above is a claim to verify.",
  );
  return `${out.join("\n").trimEnd()}\n`;
}

function runLines(doc: FindingsDocument, meta: ReportMeta): string[] {
  const { files, insertions, deletions } = meta.diffStat;
  const lines = [
    `${files} file${files === 1 ? "" : "s"}, +${insertions} −${deletions}` +
      ` · run ${doc.run_status} · ${usd(meta.costUsd)} · ${duration(meta.wallMs)}`,
  ];
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
