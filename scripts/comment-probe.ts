// Comment-deference probe (ROADMAP A1 diagnostic — NOT a benchmark arm).
//
// Runs the REAL lifecycle agent, on the REAL model, against two byte-identical
// planted-latch repos that differ only in whether the effect carries a comment
// asserting its own re-arm correctness. See fixtures/comment-probe.ts for why.
//
// LIVE: spends real money. Budget it like any other live run and record the
// result (charter rule 6). Cost scales with replicates: the repo is five small
// files, so a run is a fraction of a benchmark replay.
//
// Run: bun run scripts/comment-probe.ts [replicates]
import path from "node:path";
import { buildProbeFixture, type ProbeVariant } from "../fixtures/comment-probe";
import { runPipeline } from "../src/pipeline";
import { resolveRunnerAuthority } from "../src/runner-authority";
import type { ReviewSpec } from "../src/spec";
import { ClaudeCodeRunner } from "../src/step-runner";

const REPLICATES = Number(process.argv[2] ?? 2);
const AGENT_SOURCE_PATH =
  "/Users/juanma/Desktop/deep-review/agents/slice3b-lifecycle-v2/deep-review-lifecycle.md";

// Only the pass under test. No refuter: this probe asks what the HUNTER sees,
// and a refuter verdict would confound that with a precision decision.
const PROBE_SPEC: ReviewSpec = {
  agents: [
    { key: "lifecycle", file: "deep-review-lifecycle.md", role: "hunter" },
  ],
};

const agentSource = await Bun.file(AGENT_SOURCE_PATH).text();

interface Attempt {
  variant: ProbeVariant;
  replicate: number;
  hit: boolean;
  findingCount: number;
  costUsd: number;
  locations: string[];
}

async function runOnce(
  variant: ProbeVariant,
  replicate: number,
): Promise<Attempt> {
  const fixture = await buildProbeFixture(variant, agentSource);

  // Empty MCP registry + the runner's --strict-mcp-config: the probe repo has
  // no codegraph index, so the agent works from Read/Grep/Glob and nothing
  // else can leak in. Identical for both variants.
  const mcpConfigPath = path.join(fixture.runDir, "mcp.json");
  await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

  const runnerAuthority = await resolveRunnerAuthority({
    workspaceRoot: fixture.repoDir,
  });
  if (runnerAuthority.error !== undefined) {
    throw new Error(
      `execution authority unavailable: ${runnerAuthority.error}`,
    );
  }

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
      suspicionPriors: [
        {
          path: "src/TrackWaveform.tsx",
          weight: "high",
          reason: "loading backstop added in this diff",
        },
      ],
      stepTimeoutMs: 10 * 60 * 1000,
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
  const { expected } = fixture;
  const hit = candidates.some(
    (f) =>
      f.path === expected.path &&
      f.line >= expected.lineMin &&
      f.line <= expected.lineMax,
  );

  return {
    variant,
    replicate,
    hit,
    findingCount: candidates.length,
    costUsd: result.usage.cost_usd_est,
    locations: candidates.map((f) => `${f.path}:${f.line}`),
  };
}

const attempts: Attempt[] = [];
// Interleaved rather than grouped, so any drift in service behaviour over the
// probe's wall-clock hits both variants evenly instead of loading one of them.
for (let r = 1; r <= REPLICATES; r++) {
  for (const variant of ["commented", "bare"] as const) {
    const attempt = await runOnce(variant, r);
    attempts.push(attempt);
    console.error(
      `[${variant} #${r}] hit=${attempt.hit} findings=${attempt.findingCount} ` +
        `$${attempt.costUsd.toFixed(4)} ${attempt.locations.join(", ")}`,
    );
  }
}

const summarise = (variant: ProbeVariant) => {
  const rows = attempts.filter((a) => a.variant === variant);
  return {
    variant,
    hits: rows.filter((a) => a.hit).length,
    runs: rows.length,
    cost_usd: Number(rows.reduce((s, a) => s + a.costUsd, 0).toFixed(4)),
  };
};

console.log(
  JSON.stringify(
    {
      replicates: REPLICATES,
      agent_source: AGENT_SOURCE_PATH,
      commented: summarise("commented"),
      bare: summarise("bare"),
      total_cost_usd: Number(
        attempts.reduce((s, a) => s + a.costUsd, 0).toFixed(4),
      ),
      attempts,
    },
    null,
    2,
  ),
);
