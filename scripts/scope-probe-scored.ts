// Scope probe, MECHANISM-SCORED variant (ROADMAP A1 diagnostic — NOT a benchmark arm).
//
// Parent: scripts/scope-probe-g3-cg.ts. Everything about the experiment is
// carried over byte-for-byte — same worktree, same FULL_DIFF, same reliability
// agent from `slice3b-lifecycle-v6-clean`, same `narrowPatch`, codegraph ON in
// BOTH arms, same replicate CLI arg. The ONE variable is still `full` vs
// `narrowed`. Only the SCORING changed, plus the golden coverage (see below).
//
// WHY A NEW PROBE INSTEAD OF AN EDIT. The three existing probes are the record
// of what was already paid for; they are not touched. This one supersedes their
// hit test.
//
// WHAT WAS WRONG WITH THE OLD HIT TEST. The parent probes score a hit as
// `f.path === GOLDEN_FILE && f.line within +/-12`. That is exactly the method
// runner/scorer.ts:1-11 was built to replace: an honest hand pass scored 3/7
// when the truth was 2/7, because "a claim was credited for sharing a LINE with
// a golden whose mechanism it contradicted". The scorer's one rule is SAME
// MECHANISM, OR NO MATCH. A line-window probe cannot tell "the effect never
// sets this value" from "the effect sets it too eagerly" — opposite mechanisms,
// same line. So this variant hands every (golden x finding) pair to the lab's
// pairwise LLM judge via `scoreTree`, and a hit for a golden is that golden's
// key appearing in `TreeScore.matched`.
//
// THE JUDGE MAY READ GOLDEN BODIES; THE ENGINE MAY NOT. scorer.ts:10-11 —
// "The judge is deliberately NOT the engine: it sees golden bodies, which no
// hunter may ever see. Keep those two paths apart." That separation holds here:
// goldens are loaded in THIS driver process and passed only to `scoreTree`,
// which spawns a toolless, MCP-less `claude -p` judge. Nothing from a golden
// ever reaches the hunter's prompt, its worktree, its diff, or this file's
// output artifact.
//
// GOLDENS COME FROM train.jsonl, NOT test.jsonl. PR 1539 is on the dataset's
// BURNED list (dataset/README.md), which forces every one of its findings into
// TRAIN and excludes them from the held-out split forever. The held-out
// test.jsonl is never opened by this probe, and must never be.
//
// ALL THREE GOLDENS ON THE TREE ARE SCORED. Tree 1539@4609456d carries G2
// (:96), G1 (:111) and G3 (:153). Scoring is one judge call per
// (golden x finding) pair and a run yields few findings, so covering all three
// costs little and triples what one run measures. Verified structurally: all
// three anchor to packages/web/src/components/Waveform/index.tsx, so
// `narrowPatch` keeps every one of them reachable in the narrowed arm too.
//
// STATED LIMITATION — SPEC REACHABILITY. This probe keeps the parent's
// single-hunter spec (reliability only) deliberately: changing it would change
// the experiment. The ledger credits G3 to the reliability slot (2/2), while
// G1/G2's recorded catches may belong to other slots (G2 is the lifecycle miss
// the whole probe family exists to explain). So a miss on :96 or :111 here is
// partly a statement about which hunter is running, NOT only about scope. Read
// the per-golden counts with that in mind.
//
// PRE-REGISTERED READING, fixed before this run and not to be revised after
// seeing the numbers. Updated for mechanism scoring:
//   - `full` scoring :153 at roughly the ledger's 0.33 for G3 under this set
//     => the probe has resolution, and full-vs-narrowed is meaningful.
//   - `full` at 0/N on :153 again => the floor is NOT codegraph and NOT the
//     line-window artifact either; the cause is still unknown and no further
//     money goes into this design until it is found.
//   - `full` at N/N => something leaked; distrust and investigate before
//     reporting anything.
//   - :96 and :111 are SECONDARY. They are free riders on judge calls that were
//     already being paid for. A miss there is confounded by the single-hunter
//     spec above and does not, on its own, license any conclusion about scope.
//   - A golden that the old line-window probes would have called a hit but the
//     judge calls no_match is the expected correction, not a regression.
//
// COST FORECAST. Two spend sources, and only ONE of them lands in the JSON's
// cost totals:
//   1. Hunter steps — replicates x 2 arms pipeline runs. This is what
//      `result.usage.cost_usd_est` measures, and what `cost_usd` reports.
//   2. Judge calls — NOT in that number. `scoreTree` spawns one short sonnet
//      round-trip per (golden x finding) pair, with NO tools and no MCP:
//        replicates x 2 arms x 3 goldens x findings-per-run
//      The parent probe saw roughly 3-6 findings per run, so at the default 3
//      replicates expect ~54-108 judge calls. Each is small (two claims in,
//      one JSON object out), but they are real spend on top of the hunters.
//
// OUTPUT HYGIENE. The artifact carries golden KEYS and outcomes only. Golden
// bodies, golden claims and finding claim text never enter it. `PairVerdict`
// carries a `reasoning` field which is OMITTED rather than sanitized: the judge
// prompt explicitly asks it to "name the mechanism each claim asserts"
// (scorer.ts:150), so by construction it paraphrases the golden. It is dropped
// from the artifact AND never printed to stdout/stderr.
//
// Run: bun run scripts/scope-probe-scored.ts [replicates]
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GoldenRow,
  goldenKey,
  goldensForTree,
  type ScorableFinding,
  scoreTree,
} from "../../deep-review/runner/scorer";
import { runPipeline } from "../src/pipeline";
import type { ReviewSpec } from "../src/spec";
import { ClaudeCodeRunner } from "../src/step-runner";

