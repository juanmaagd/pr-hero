// Scope probe (ROADMAP A1 diagnostic — NOT a benchmark arm).
//
// WHY THIS EXISTS. Two synthetic probes failed to reproduce the real G2 miss:
// the lifecycle agent hits the planted defect shape 14/14 across every
// condition tried (commented/bare, sparse/crowded, naming/neutral prior), yet
// misses the real golden 0/4. Comment deference, prior dependence and ledger
// density are all dead. What remains different is the REAL tree — a 22KB diff
// across 9 files, a large real component, and competing salient value-contract
// defects (G1 at :111, G3 at :153) living in the very same file the lifecycle
// slot must read and then suppress as out of scope.
//
// So this probe stops using synthetic code. It runs the real agent over the
// REAL worktree at the real golden's head, and varies ONE thing: the diff the
// pass is asked to cover.
//
//   full     — the exact diff.patch the benchmark run used (9 files)
//   narrowed — the same patch filtered to the golden's file alone
//
// A narrowed hit with a full miss proves chunking as the lever ON REAL DATA,
// which is what the synthetic probes could not do. Chunking is an orchestration
// change, not a prompt edit, so it respects the maintainer's stop-loss.
//
// CODEGRAPH IS ON in this variant, in BOTH conditions. The parent probe's
// justification for disabling it — "G2's defect lives entirely inside one
// file, so cross-file hops are not needed" — is a statement about G2 and does
// not transfer to G3. The first G3 attempt inherited the setting anyway and
// returned 0/5 vs 0/5; a control arm with no headroom cannot resolve a
// difference, which is why the parent probe's own comment already warns that
// "a control that misses for lack of codegraph would be uninformative".
//
// PRE-REGISTERED READING, fixed before this run and not to be revised after
// seeing the numbers:
//   - `full` at roughly the ledger's 0.33 for G3 under this set => the probe
//     has resolution, and the full-vs-narrowed comparison is meaningful.
//   - `full` at 0/5 again => the floor is NOT codegraph, the cause is still
//     unknown, and no further money goes into this design until it is found.
//   - `full` at 5/5 => something leaked; distrust and investigate before
//     reporting anything.
//
// Run: bun run scripts/scope-probe.ts [replicates]
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPipeline } from "../src/pipeline";
import { resolveRunnerAuthority } from "../src/runner-authority";
import type { ReviewSpec } from "../src/spec";
import { ClaudeCodeRunner } from "../src/step-runner";

const REPLICATES = Number(process.argv[2] ?? 3);
const LAB = "/Users/juanma/Desktop/deep-review";
const WORKTREE = "/Users/juanma/Desktop/musive/musive-worktrees/g2-scope-probe";
const FULL_DIFF = `${LAB}/bench/runs/501/4609456d31e75d3612a35980e04a6b6089e6b030/diff.patch`;
const AGENT_SOURCE = `${LAB}/agents/slice3b-lifecycle-v6-clean/deep-review-reliability.md`;
const GOTCHAS = `${LAB}/intel/gotchas.md`;
const GOLDEN_FILE = "packages/web/src/components/Waveform/index.tsx";
// Golden G3 = 1539@4609456d:153 — a VALUE-CONTRACT defect, which is why this
// variant runs the reliability hunter and not the lifecycle one: the ledger
// records G3 caught 2/2 by the reliability slot, while lifecycle went silent.
// Same +/-12 window width G2 used, for the same reason: a model cites a
// neighbouring line of the same mechanism rather than one canonical line.
//
// STATED LIMITATION: the line comes from ROADMAP.md's "G1 at :111, G3 at :153",
// not from the dataset (which this session must not read). A hit is therefore
// "a finding in this file within the window", exactly as the G2 probe defines
// it — it does not verify the finding states G3's actual claim.
const GOLDEN_LINE = { min: 141, max: 165 };

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

