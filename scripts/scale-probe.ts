// Scale probe (ROADMAP A1 diagnostic — NOT a benchmark arm).
//
// Runs the REAL lifecycle agent, on the REAL model, against two repos holding
// the SAME planted latch defect, differing only in how many correct lifecycle
// resources surround it. The suspicion prior is NEUTRAL and identical in both
// (it names src/player.ts, which contains no defect), unlike the comment
// probe's prior, which nearly named the resource.
//
// See fixtures/scale-probe.ts for the hypothesis this separates.
//
// LIVE: spends real money. Record the result (charter rule 6).
// Run: bun run scripts/scale-probe.ts [replicates]
import path from "node:path";
import { buildScaleFixture, type Density } from "../fixtures/scale-probe";
import { runPipeline } from "../src/pipeline";
import type { ReviewSpec } from "../src/spec";
import { ClaudeCodeRunner } from "../src/step-runner";

const REPLICATES = Number(process.argv[2] ?? 4);
const AGENT_SOURCE_PATH =
  "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v2/deep-review-lifecycle.md";

const PROBE_SPEC: ReviewSpec = {
  agents: [
    { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
  ],
};

const agentSource = await Bun.file(AGENT_SOURCE_PATH).text();

interface Attempt {
  density: Density;
  replicate: number;
  hit: boolean;
  findingCount: number;
  costUsd: number;
  locations: string[];
}

async function runOnce(density: Density, replicate: number): Promise<Attempt> {
  const fixture = await buildScaleFixture(density, agentSource);

  const mcpConfigPath = path.join(fixture.runDir, "mcp.json");
  await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

  const result = await runPipeline(
    {
      pr: 0,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      worktree: fixture.repoDir,
      diffPath: fixture.diffPath,
      gotchasPath: fixture.gotchasPath,
      agentsDir: fixture.agentsDir,
      runDir: fixture.runDir,
      outPath: path.join(fixture.runDir, "findings.json"),
      mcpConfigPath,
      hopBudget: 4,
      parityTriggerPaths: [],
      // NEUTRAL and identical across conditions: player.ts holds no defect.
      // The comment probe's prior nearly named the planted resource, which is
      // the confound this probe exists to remove.
      suspicionPriors: [
        {
          path: "src/player.ts",
          weight: "high",
          reason: "playback entry point",
        },
      ],
      stepTimeoutMs: 10 * 60 * 1000,
      spec: PROBE_SPEC,
    },
    { runner: new ClaudeCodeRunner() },
  );

  const { skillOutput } = result;
  const candidates = [
    ...skillOutput.findings,
    ...skillOutput.debug.refuted,
    ...(skillOutput.debug.deduped ?? []),
  ];
  const { expected } = fixture;
  const hit = candidates.some(
    (f) =>
      f.path === expected.path &&
      f.line >= expected.lineMin &&
      f.line <= expected.lineMax,
  );

  return {
    density,
    replicate,
    hit,
    findingCount: candidates.length,
    costUsd: result.usage.cost_usd_est,
    locations: candidates.map((f) => `${f.path}:${f.line}`),
  };
}

const attempts: Attempt[] = [];
for (let r = 1; r <= REPLICATES; r++) {
  for (const density of ["sparse", "crowded"] as const) {
    const attempt = await runOnce(density, r);
    attempts.push(attempt);
    console.error(
      `[${density} #${r}] hit=${attempt.hit} findings=${attempt.findingCount} ` +
        `$${attempt.costUsd.toFixed(4)} ${attempt.locations.join(", ")}`,
    );
  }
}

const summarise = (density: Density) => {
  const rows = attempts.filter((a) => a.density === density);
  return {
    density,
    hits: rows.filter((a) => a.hit).length,
    runs: rows.length,
    mean_findings: Number(
      (rows.reduce((s, a) => s + a.findingCount, 0) / rows.length).toFixed(2),
    ),
    cost_usd: Number(rows.reduce((s, a) => s + a.costUsd, 0).toFixed(4)),
  };
};

console.log(
  `SUMMARY ${JSON.stringify({
    replicates: REPLICATES,
    sparse: summarise("sparse"),
    crowded: summarise("crowded"),
    total_cost_usd: Number(
      attempts.reduce((s, a) => s + a.costUsd, 0).toFixed(4),
    ),
  })}`,
);
console.log(JSON.stringify({ attempts }, null, 2));