const REPLICATES = Number(process.argv[2] ?? 3);
const LAB = "/Users/juanma/Desktop/deep-review";
const WORKTREE = "/Users/juanma/Desktop/musive/musive-worktrees/g2-scope-probe";
const FULL_DIFF = `${LAB}/bench/runs/501/4609456d31e75d3612a35980e04a6b6089e6b030/diff.patch`;
const AGENT_SOURCE = `${LAB}/agents/slice3b-lifecycle-v6-clean/deep-review-reliability.md`;
const GOTCHAS = `${LAB}/intel/gotchas.md`;
const GOLDEN_FILE = "packages/web/src/components/Waveform/index.tsx";
// train.jsonl, not test.jsonl — see the BURNED note in the header.
const DATASET = `${LAB}/dataset/train.jsonl`;
const SMOKE_CONFIG = `${LAB}/runner/config/smoke.config.json`;
const PR = 1539;
const BASE_SHA = "06e857b3073f34fcdaf4265fdefea00616d6330a";
const HEAD_SHA = "4609456d31e75d3612a35980e04a6b6089e6b030";

type Scope = "full" | "narrowed";

// Keep only the sections of a unified diff that belong to `file`. Split on the
// `diff --git` record separator so hunk headers travel with their file.
function narrowPatch(patch: string, file: string): string {
  const sections = patch.split(/(?=^diff --git )/m);
  const kept = sections.filter((s) => s.includes(` b/${file}`));
  if (kept.length === 0) {
    throw new Error(`narrowPatch: no section for ${file}`);
  }
  return kept.join("");
}

// The lab exports no golden loader — `score()` in runner/index.ts:393-406 does
// this inline. Same four steps, same alias source, so the probe and the bench
// resolve identical goldens for a tree.
async function loadTreeGoldens(): Promise<GoldenRow[]> {
  const smokeConfig = JSON.parse(await Bun.file(SMOKE_CONFIG).text()) as {
    golden_commit_aliases?: Record<string, string>;
  };
  const goldens = (await Bun.file(DATASET).text())
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GoldenRow);
  const treeGoldens = goldensForTree(
    goldens,
    HEAD_SHA,
    smokeConfig.golden_commit_aliases ?? {},
  );
  if (treeGoldens.length === 0) {
    throw new Error(`no labelled goldens for ${HEAD_SHA}`);
  }
  return treeGoldens;
}

