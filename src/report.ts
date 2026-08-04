// The human-facing half of local mode (ROADMAP B0): a pure renderer that
// turns a findings document into the markdown a developer actually reads, and
// a pure cost estimator that runs BEFORE the money is spent.
//
// Pure on purpose — no I/O, no git, no clock. The CLI owns every side effect,
// so the report can be re-rendered from an artifact on disk months later and
// come out byte-identical (the lab already replays old findings.json files;
// a renderer that reached for `new Date()` would make that a lie).

import type { Finding, FindingsDocument, Tier } from "./findings";
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

// Per-hunter marginal cost, fitted to two measured runs (see BAND below).
// Deliberately three transparent coefficients instead of a regression: with
// two calibration points anything fancier is false precision.
const USD_PER_AGENT_BASE = 0.5;
const USD_PER_CHANGED_LINE = 0.00042;
const USD_PER_FILE = 0.008;

// Skewed on purpose. Both recorded overruns were UNDER-estimates, never over,
// so the upper arm is the wider one: a band that is too generous costs a
// second of hesitation, a band that is too tight costs real money.
const BAND_LOW = 0.7;
const BAND_HIGH = 1.4;

// WHY this function exists at all: the ROADMAP logs two cost overruns in a
// row — "~$21" against an actual bill, and "~$34" against an actual $48.30 —
// and both had the same cause. The estimate was carried over from the
// PREVIOUS arm instead of being computed from the tree about to be reviewed.
// So this estimates from the diff, and only from the diff.
//
// Calibration points, both measured on real runs:
//   - a small tree billed ~$2.61 end to end;
//   - a 45-file / +2775 −1237 tree with 5 hunters + refuter billed ~$14.78,
//     and the same tree was recorded at ~$11/run elsewhere in the campaign.
// That ~$11 vs ~$14.78 spread on ONE tree is the whole argument for returning
// a band: the same diff, the same agents, a 34% swing. A point estimate here
// would be a fiction with a decimal point on it.
//
// The refuter is not a separate term: its cost rides in the coefficients,
// because the $14.78 point was measured with the refuter leg included and a
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
      "coarse band from two calibration points (a small tree ~$2.61; a " +
      "45-file / +2775 −1237 tree with 5 hunters + refuter ~$11–$14.78), " +
      "scaled by changed lines, changed files and hunter count. It is an " +
      "order-of-magnitude guide, not a quote — the same tree has billed 34% " +
      "apart across runs.",
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

function closing(doc: FindingsDocument): string[] {
  const engine = doc.engine
    ? `${doc.engine.name} ${doc.engine.version}`
    : "pr-hero (version not recorded)";
  return [
    "---",
    "",
    `Generated by ${engine}. This is an assistant report, not a merge gate: ` +
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
