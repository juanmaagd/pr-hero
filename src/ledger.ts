// The head-to-head ledger (ROADMAP B4), pure half: parse each run's
// comparison.json back in, keep ONE vote per PR, and render the accumulated
// buckets as a rate. Same purity contract as pr-preflight.ts — no fs, no
// git, no network, no clock. The I/O shell in cli.ts finds the files, reads
// the bytes, supplies each file's mtime, and owns stdout.

import type { Bucket } from "./compare";
import type { RunStatus } from "./findings";
import type {
  ComparisonGreptileClaim,
  ComparisonPrHeroClaim,
} from "./pr-preflight";
import { CliUsageError, isFullCommitId } from "./preflight";

// Unlike ComparisonRow (written always-null), a stored row may have been
// triaged since it was written: verdict, reasoning and actor read back as
// string-or-null (actor: "agent" | "human" | null).
export interface StoredComparisonRow {
  bucket: Bucket;
  greptile: ComparisonGreptileClaim | null;
  prhero: ComparisonPrHeroClaim | null;
  verdict: string | null;
  reasoning: string | null;
  // Who wrote verdict/reasoning (ROADMAP B6c). `actor` set with `verdict`
  // null means "adjudicated, could not settle" (the triage's `inconclusive`
  // outcome); both null means "nobody has looked yet" — a reader can tell
  // those apart, which is the only reason the null verdict stays safe.
  actor: "agent" | "human" | null;
}

export interface StoredComparison {
  pr: number;
  head_sha: string;
  diff_from_sha: string;
  run_dir: string;
  run_status: RunStatus;
  // Absent on files written before the stamp existed — the first paid run
  // (PR 1682) predates it. The I/O layer supplies mtime as the ordering
  // fallback for exactly those files.
  generated_at?: string;
  greptile: { found: boolean };
  rows: StoredComparisonRow[];
}

const BUCKETS: Bucket[] = ["greptile_only", "both", "prhero_only"];