const fullPatch = await Bun.file(FULL_DIFF).text();
const narrowedPatch = narrowPatch(fullPatch, GOLDEN_FILE);
const agentSource = await Bun.file(AGENT_SOURCE).text();
const treeGoldens = await loadTreeGoldens();
const goldenKeys = treeGoldens.map(goldenKey);

const PROBE_SPEC: ReviewSpec = {
  agents: [
    { key: "reliability", file: "deep-review-reliability.md", role: "hunter" },
  ],
};

interface Attempt {
  scope: Scope;
  replicate: number;
  matched: string[]; // golden keys this run hit, by mechanism
  missed: string[];
  novelCount: number; // findings that matched no golden
  findingCount: number;
  costUsd: number; // HUNTER spend only — judge calls are not counted here
  locations: string[];
}

async function runOnce(scope: Scope, replicate: number): Promise<Attempt> {
  const base = await mkdtemp(path.join(tmpdir(), `pr-hero-scope-${scope}-`));
  const agentsDir = path.join(base, "agents");
  const runDir = path.join(base, "run");
  await mkdir(agentsDir);
  await mkdir(runDir);
  await writeFile(
    path.join(agentsDir, "deep-review-reliability.md"),
    agentSource,
  );
  const diffPath = path.join(base, "diff.patch");
  await writeFile(diffPath, scope === "full" ? fullPatch : narrowedPatch);

  // CODEGRAPH ON — carried over from the parent, and ON in BOTH arms so the
  // probe stays single-variable.
  //
  // WHY. The G2 probe disables codegraph and says why: "G2's defect lives
  // entirely inside one file, so cross-file hops are not needed to see it".
  // That justification is about G2, and the first G3 attempt inherited the
  // setting without re-earning it — then returned 0/5 vs 0/5. G3's recorded
  // catches (2/2 by the reliability slot, runs 501-512) come from full
  // 4-hunter runs WITH the index. A control arm with no headroom cannot
  // resolve a difference.
  //
  // Registry shape is copied from CODEGRAPH_ONLY_MCP_CONFIG in src/cli.ts —
  // codegraph and nothing else, which with --strict-mcp-config is the whole
  // tool surface a hunter can reach.
  const mcpConfigPath = path.join(runDir, "mcp.json");
  await Bun.write(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        codegraph: {
          type: "stdio" as const,
          command: "codegraph",
          args: ["serve", "--mcp"],
        },
      },
    }),
  );

  const result = await runPipeline(
    {
      pr: PR,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      worktree: WORKTREE,
      diffPath,
      gotchasPath: GOTCHAS,
      agentsDir,
      runDir,
      outPath: path.join(runDir, "findings.json"),
      mcpConfigPath,
      hopBudget: 12,
      parityTriggerPaths: [],
      // Identical in both conditions and deliberately NOT naming the golden's
      // file — the same neutral-prior discipline the scale probe used.
      suspicionPriors: [
        {
          path: "packages/web/src/components/**",
          weight: "high",
          reason: "web component tree touched by this diff",
        },
      ],
      stepTimeoutMs: 15 * 60 * 1000,
      spec: PROBE_SPEC,
    },
    { runner: new ClaudeCodeRunner() },
  );

  const { skillOutput } = result;
  // Surviving findings, refuted ones and dedupe losers all count as "the pass
  // saw it" — the parent probe's candidate set, unchanged. Ids are prefixed by
  // origin because scoreTree keys its matched/novel bookkeeping on `id` and
  // dedupe renumbering makes cross-list collisions plausible. Refuted and
  // deduped rows carry no `tier`; the scorer reads only path/line/symbol/claim,
  // so a placeholder is honest here.
  const scorable: ScorableFinding[] = [
    ...skillOutput.findings.map((f) => ({
      id: `F${f.id}`,
      path: f.path,
      line: f.line,
      symbol: f.symbol,
      severity: f.severity,
      tier: f.tier,
      claim: f.claim,
    })),
    ...skillOutput.debug.refuted.map((f) => ({
      id: `R${f.id}`,
      path: f.path,
      line: f.line,
      symbol: f.symbol,
      severity: f.severity,
      tier: "refuted",
      claim: f.claim,
    })),
    ...(skillOutput.debug.deduped ?? []).map((f) => ({
      id: `D${f.id}`,
      path: f.path,
      line: f.line,
      symbol: f.symbol,
      severity: f.severity,
      tier: "deduped",
      claim: f.claim,
    })),
  ];

  // SAME MECHANISM, OR NO MATCH. This replaces the parent's line window.
  const score = await scoreTree({
    headSha: HEAD_SHA,
    pr: PR,
    goldens: treeGoldens,
    findings: scorable,
  });

  return {
    scope,
    replicate,
    matched: score.matched,
    missed: score.missed,
    novelCount: score.novel.length,
    findingCount: scorable.length,
    costUsd: result.usage.cost_usd_est,
    locations: scorable.map((f) => `${f.path}:${f.line}`),
  };
  // NOTE: score.verdicts is intentionally dropped on the floor — its
  // `reasoning` paraphrases golden bodies by construction. See OUTPUT HYGIENE.
}

