import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DraftFinding, HunterDraft } from "../src/drafts";
import { type PipelineInput, runPipeline } from "../src/pipeline";
import {
  type AgentSpec,
  defaultReviewSpec,
  type ReviewSpec,
  ReviewSpecValidationError,
  validateReviewSpec,
} from "../src/spec";
import type { StepResult, StepRunner, StepSpec } from "../src/step-runner";
import type { SessionUsage } from "../src/usage";

// ---------------------------------------------------------------------------
// Minimal fixtures — same shapes as pipeline.test.ts, trimmed to what the
// spec-driven paths exercise.
// ---------------------------------------------------------------------------

type StepScript = Record<string, (spec: StepSpec) => StepResult>;

class FakeStepRunner implements StepRunner {
  readonly specs: StepSpec[] = [];
  constructor(private readonly script: StepScript) {}
  async run(spec: StepSpec): Promise<StepResult> {
    this.specs.push(spec);
    const handler = this.script[spec.name];
    if (!handler) throw new Error(`unscripted step ${spec.name}`);
    return handler(spec);
  }
}

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

function emptyDraft(): HunterDraft {
  return { findings: [] };
}

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

async function makeAgentsDir(
  options: { model?: string } = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-spec-agents-"));
  const model = options.model ?? "sonnet";
  const hunterFile = (name: string) =>
    [
      "---",
      `name: ${name}`,
      `description: ${name} hunter`,
      `model: ${model}`,
      `tools: ${HUNTER_TOOLS}`,
      "---",
      "",
      `# ${name}`,
      "",
      "{{PRIORS}}",
      "{{GOTCHAS}}",
      "",
    ].join("\n");
  for (const name of [
    "deep-review-reliability",
    "deep-review-resilience",
    "deep-review-parity",
    "custom-parity-always",
  ]) {
    await Bun.write(path.join(dir, `${name}.md`), hunterFile(name));
  }
  await Bun.write(
    path.join(dir, "review-refuter.md"),
    [
      "---",
      "name: review-refuter",
      "description: detached refuter",
      `model: ${model}`,
      "tools: Read, Grep, Glob",
      "---",
      "",
      "Refute or corroborate.",
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

async function makeInput(
  overrides: Partial<PipelineInput> = {},
): Promise<PipelineInput> {
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-spec-run-"));
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
    ...overrides,
  };
}

function hunter(key: string, overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    key,
    file: `deep-review-${key}.md`,
    role: "hunter",
    ...overrides,
  };
}

const REFUTER: AgentSpec = {
  key: "refuter",
  file: "review-refuter.md",
  role: "refuter",
};

// ---------------------------------------------------------------------------
// validateReviewSpec
// ---------------------------------------------------------------------------

describe("validateReviewSpec", () => {
  test("rejects duplicate keys", () => {
    const spec: ReviewSpec = {
      agents: [hunter("reliability"), hunter("reliability")],
    };
    expect(() => validateReviewSpec(spec)).toThrow(ReviewSpecValidationError);
    expect(() => validateReviewSpec(spec)).toThrow(/duplicates/);
  });

  test("rejects two refuters", () => {
    const spec: ReviewSpec = {
      agents: [
        hunter("reliability"),
        REFUTER,
        { key: "refuter-2", file: "review-refuter.md", role: "refuter" },
      ],
    };
    expect(() => validateReviewSpec(spec)).toThrow(/at most one refuter/);
  });

  test("rejects zero hunters", () => {
    expect(() => validateReviewSpec({ agents: [REFUTER] })).toThrow(
      /at least one hunter/,
    );
  });

  test("rejects a bad role and an empty file", () => {
    expect(() =>
      validateReviewSpec({
        agents: [{ key: "reliability", file: "x.md", role: "judge" }],
      }),
    ).toThrow(/role must be hunter\|refuter/);
    expect(() =>
      validateReviewSpec({
        agents: [{ key: "reliability", file: "", role: "hunter" }],
      }),
    ).toThrow(/file required/);
  });

  test("rejects hunter keys outside the schema v1.0.0 Hunter enum", () => {
    // The findings schema stamps `hunter` with the step key and its enum is
    // closed — schema v1.1 lifts this, the engine itself is key-agnostic.
    expect(() => validateReviewSpec({ agents: [hunter("security")] })).toThrow(
      /Hunter enum/,
    );
  });

  test("default spec is today's wiring exactly", () => {
    expect(validateReviewSpec(defaultReviewSpec())).toEqual({
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
        },
        {
          key: "resilience",
          file: "deep-review-resilience.md",
          role: "hunter",
        },
        {
          key: "parity",
          file: "deep-review-parity.md",
          role: "hunter",
          trigger: "input",
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// runPipeline over custom specs
// ---------------------------------------------------------------------------

describe("pipeline with a custom spec", () => {
  test("a third always-hunter runs unconditionally", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) => ok(spec, emptyDraft()),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
      "hunter-parity": (spec) => ok(spec, emptyDraft()),
    });
    const input = await makeInput({
      spec: {
        agents: [
          hunter("reliability"),
          hunter("resilience"),
          // No trigger: parity promoted to an always-hunter, custom file.
          hunter("parity", { file: "custom-parity-always.md" }),
          REFUTER,
        ],
      },
    });
    const result = await runPipeline(input, { runner });
    expect(runner.specs.map((s) => s.name)).toEqual([
      "hunter-reliability",
      "hunter-resilience",
      "hunter-parity",
    ]);
    expect(Object.keys(result.perAgent).sort()).toEqual([
      "parity",
      "reliability",
      "resilience",
    ]);
    // No conditional hunter ran — the field tracks TRIGGERED hunters only.
    expect(result.skillOutput.parity_hunter_fired).toBe(false);
  });

  test("removing resilience leaves only reliability running", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) => ok(spec, emptyDraft()),
    });
    const input = await makeInput({
      spec: { agents: [hunter("reliability"), REFUTER] },
    });
    const result = await runPipeline(input, { runner });
    expect(runner.specs.map((s) => s.name)).toEqual(["hunter-reliability"]);
    expect(Object.keys(result.perAgent)).toEqual(["reliability"]);
    expect(result.skillOutput.run_status).toBe("complete");
  });

  test("trigger globs gate a conditional hunter by changed paths", async () => {
    const spec = (patterns: string[]): ReviewSpec => ({
      agents: [
        hunter("reliability"),
        hunter("parity", { trigger: patterns }),
        REFUTER,
      ],
    });
    const script: StepScript = {
      "hunter-reliability": (s) => ok(s, emptyDraft()),
      "hunter-parity": (s) => ok(s, emptyDraft()),
    };
    // PATCH touches src/app.ts — matching glob fires the hunter...
    const firing = new FakeStepRunner(script);
    const fired = await runPipeline(
      await makeInput({ spec: spec(["**/app.ts"]) }),
      { runner: firing },
    );
    expect(firing.specs.map((s) => s.name)).toContain("hunter-parity");
    expect(fired.skillOutput.parity_hunter_fired).toBe(true);
    // ...and a non-matching glob skips it.
    const skipping = new FakeStepRunner(script);
    const skipped = await runPipeline(
      await makeInput({ spec: spec(["**/nothing-here.ts"]) }),
      { runner: skipping },
    );
    expect(skipping.specs.map((s) => s.name)).toEqual(["hunter-reliability"]);
    expect(skipped.skillOutput.parity_hunter_fired).toBe(false);
  });

  test('trigger "input" resolves input.parityTriggerPaths', async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (s) => ok(s, emptyDraft()),
      "hunter-parity": (s) => ok(s, emptyDraft()),
    });
    const input = await makeInput({
      parityTriggerPaths: ["**/app.ts"],
      spec: {
        agents: [
          hunter("reliability"),
          hunter("parity", { trigger: "input" }),
          REFUTER,
        ],
      },
    });
    const result = await runPipeline(input, { runner });
    expect(runner.specs.map((s) => s.name)).toEqual([
      "hunter-reliability",
      "hunter-parity",
    ]);
    expect(result.skillOutput.parity_hunter_fired).toBe(true);
  });

  test("model precedence: input.model > spec.model > frontmatter", async () => {
    const agentsDir = await makeAgentsDir({ model: "frontmatter-model" });
    const specWith = (model?: string): ReviewSpec => ({
      agents: [hunter("reliability", model ? { model } : {}), REFUTER],
    });
    const script: StepScript = {
      "hunter-reliability": (s) => ok(s, emptyDraft()),
    };
    // spec.model beats frontmatter...
    const specWins = new FakeStepRunner(script);
    await runPipeline(
      await makeInput({ agentsDir, spec: specWith("spec-model") }),
      { runner: specWins },
    );
    expect(specWins.specs[0]?.model).toBe("spec-model");
    // ...input.model beats both...
    const inputWins = new FakeStepRunner(script);
    await runPipeline(
      await makeInput({
        agentsDir,
        model: "cli-model",
        spec: specWith("spec-model"),
      }),
      { runner: inputWins },
    );
    expect(inputWins.specs[0]?.model).toBe("cli-model");
    // ...frontmatter is the fallback when neither override exists.
    const frontmatter = new FakeStepRunner(script);
    await runPipeline(await makeInput({ agentsDir, spec: specWith() }), {
      runner: frontmatter,
    });
    expect(frontmatter.specs[0]?.model).toBe("frontmatter-model");
  });

  test("a spec without a refuter skips the leg, findings not_submitted", async () => {
    const blocker: DraftFinding = {
      id: "REL-1",
      category: 1,
      path: "src/app.ts",
      line: 10,
      symbol: "run",
      severity: "BLOCKER",
      evidence_class: "inferential",
      causal_disposition: "introduced",
      claim: "inferential blocker with no refuter configured",
      proof_refs: ["src/app.ts:10"],
      hunter: "reliability",
      hops_used: 0,
      hop_trail: [],
      dedupe_key: "src/app.ts:run:1",
    };
    const runner = new FakeStepRunner({
      "hunter-reliability": (s) => ok(s, { findings: [blocker] }),
    });
    const input = await makeInput({
      spec: { agents: [hunter("reliability")] },
    });
    const result = await runPipeline(input, { runner });
    expect(runner.specs.map((s) => s.name)).toEqual(["hunter-reliability"]);
    // Configured absence, not failure: complete run, advisory tier (an
    // inferential blocker can never block without corroboration).
    expect(result.skillOutput.run_status).toBe("complete");
    expect(result.skillOutput.findings[0]?.refuter_verdict).toBe(
      "not_submitted",
    );
    expect(result.skillOutput.findings[0]?.tier).toBe("advisory");
  });

  test("an invalid input.spec fails the run loudly before any step", async () => {
    const runner = new FakeStepRunner({});
    const input = await makeInput({ spec: { agents: [] } });
    await expect(runPipeline(input, { runner })).rejects.toThrow(
      ReviewSpecValidationError,
    );
    expect(runner.specs.length).toBe(0);
  });
});
