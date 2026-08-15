// Slice-4 fixture eval (plan §Evals, slice 4b): the ENTIRE live pipeline —
// real Claude sessions, real git repo, real diff — against the planted
// fixture, asserted against its answer key. Costs cents (haiku frontmatter).
// Proves plumbing + contract end-to-end, NOT recall quality (the lab's job).
// Run: bun run fixture-eval
import path from "node:path";
import { buildPlantedFixture } from "../fixtures/setup";
import { validateFinding } from "../src/findings";
import { runPipeline } from "../src/pipeline";
import { ClaudeCodeRunner } from "../src/step-runner";

const SUMMARIZER_PROMPT_PATH = path.join(
  import.meta.dir,
  "..",
  "prompts",
  "summarizer.md",
);

const fixture = await buildPlantedFixture();

// Empty MCP registry + the runner's --strict-mcp-config: the fixture repo has
// no codegraph index, so the steps run on Read/Grep/Glob alone and no other
// MCP source can leak in.
const mcpConfigPath = path.join(fixture.runDir, "mcp.json");
await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

const started = performance.now();
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
    // The pipeline never writes outPath (the caller's job) — recorded here
    // only so pipeline.json carries the full resolved plan.
    outPath: path.join(fixture.runDir, "findings.json"),
    mcpConfigPath,
    hopBudget: 4,
    // No `model` override: the fixture frontmatter's haiku wins (plumbing
    // proof, not recall quality — see fixtures/setup.ts).
    summarizer: { promptPath: SUMMARIZER_PROMPT_PATH },
    parityTriggerPaths: [], // parity never fires — 2 hunters, cheapest run
    suspicionPriors: [
      {
        path: "src/volume.ts",
        weight: "high",
        reason: "volume/gain scaling changed in this diff",
      },
    ],
    stepTimeoutMs: 10 * 60 * 1000,
  },
  { runner: new ClaudeCodeRunner() },
);
const wallMs = Math.round(performance.now() - started);

const failures: string[] = [];
const { skillOutput } = result;

// (1) Structural: the SkillOutput draft must already be schema-shaped —
// findings is an array of validator-clean findings and the run completed.
if (Array.isArray(skillOutput.findings)) {
  for (const [i, finding] of skillOutput.findings.entries()) {
    try {
      validateFinding(finding, i);
    } catch (error) {
      failures.push(`findings[${i}] invalid: ${(error as Error).message}`);
    }
  }
} else {
  failures.push("skillOutput.findings is not an array");
}
if (skillOutput.run_status !== "complete") {
  failures.push(
    `run_status is "${skillOutput.run_status}", expected "complete"`,
  );
}

// (2) The planted-defect hit. Searched across findings[] AND the debug
// arrays: a haiku refuter may kill the planted finding, and dedupe may fold
// it into a sibling — the eval proves PLUMBING, so an emission that reached
// the pipeline counts even when refutation or a merge buried it. Overlap
// semantics only (path match + line inside the range), never exact-claim
// matching — see PlantedFixture.expected.
const candidates = [
  ...skillOutput.findings,
  ...skillOutput.debug.refuted,
  ...(skillOutput.debug.deduped ?? []),
];
const { expected } = fixture;
const hit = candidates.find(
  (f) =>
    f.path === expected.path &&
    f.line >= expected.lineMin &&
    f.line <= expected.lineMax,
);
if (!hit) {
  failures.push(
    `no finding overlaps the planted defect at ${expected.path}:` +
      `${expected.lineMin}-${expected.lineMax} ` +
      `(${candidates.length} candidate(s) emitted)`,
  );
}

// (3) Run-dir artifacts: every hunter that ran must have left its templated
// system prompt and its delivered draft next to each other in steps/.
const hunters = [
  "reliability",
  "resilience",
  ...(skillOutput.parity_hunter_fired ? ["parity"] : []),
];
for (const hunter of hunters) {
  for (const suffix of ["system.md", "draft.json"]) {
    const artifact = path.join(
      fixture.runDir,
      "steps",
      `hunter-${hunter}.${suffix}`,
    );
    if (!(await Bun.file(artifact).exists())) {
      failures.push(`missing step artifact: ${artifact}`);
    }
  }
}

// (4) Frozen-plan provenance.
if (!(await Bun.file(path.join(fixture.runDir, "pipeline.json")).exists())) {
  failures.push("missing pipeline.json in run dir");
}

// (5) Per-agent telemetry: each hunter ran as its own session, so each must
// have a real (non-zero) token bill.
for (const hunter of hunters) {
  const entry = result.perAgent[hunter];
  if (!entry) {
    failures.push(`perAgent has no entry for ${hunter}`);
  } else if (entry.tokens_total <= 0) {
    failures.push(`perAgent.${hunter}.tokens_total is ${entry.tokens_total}`);
  }
}

const pass = failures.length === 0;
console.log(
  JSON.stringify(
    {
      pass,
      cost_usd: result.usage.cost_usd_est,
      wall_ms: wallMs,
      findings_count: skillOutput.findings.length,
      hit: hit ? { path: hit.path, line: hit.line } : null,
      run_dir: fixture.runDir,
      ...(pass ? {} : { failures }),
    },
    null,
    2,
  ),
);
if (!pass) process.exit(1);
