// Cal.com slice of Martian offline (`docs/martian-bench.md`).
//
//   bun run scripts/martian-cal.ts plan    # $0 — size gate + cost band
//   bun run scripts/martian-cal.ts check   # $0 — fetch SHAs, dry-run the CLI
//   bun run scripts/martian-cal.ts run     # LIVE — default: the 3-PR pilot
//   bun run scripts/martian-cal.ts score   # $0 — findings vs goldens, no judge
//
// Local mode, never `--pr`: PR mode posts a commit status on the head, and
// these are other people's merged PRs. `--two-dot` because the PRs are merged
// (`main...head` is empty) and because a shallow fetch of two SHAs may not
// contain the merge-base. Isolation is the engine's; this harness never
// passes GitHub comments to hunters.
//
// Default is the 3-PR pilot (14943, 8330, 8087). `--all` is the ten.
// One pipeline: hunters, scout off, summarizer off, parity never fires.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument } from "../src/findings";
import {
  findingsToMartianReview,
  lookupGolden,
  type MartianGoldenPr,
  prNumberFromUrl,
} from "../src/martian-adapter";
import { estimateCost } from "../src/report";
import { DEFAULT_SIZE_GATE, evaluateSizeGateAggregate } from "../src/size-gate";

const LAB_AGENTS_DIR =
  "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v6-clean";

const ROOT = path.join(import.meta.dir, "..");
const CASES_PATH = path.join(ROOT, "docs", "martian-cal-cases.json");
const GOLDENS_PATH = path.join(ROOT, "docs", "martian-cal-goldens.json");
const GOTCHAS_PATH = path.join(ROOT, "docs", "martian-cal-gotchas.md");
const DEFAULT_REPO = path.join(homedir(), "Desktop", "martian-cal", "cal.com");
const DEFAULT_RUNS = path.join(homedir(), "Desktop", "martian-cal", "runs");
const HUNTERS = 3;

interface CaseRow {
  pr: number;
  title: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseSha: string;
  headSha: string;
}

interface CasesFile {
  repo: string;
  pilot: number[];
  prs: CaseRow[];
}

function fail(message: string): never {
  console.error(`martian-cal: ${message}`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = Bun.argv[i + 1];
  if (value === undefined || value.startsWith("-")) {
    fail(`${flag} needs a value`);
  }
  return value;
}

const mode = Bun.argv[2];
if (mode !== "plan" && mode !== "check" && mode !== "run" && mode !== "score") {
  fail(
    "usage: bun run scripts/martian-cal.ts plan|check|run|score [--all] [--only 14943,8330] [--repo …] [--runs …]",
  );
}

const cases = (await Bun.file(CASES_PATH).json()) as CasesFile;
const goldens = (await Bun.file(GOLDENS_PATH).json()) as MartianGoldenPr[];
const repo = argValue("--repo") ?? DEFAULT_REPO;
const runsRoot = argValue("--runs") ?? DEFAULT_RUNS;
const onlyRaw = argValue("--only");
const all = Bun.argv.includes("--all");

function parseOnly(raw: string): number[] {
  return raw.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n <= 0) fail(`bad --only value: ${s}`);
    return n;
  });
}

const selected = all
  ? cases.prs.map((p) => p.pr)
  : onlyRaw
    ? parseOnly(onlyRaw)
    : cases.pilot;

const rows: CaseRow[] = selected.map((pr) => {
  const row = cases.prs.find((p) => p.pr === pr);
  if (row === undefined) fail(`PR ${pr} is not in ${CASES_PATH}`);
  lookupGolden(goldens, pr);
  return row;
});

function runDirFor(pr: number): string {
  return path.join(runsRoot, `cal-${pr}-hunters`);
}

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