// Reads one comparison.json body back into the shape the engine wrote,
// loudly: every failing field names itself (the resolvePrTarget register),
// because a silently mis-read artifact becomes a silently wrong rate. The
// caller wraps errors with the file path — this module never sees one.
export function parseComparisonJson(raw: string): StoredComparison {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `comparison.json is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("comparison.json must be a single JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const pr = record.pr;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) {
    throw new CliUsageError(
      `comparison.json "pr" must be a positive integer, got: ` +
        JSON.stringify(pr),
    );
  }
  const run_status = record.run_status;
  if (run_status !== "complete" && run_status !== "partial") {
    throw new CliUsageError(
      `comparison.json "run_status" must be complete or partial, got: ` +
        JSON.stringify(run_status),
    );
  }
  const generated_at = record.generated_at;
  if (
    generated_at !== undefined &&
    (typeof generated_at !== "string" || generated_at.length === 0)
  ) {
    throw new CliUsageError(
      `comparison.json "generated_at" must be a non-empty string when ` +
        `present, got: ${JSON.stringify(generated_at)}`,
    );
  }
  const greptile = record.greptile;
  if (
    typeof greptile !== "object" ||
    greptile === null ||
    typeof (greptile as Record<string, unknown>).found !== "boolean"
  ) {
    throw new CliUsageError(
      'comparison.json "greptile.found" must be a boolean',
    );
  }
  const rows = record.rows;
  if (!Array.isArray(rows)) {
    throw new CliUsageError('comparison.json "rows" must be an array');
  }
  rows.forEach((row, i) => {
    validateRow(row, i);
  });
  return {
    pr,
    head_sha: readSha(record, "head_sha"),
    diff_from_sha: readSha(record, "diff_from_sha"),
    run_dir: readString(record, "run_dir"),
    run_status,
    ...(generated_at === undefined ? {} : { generated_at }),
    greptile: { found: (greptile as { found: boolean }).found },
    // Normalizes a missing `actor` key (files written before this field
    // existed) to explicit `null` — validateRow already accepted `undefined`
    // for back-compat, but every DOWNSTREAM read (aggregateLedger's tally,
    // the `=== null` pending check) must see one consistent absent-value,
    // never have to know both spellings mean the same thing.
    rows: (rows as Record<string, unknown>[]).map((row) => ({
      ...row,
      actor: (row.actor as StoredComparisonRow["actor"] | undefined) ?? null,
    })) as StoredComparisonRow[],
  };
}

function validateRow(candidate: unknown, index: number): void {
  if (typeof candidate !== "object" || candidate === null) {
    throw new CliUsageError(`comparison.json rows[${index}] must be an object`);
  }
  const row = candidate as Record<string, unknown>;
  if (!BUCKETS.includes(row.bucket as Bucket)) {
    throw new CliUsageError(
      `comparison.json rows[${index}].bucket must be one of ` +
        `${BUCKETS.join("|")}, got: ${JSON.stringify(row.bucket)}`,
    );
  }
  for (const side of ["greptile", "prhero"] as const) {
    const value = row[side];
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      throw new CliUsageError(
        `comparison.json rows[${index}].${side} must be an object or null`,
      );
    }
  }
  for (const column of ["verdict", "reasoning"] as const) {
    const value = row[column];
    if (value !== null && typeof value !== "string") {
      throw new CliUsageError(
        `comparison.json rows[${index}].${column} must be a string or null, ` +
          `got: ${JSON.stringify(value)}`,
      );
    }
  }
  // actor (ROADMAP B6c): same loud per-field validation verdict/reasoning
  // already get, but a closed enum rather than "any string" — an unknown
  // actor string is a malformed artifact, not a new taxonomy member (unlike
  // verdict, which the ledger deliberately tallies AS-IS). `undefined`
  // (the field absent entirely) is accepted, back-compat for files written
  // before this field existed — same fallback shape as `generated_at`
  // above; readActor below folds it to `null`.
  const actor = row.actor;
  if (
    actor !== undefined &&
    actor !== null &&
    actor !== "agent" &&
    actor !== "human"
  ) {
    throw new CliUsageError(
      `comparison.json rows[${index}].actor must be "agent", "human" or ` +
        `null, got: ${JSON.stringify(actor)}`,
    );
  }
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(
      `comparison.json "${field}" must be a non-empty string, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function readSha(record: Record<string, unknown>, field: string): string {
  const value = readString(record, field);
  if (!isFullCommitId(value)) {
    throw new CliUsageError(
      `comparison.json "${field}" must be a full 40-hex commit id, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

export interface LedgerBuckets {
  greptileOnly: number;
  both: number;
  prheroOnly: number;
}

// M by agent, K by human, out of a row's own triaged verdict — always M+K
// <= that row's `triaged` count, never forced to equal it: a row can carry
// a verdict with no recorded actor (a legacy artifact, or a human editing
// the JSON by hand before `actor` existed), and undercounting that split is
// more honest than inventing an actor for it (ROADMAP B6c).
export interface ActorTally {
  agent: number;
  human: number;
}

export interface LedgerPrEntry {
  pr: number;
  runCount: number;
  latest: {
    headSha: string;
    runStatus: RunStatus;
    greptileFound: boolean;
    buckets: LedgerBuckets;
    triaged: number;
    totalRows: number;
    verdictTally: Record<string, number>;
    actorTally: ActorTally;
    // Every still-untriaged row of the latest run, kept whole so the
    // renderer can name exactly what a human should pick up next.
    pending: StoredComparisonRow[];
  };
}

export interface LedgerTotals {
  prCount: number;
  buckets: LedgerBuckets;
  prsWithPrHeroFindings: number;
  triaged: number;
  totalRows: number;
  verdictTally: Record<string, number>;
  actorTally: ActorTally;
}

export interface Ledger {
  prs: LedgerPrEntry[];
  totals: LedgerTotals;
}

// WHY the LATEST run per PR is the only one that votes: one PR, one vote.
// Totals over all runs would let a re-reviewed PR vote twice and flatter
// whichever bucket the re-run grew — the rate's denominator must be PRs,
// never runs. runCount still records how often each PR was reviewed.
export function aggregateLedger(
  entries: { comparison: StoredComparison; mtimeMs: number }[],
): Ledger {
  const byPr = new Map<
    number,
    { latest: StoredComparison; latestKey: number; runCount: number }
  >();
  for (const entry of entries) {
    const key = orderKey(entry);
    const group = byPr.get(entry.comparison.pr);
    if (group === undefined) {
      byPr.set(entry.comparison.pr, {
        latest: entry.comparison,
        latestKey: key,
        runCount: 1,
      });
      continue;
    }
    group.runCount += 1;
    // >= so a timestamp tie goes to the later-seen entry; the shell feeds
    // files in sorted order, so ties resolve deterministically.
    if (key >= group.latestKey) {
      group.latest = entry.comparison;
      group.latestKey = key;
    }
  }
  // Sorted by PR number so the ledger reads (and diffs) the same regardless
  // of the order the files were found in.
  const prs = [...byPr.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pr, group]) => prEntry(pr, group.latest, group.runCount));
  const totals: LedgerTotals = {
    prCount: prs.length,
    buckets: { greptileOnly: 0, both: 0, prheroOnly: 0 },
    prsWithPrHeroFindings: 0,
    triaged: 0,
    totalRows: 0,
    verdictTally: {},
    actorTally: { agent: 0, human: 0 },
  };
  for (const entry of prs) {
    totals.buckets.greptileOnly += entry.latest.buckets.greptileOnly;
    totals.buckets.both += entry.latest.buckets.both;
    totals.buckets.prheroOnly += entry.latest.buckets.prheroOnly;
    if (entry.latest.buckets.both + entry.latest.buckets.prheroOnly > 0) {
      totals.prsWithPrHeroFindings += 1;
    }
    totals.triaged += entry.latest.triaged;
    totals.totalRows += entry.latest.totalRows;
    for (const [verdict, count] of Object.entries(entry.latest.verdictTally)) {
      totals.verdictTally[verdict] =
        (totals.verdictTally[verdict] ?? 0) + count;
    }
    totals.actorTally.agent += entry.latest.actorTally.agent;
    totals.actorTally.human += entry.latest.actorTally.human;
  }
  return { prs, totals };
}

// generated_at orders a PR's runs when present — the stamp travels with the
// artifact, while mtime is whatever the filesystem last did to the file (a
// cp or a backup restore rewrites it). mtime is the fallback for files that
// predate the stamp; an unparseable stamp falls back too, because NaN never
// compares and would freeze the latest-run pick on whichever came first.
function orderKey(entry: {
  comparison: StoredComparison;
  mtimeMs: number;
}): number {
  const stamp = entry.comparison.generated_at;
  if (stamp === undefined) return entry.mtimeMs;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? entry.mtimeMs : parsed;
}

function prEntry(
  pr: number,
  latest: StoredComparison,
  runCount: number,
): LedgerPrEntry {
  const buckets: LedgerBuckets = { greptileOnly: 0, both: 0, prheroOnly: 0 };
  const verdictTally: Record<string, number> = {};
  const actorTally: ActorTally = { agent: 0, human: 0 };
  const pending: StoredComparisonRow[] = [];
  let triaged = 0;
  for (const row of latest.rows) {
    if (row.bucket === "greptile_only") buckets.greptileOnly += 1;
    else if (row.bucket === "both") buckets.both += 1;
    else buckets.prheroOnly += 1;
    if (row.verdict === null) {
      pending.push(row);
      continue;
    }
    triaged += 1;
    // Counted AS-IS, whatever string the triage wrote: the ledger reports
    // the triage's own vocabulary and never defines a taxonomy — the A3
    // lesson lives in the rows' reasoning, not in an enum invented before
    // any triage happened.
    verdictTally[row.verdict] = (verdictTally[row.verdict] ?? 0) + 1;
    // "the agent decides, and it is audited" (ROADMAP B6b) is a word until
    // a human can see, in one line, what fraction of the verdicts a machine
    // wrote — a row with no recorded actor (legacy artifact, or a human
    // hand-editing the JSON before `actor` existed) is simply not counted
    // in either bucket, never guessed into one.
    if (row.actor === "agent") actorTally.agent += 1;
    else if (row.actor === "human") actorTally.human += 1;
  }
  return {
    pr,
    runCount,
    latest: {
      headSha: latest.head_sha,
      runStatus: latest.run_status,
      greptileFound: latest.greptile.found,
      buckets,
      triaged,
      totalRows: latest.rows.length,
      verdictTally,
      actorTally,
      pending,
    },
  };
}

// The markdown the command prints. Counts as counts — with denominators this
// small, a percentage would be theater; "N of M" says exactly as much as the
// data does.
export function renderLedger(ledger: Ledger): string {
  const out: string[] = [];
  out.push("# pr-hero — head-to-head ledger");
  out.push("");
  out.push("One row per PR; only its latest run votes.");
  out.push("");
  out.push(
    "| PR | head | Greptile-only | Both | pr-hero-only | run | triaged " +
      "| runs |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of ledger.prs) {
    out.push(
      `| ${entry.pr} | \`${entry.latest.headSha.slice(0, 8)}\` | ` +
        `${entry.latest.buckets.greptileOnly} | ` +
        `${entry.latest.buckets.both} | ` +
        `${entry.latest.buckets.prheroOnly} | ${entry.latest.runStatus} | ` +
        `${entry.latest.triaged}/${entry.latest.totalRows} | ` +
        `${entry.runCount} |`,
    );
  }
  out.push("");
  const totals = ledger.totals;
  out.push(
    `Totals over latest runs: Greptile-only ${totals.buckets.greptileOnly} ` +
      `· Both ${totals.buckets.both} · pr-hero-only ` +
      `${totals.buckets.prheroOnly}. pr-hero found something on ` +
      `${totals.prsWithPrHeroFindings} of ${totals.prCount} PRs; ` +
      `${totals.triaged} of ${totals.totalRows} rows triaged.`,
  );
  // "the agent decides, and it is audited" (ROADMAP B6b) is a word until a
  // human can see, in one line, what fraction of the verdicts a machine
  // wrote. Counts as counts, same reason the rest of this render avoids a
  // percentage — the denominator is too small, some runs, for a rate to
  // mean anything.
  out.push(
    `${totals.triaged} verdicts · ${totals.actorTally.agent} by agent · ` +
      `${totals.actorTally.human} by human.`,
  );
  out.push("");
  out.push("## Verdicts");
  out.push("");
  const verdicts = Object.keys(totals.verdictTally).sort();
  if (verdicts.length === 0) {
    out.push(
      "No verdicts recorded yet — every accumulated row is still waiting " +
        "for a human.",
    );
  } else {
    for (const verdict of verdicts) {
      out.push(`- ${verdict}: ${totals.verdictTally[verdict]}`);
    }
  }
  out.push("");
  out.push("## Pending triage");
  out.push("");
  const pendingLines: string[] = [];
  for (const entry of ledger.prs) {
    for (const row of entry.latest.pending) {
      pendingLines.push(
        `- PR ${entry.pr} · ${row.bucket} · ${rowIdentity(row)}`,
      );
    }
  }
  if (pendingLines.length === 0) {
    out.push(
      "Nothing pending — every row of every latest run carries a verdict.",
    );
  } else {
    out.push(...pendingLines);
  }
  out.push("");
  out.push(
    "Write each verdict AND its reasoning into that run's comparison.json " +
      "row (`verdict`, `reasoning`): a verdict recorded without its " +
      "reasoning cannot be re-examined when new evidence arrives.",
  );
  return `${out.join("\n").trimEnd()}\n`;
}

// A pending row must be actionable from its one line: the pr-hero side
// names the finding id, the Greptile side its issue index, each with the
// location to open. A `both` row carries both claims and the pr-hero side
// leads — its id is what the triage writes the verdict against.
function rowIdentity(row: StoredComparisonRow): string {
  if (row.prhero !== null) {
    return `${row.prhero.id} ${codeSpan(`${row.prhero.path}:${row.prhero.line}`)}`;
  }
  if (row.greptile !== null) {
    return (
      `G${row.greptile.index} ` +
      codeSpan(`${row.greptile.path}:${row.greptile.start_line}`)
    );
  }
  return "(no claim data)";
}

// Same hazard code() in report.ts guards: a backtick inside a claim-authored
// path would break out of its span and mangle the rest of the line.
function codeSpan(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}
