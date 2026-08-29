import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HunterDraft } from "../../src/drafts";
import { type PipelineInput, runPipeline } from "../../src/pipeline";
import { validateReviewSpec } from "../../src/spec";
import type { StepResult, StepRunner, StepSpec } from "../../src/step-runner";
import type { SessionUsage } from "../../src/usage";

function usage(): SessionUsage {
  return {
    wall_ms: 1_000,
    tokens_in: 100,
    tokens_out: 10,
    tokens_total: 110,
    cost_usd_est: 0.01,
  };
}

function ok(spec: StepSpec, output: unknown): StepResult {
  return {
    name: spec.name,
    status: "ok",
    output,
    usage: usage(),
    attempts: 1,
    stderrTail: "",
    resultText: "",
  };
}

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

async function makeAgentsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-diversity-agents-"));
  const hunterBody = [
    "---",
    "name: deep-review-reliability",
    "description: reliability hunter",
    "model: sonnet",
    `tools: ${HUNTER_TOOLS}`,
    "---",
    "",
    "{{PRIORS}}",
    "{{GOTCHAS}}",
    "",
  ].join("\n");
  await Bun.write(path.join(dir, "deep-review-reliability.md"), hunterBody);
  await Bun.write(
    path.join(dir, "review-refuter.md"),
    [
      "---",
      "name: review-refuter",
      "description: refuter",
      "model: sonnet",
      "tools: Read, Grep, Glob",
      "---",
      "",
      "Refute.",
      "",
    ].join("\n"),
  );
  return dir;
}

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

async function makeInput(): Promise<PipelineInput> {
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-diversity-run-"));
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(diffPath, PATCH);
  const gotchasPath = path.join(runDir, "gotchas.md");
  await Bun.write(gotchasPath, "G-01: gotcha.");
  return {
    pr: 1539,
    baseSha: "06e857b3",
    headSha: "4609456d",
    worktree: "/worktrees/dr-1539",
    diffPath,
    gotchasPath,
    agentsDir: await makeAgentsDir(),
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath: "/runs/mcp.json",
    hopBudget: 12,
    parityTriggerPaths: [],
    suspicionPriors: [],
    spec: validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "m6-diversity",
        maxLegs: 3,
        cashCapUsd: 25,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet", "opus"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    }),
  };
}

class DiversityFakeRunner implements StepRunner {
  readonly specs: StepSpec[] = [];

  async run(spec: StepSpec): Promise<StepResult> {
    this.specs.push(spec);
    if (spec.name.startsWith("hunter-reliability")) {
      return ok(spec, { findings: [] } satisfies HunterDraft);
    }
    throw new Error(`unscripted step ${spec.name}`);
  }
}

describe("pipeline diversity integration", () => {
  test("fans out admitted hunter legs and records diversity debug artifacts", async () => {
    const input = await makeInput();
    const runner = new DiversityFakeRunner();
    const result = await runPipeline(input, { runner });

    const hunterSteps = runner.specs.filter((spec) =>
      spec.name.startsWith("hunter-reliability"),
    );
    expect(hunterSteps).toHaveLength(2);
    expect(new Set(hunterSteps.map((spec) => spec.name)).size).toBe(2);

    const diversity = result.skillOutput.debug.diversity;
    expect(diversity).toBeDefined();
    expect(Array.isArray(diversity?.attempts)).toBe(true);
    expect(diversity?.attempts).toHaveLength(2);
    expect(result.skillOutput.run_status).toBe("complete");

    const pipelineJson = JSON.parse(
      await Bun.file(path.join(input.runDir, "pipeline.json")).text(),
    );
    expect(pipelineJson.multiModelDiversity?.enabled).toBe(true);
    expect(pipelineJson.multiModelDiversity?.legCount).toBe(2);
  });
});