async function ensureShas(row: CaseRow): Promise<void> {
  if (!existsSync(path.join(repo, ".git"))) {
    fail(
      `no clone at ${repo} — clone calcom/cal.com (blobless is fine) into that path`,
    );
  }
  const have = git(["cat-file", "-t", row.headSha]);
  const haveBase = git(["cat-file", "-t", row.baseSha]);
  if (have.ok && haveBase.ok) return;
  const fetched = git([
    "fetch",
    "--filter=blob:none",
    "origin",
    row.baseSha,
    row.headSha,
  ]);
  if (!fetched.ok) {
    fail(`git fetch ${row.pr} failed: ${fetched.stderr.trim()}`);
  }
}

async function checkoutHead(row: CaseRow): Promise<void> {
  await ensureShas(row);
  const co = git(["checkout", "--detach", "--force", row.headSha]);
  if (!co.ok) fail(`git checkout ${row.headSha} failed: ${co.stderr.trim()}`);
  const head = git(["rev-parse", "HEAD"]);
  if (head.stdout.trim() !== row.headSha) {
    fail(`HEAD ${head.stdout.trim()} != ${row.headSha}`);
  }
}

async function review(row: CaseRow, dryRun: boolean): Promise<number> {
  await checkoutHead(row);
  const argv = [
    process.execPath,
    path.join(ROOT, "src", "cli.ts"),
    "review",
    "--repo",
    repo,
    "--base",
    row.baseSha,
    "--head",
    row.headSha,
    "--two-dot",
    "--yes",
    "--no-summary",
    "--agents",
    LAB_AGENTS_DIR,
    "--gotchas",
    GOTCHAS_PATH,
    "--out",
    runDirFor(row.pr),
    ...(dryRun ? ["--dry-run"] : []),
  ];
  const proc = Bun.spawn(argv, {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

if (mode === "plan") {
  const gate = DEFAULT_SIZE_GATE;
  console.log(
    "pr   files   +/−      lines  gate   gold  band (3 hunters, no summary, no scout)",
  );
  console.log(
    "---- ----- --------  ------  -----  ----  ---------------------------------------",
  );
  let low = 0;
  let high = 0;
  const refused: number[] = [];
  for (const row of rows) {
    const lines = row.additions + row.deletions;
    const verdict = evaluateSizeGateAggregate(
      {
        files: row.changedFiles,
        insertions: row.additions,
        deletions: row.deletions,
      },
      gate,
    );
    const estimate = estimateCost(
      {
        files: row.changedFiles,
        insertions: row.additions,
        deletions: row.deletions,
      },
      HUNTERS,
      false,
      false,
    );
    const golden = lookupGolden(goldens, row.pr);
    low += estimate.low;
    high += estimate.high;
    if (!verdict.ok) refused.push(row.pr);
    console.log(
      `${String(row.pr).padStart(5)} ${String(row.changedFiles).padStart(5)} ` +
        `${String(row.additions).padStart(4)}/${String(row.deletions).padStart(4)} ` +
        `${String(lines).padStart(6)}  ${verdict.ok ? "ok   " : "SKIP "} ` +
        `${String(golden.comments.length).padStart(4)}  ` +
        `$${estimate.low.toFixed(2)}–$${estimate.high.toFixed(2)}  ${row.title}`,
    );
  }
  console.log("");
  console.log(
    `${rows.length} PR(s). Estimated ${HUNTERS} hunters + refuter, summarizer off, scout off, parity never fires.`,
  );
  console.log(`band sum: $${low.toFixed(2)}–$${high.toFixed(2)}`);
  console.log(
    "Gate column is GitHub aggregate counters (no exclusions, no whitespace). Conservative.",
  );
  console.log(`clone: ${repo}`);
  console.log(`runs:  ${runsRoot}`);
  console.log(
    "NEVER --pr: that path posts a commit status on the head. These are other people's PRs.",
  );
  if (refused.length > 0) {
    console.log(`SIZE GATE would refuse: ${refused.join(", ")}`);
  }
  process.exit(0);
}

if (mode === "check") {
  const seen = new Set<string>();
  for (const row of rows) {
    const dir = runDirFor(row.pr);
    if (seen.has(dir)) fail(`COLLISION: ${dir}`);
    seen.add(dir);
    if (!dir.startsWith(runsRoot)) fail(`run dir not under runs root: ${dir}`);
  }
  const failures: string[] = [];
  for (const row of rows) {
    console.error(`\n=== cal ${row.pr} (dry run)`);
    const code = await review(row, true);
    if (code !== 0) failures.push(`pr ${row.pr}: exit ${code}`);
  }
  if (failures.length === 0) {
    console.error(
      `\nmartian-cal check: ${rows.length} dry-run(s) ok, $0 spent. ` +
        "Read RUN in each plan and confirm it is under the runs root, not the root itself.",
    );
    process.exit(0);
  }
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

if (mode === "run") {
  console.error(
    `martian-cal run: ${rows.length} PR(s), pipeline hunters, into ${runsRoot}`,
  );
  const failures: string[] = [];
  let skipped = 0;
  for (const row of rows) {
    const dir = runDirFor(row.pr);
    const label = `cal ${row.pr}`;
    if (await Bun.file(path.join(dir, "findings.json")).exists()) {
      console.error(`\n=== ${label} — SKIPPED, already on disk at ${dir}`);
      skipped++;
      continue;
    }
    console.error(`\n=== ${label} -> ${dir}`);
    const code = await review(row, false);
    if (code !== 0) {
      failures.push(`${label}: exit ${code}`);
      continue;
    }
    if (!(await Bun.file(path.join(dir, "findings.json")).exists())) {
      failures.push(
        `${label}: exited 0 but wrote no findings.json — skipped (empty diff or size gate)`,
      );
      continue;
    }
    const doc = (await Bun.file(
      path.join(dir, "findings.json"),
    ).json()) as FindingsDocument;
    const golden = lookupGolden(goldens, row.pr);
    const overlay = findingsToMartianReview({
      prUrl: golden.url,
      findings: doc.findings as Finding[],
    });
    await Bun.write(
      path.join(dir, "martian-review.json"),
      `${JSON.stringify(overlay, null, 2)}\n`,
    );
  }
  if (skipped > 0) {
    console.error(`martian-cal run: ${skipped} skipped — already on disk`);
  }
  if (failures.length === 0) {
    console.error("martian-cal run: every review exited 0");
  } else {
    console.error(`martian-cal run: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
  }
  console.error("Now: bun run scripts/martian-cal.ts score");
  process.exit(failures.length === 0 ? 0 : 1);
}

if (!existsSync(runsRoot)) {
  fail(
    `no runs root at ${runsRoot} — run \`bun run scripts/martian-cal.ts run\` first`,
  );
}

console.log(
  "Surface A without their LLM judge: juxtaposition only. Do not quote precision/recall from this output.",
);
console.log("");
for (const row of rows) {
  const dir = runDirFor(row.pr);
  const findingsPath = path.join(dir, "findings.json");
  const golden = lookupGolden(goldens, row.pr);
  console.log(`## PR ${row.pr} — ${row.title}`);
  console.log(golden.url);
  if (!(await Bun.file(findingsPath).exists())) {
    console.log("  (no findings.json — this PR has not been run)");
    console.log("");
    continue;
  }
  const doc = (await Bun.file(findingsPath).json()) as FindingsDocument;
  console.log(
    `  cost $${doc.telemetry.cost_usd_est.toFixed(2)}  findings ${doc.findings.length}  status ${doc.run_status}`,
  );
  console.log("  goldens:");
  for (const g of golden.comments) {
    console.log(`    [${g.severity}/${g.category}] ${g.comment.slice(0, 140)}`);
  }
  console.log("  pr-hero:");
  if (doc.findings.length === 0) {
    console.log("    (none)");
  }
  for (const f of doc.findings) {
    console.log(
      `    ${f.id} ${f.tier} ${f.path}:${f.line}  ${f.claim.slice(0, 140)}`,
    );
  }
  console.log("");
}

const knownUrls = new Set(goldens.map((g) => g.url));
for (const g of goldens) {
  prNumberFromUrl(g.url);
}
if (knownUrls.size !== goldens.length) fail("duplicate golden URLs");
process.exit(0);
