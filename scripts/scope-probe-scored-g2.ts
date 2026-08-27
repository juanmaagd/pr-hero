// Scope probe, MECHANISM-SCORED variant (ROADMAP A1 diagnostic — NOT a benchmark arm).
//
// THIS VARIANT RE-MEASURES G2 — the headline result — WITH THE INSTRUMENT FIXED.
//
// The claim under test: `scripts/scope-probe.ts` reported G2 at full 1/8 vs
// narrowed 6/8, Fisher two-tailed p~=0.041, and that number is the only reason
// anyone is considering chunking. It was produced by the +/-12 line window,
// which the mechanism-scored G3 run then proved broken in BOTH directions: it
// swallowed real hits (`index.tsx:139` IS G3, 14 lines from the golden's
// recorded line) and credited non-hits (`index.tsx:108` matched no golden at
// all). A number from an instrument that errs both ways cannot be corrected —
// it has to be re-measured.
//
// SO SCORING IS THE ONLY THING THAT DIFFERS FROM `scripts/scope-probe.ts`.
// Same worktree, same FULL_DIFF, same `narrowPatch`, same replicate CLI arg,
// the same LIFECYCLE agent from `slice3b-lifecycle-v2`, and codegraph OFF —
// both deliberately reverted from the G3 line of probes. Changing the agent or
// the index as well would leave a moved number unattributable: scorer, or
// hunter, or hops? The G3 probes own the codegraph question; this one does not
// touch it. The ONE experimental variable remains `full` vs `narrowed`.
//
// G2 is the primary golden here, and it is the one this hunter is FOR. G1/G3
// still ride along in the scoring (they cost only judge calls) but stay
// SECONDARY: G3 is a value-contract defect the ledger credits to the
// reliability slot, so a miss on it here is about which hunter ran.
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
// STATED LIMITATION — SPEC REACHABILITY. Single-hunter spec, lifecycle only,
// matching the original G2 probe. :96 is the golden this hunter is for; :153
// and :111 are SECONDARY free riders whose misses are confounded by which slot
// is running and license no conclusion on their own.
//
// PRE-REGISTERED READING, fixed before this run and NOT to be revised after
// seeing the numbers. The point of writing it now is that the author has an
// obvious stake in one outcome — the exciting result is his — so the criteria
// are fixed while that stake cannot touch them:
//   - narrowed materially above full on :96, at a comparable margin to the
//     line-window run's 6/8 vs 1/8 => the headline SURVIVES the instrument fix
//     and the chunking hypothesis is back to one-golden-positive,
//     one-golden-inverted, which is still not a licence to redesign anything.
//   - the gap collapses, or inverts => the headline was substantially an
//     artifact of line-proximity scoring. Say so plainly, retract the p~=0.041
//     wherever it was quoted, and treat the chunking hypothesis as unsupported.
//   - both arms at 0/N => no resolution, exactly like the G3 attempts; report
//     inconclusive and stop, do NOT reach for a third instrument change.
//   - `full` at N/N => distrust and investigate before reporting.
//   - A finding the old window called a hit but the judge calls no_match is the
//     EXPECTED correction, not a regression. Any drop must be read that way
//     first, before any story about the hunter getting worse.
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
import { resolveRunnerAuthority } from "../src/runner-authority";
import type { ReviewSpec } from "../src/spec";
import { ClaudeCodeRunner } from "../src/step-runner";

const REPLICATES = Number(process.argv[2] ?? 3);
const LAB = "/Users/juanma/Desktop/deep-review";
const WORKTREE = "/Users/juanma/Desktop/musive/musive-worktrees/g2-scope-probe";
const FULL_DIFF = `${LAB}/bench/runs/501/4609456d31e75d3612a35980e04a6b6089e6b030/diff.patch`;
const AGENT_SOURCE = `${LAB}/agents/slice3b-lifecycle-v2/deep-review-lifecycle.md`;
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

const runnerAuthority = await resolveRunnerAuthority({
  workspaceRoot: WORKTREE,
});
if (runnerAuthority.error !== undefined) {
  throw new Error(`execution authority unavailable: ${runnerAuthority.error}`);
}

const PROBE_SPEC: ReviewSpec = {
  agents: [
    { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
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
    path.join(agentsDir, "deep-review-lifecycle.md"),
    agentSource,
  );
  const diffPath = path.join(base, "diff.patch");
  await writeFile(diffPath, scope === "full" ? fullPatch : narrowedPatch);

  // CODEGRAPH ON — carried over from the parent, and ON in BOTH arms so the
  // probe stays single-variable.
  //
  // CODEGRAPH OFF — deliberately back to the ORIGINAL G2 probe's setting.
  //
  // This run exists to answer exactly one question: does G2's headline result
  // (full 1/8 vs narrowed 6/8, p~=0.041) survive being scored by MECHANISM
  // instead of by a +/-12 line window? To answer that, scoring must be the
  // ONLY thing that differs from `scripts/scope-probe.ts`. So the agent goes
  // back to lifecycle v2 and codegraph goes back off.
  //
  // Turning it on here would have been the more "modern" choice and would
  // have ruined the comparison: a changed number could then be the scorer, or
  // the index, and nothing would distinguish them. The G3 line of probes owns
  // the codegraph question; this one does not touch it.
  //
  // The original's justification for off still holds on its own terms: G2's
  // defect lives entirely inside one file, so cross-file hops are not needed
  // to see it.
  const mcpConfigPath = path.join(runDir, "mcp.json");
  await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

  // §5.3 D1-10b: ONE controller shared by the pipeline and the runner. The
  // pipeline aborts it when the ceiling fires; the runner's harness reads the
  // same signal and refuses to start another attempt, so in-flight steps stop
  // instead of billing on past a report that has already been returned. Two
  // controllers would leave the ceiling unable to stop the steps it is waiting
  // on — and this probe spends real money.
  const ceilingController = new AbortController();
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
    {
      runner: new ClaudeCodeRunner({
        ...runnerAuthority.runnerOptions,
        signal: ceilingController.signal,
      }),
      ceilingController,
    },
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
const out = path.join(LAB, "bench", "probes", "scope-probe-scored-g2.json");
await mkdir(path.dirname(out), { recursive: true });
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`written: ${out}`);
console.log(JSON.stringify(report, null, 2));