const fullPatch = await Bun.file(FULL_DIFF).text();
const narrowedPatch = narrowPatch(fullPatch, GOLDEN_FILE);
const agentSource = await Bun.file(AGENT_SOURCE).text();

const runnerAuthority = await resolveRunnerAuthority({
  workspaceRoot: WORKTREE,
});
if (runnerAuthority.error !== undefined) {
  throw new Error(`execution authority unavailable: ${runnerAuthority.error}`);
}

const PROBE_SPEC: ReviewSpec = {
  agents: [
    { key: "reliability", file: "deep-review-reliability.md", role: "hunter" },
  ],
};

interface Attempt {
  scope: Scope;
  replicate: number;
  hit: boolean;
  findingCount: number;
  costUsd: number;
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

  // CODEGRAPH ON — the one thing this variant changes, and it changes it in
  // BOTH arms so the probe stays single-variable.
  //
  // WHY. The G2 probe disables codegraph and says why: "G2's defect lives
  // entirely inside one file, so cross-file hops are not needed to see it".
  // That justification is about G2, and the first G3 attempt inherited the
  // setting without re-earning it — then returned 0/5 vs 0/5. G3's recorded
  // catches (2/2 by the reliability slot, runs 501-512) come from full
  // 4-hunter runs WITH the index. If G3 needs a hop, the previous probe
  // removed the faculty that finds it from both arms at once, which produces
  // exactly the floor observed. This run tests that.
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
      pr: 1539,
      baseSha: "06e857b3073f34fcdaf4265fdefea00616d6330a",
      headSha: "4609456d31e75d3612a35980e04a6b6089e6b030",
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
    { runner: new ClaudeCodeRunner(runnerAuthority.runnerOptions) },
  );

  const { skillOutput } = result;
  const candidates = [
    ...skillOutput.findings,
    ...skillOutput.debug.refuted,
    ...(skillOutput.debug.deduped ?? []),
  ];
  const hit = candidates.some(
    (f) =>
      f.path === GOLDEN_FILE &&
      f.line >= GOLDEN_LINE.min &&
      f.line <= GOLDEN_LINE.max,
  );

  return {
    scope,
    replicate,
    hit,
    findingCount: candidates.length,
    costUsd: result.usage.cost_usd_est,
    locations: candidates.map((f) => `${f.path}:${f.line}`),
  };
}

const attempts: Attempt[] = [];
for (let r = 1; r <= REPLICATES; r++) {
  for (const scope of ["full", "narrowed"] as const) {
    const attempt = await runOnce(scope, r);
    attempts.push(attempt);
    console.error(
      `[${scope} #${r}] hit=${attempt.hit} n=${attempt.findingCount} ` +
        `$${attempt.costUsd.toFixed(4)} ${attempt.locations.join(", ")}`,
    );
  }
}

const summarise = (scope: Scope) => {
  const rows = attempts.filter((a) => a.scope === scope);
  return {
    scope,
    hits: rows.filter((a) => a.hit).length,
    runs: rows.length,
    mean_findings: Number(
      (rows.reduce((s, a) => s + a.findingCount, 0) / rows.length).toFixed(2),
    ),
    cost_usd: Number(rows.reduce((s, a) => s + a.costUsd, 0).toFixed(4)),
  };
};

const report = {
  replicates: REPLICATES,
  golden: "1539@4609456d:153 (G3)",
  full: summarise("full"),
  narrowed: summarise("narrowed"),
  total_cost_usd: Number(
    attempts.reduce((s, a) => s + a.costUsd, 0).toFixed(4),
  ),
  attempts,
};

// Written to disk, not just stdout: the earlier probes were captured through
// `tail`, which truncated their summaries and forced reconstruction.
const out = path.join(LAB, "bench", "probes", "scope-probe-g3-cg.json");
await mkdir(path.dirname(out), { recursive: true });
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`written: ${out}`);
console.log(JSON.stringify(report, null, 2));