const attempts: Attempt[] = [];
for (let r = 1; r <= REPLICATES; r++) {
  for (const scope of ["full", "narrowed"] as const) {
    const attempt = await runOnce(scope, r);
    attempts.push(attempt);
    // Keys and counts only — never a claim, never a judge reasoning string.
    console.error(
      `[${scope} #${r}] matched=[${attempt.matched.join(",")}] ` +
        `n=${attempt.findingCount} novel=${attempt.novelCount} ` +
        `$${attempt.costUsd.toFixed(4)} ${attempt.locations.join(", ")}`,
    );
  }
}

const summarise = (scope: Scope) => {
  const rows = attempts.filter((a) => a.scope === scope);
  const perGolden: Record<string, number> = {};
  for (const key of goldenKeys) {
    perGolden[key] = rows.filter((a) => a.matched.includes(key)).length;
  }
  return {
    scope,
    runs: rows.length,
    per_golden_hits: perGolden,
    mean_findings: Number(
      (rows.reduce((s, a) => s + a.findingCount, 0) / rows.length).toFixed(2),
    ),
    mean_novel: Number(
      (rows.reduce((s, a) => s + a.novelCount, 0) / rows.length).toFixed(2),
    ),
    cost_usd: Number(rows.reduce((s, a) => s + a.costUsd, 0).toFixed(4)),
  };
};

const report = {
  replicates: REPLICATES,
  scoring: "mechanism (runner/scorer.ts scoreTree + claudeJudge)",
  goldens: goldenKeys,
  // Actual judge spend, reported because it is invisible to the cost totals
  // below: one sonnet round-trip per (golden x finding) pair, per run.
  judge_calls: attempts.reduce(
    (s, a) => s + goldenKeys.length * a.findingCount,
    0,
  ),
  full: summarise("full"),
  narrowed: summarise("narrowed"),
  // HUNTER spend only. Judge calls are separate sonnet subprocesses the
  // pipeline's usage accounting never sees.
  total_hunter_cost_usd: Number(
    attempts.reduce((s, a) => s + a.costUsd, 0).toFixed(4),
  ),
  attempts,
};

// Written to disk, not just stdout: the earlier probes were captured through
// `tail`, which truncated their summaries and forced reconstruction. New
// filename — the existing probe artifacts in this directory are never
// overwritten.
const out = path.join(LAB, "bench", "probes", "scope-probe-scored.json");
await mkdir(path.dirname(out), { recursive: true });
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`written: ${out}`);
console.log(JSON.stringify(report, null, 2));
