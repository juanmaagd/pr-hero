import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DraftFinding, HunterDraft, RefuterResult } from "../src/drafts";
import {
  mergeRunEnvelope,
  type SkillOutput,
  type Telemetry,
  validateFindingsDocument,
} from "../src/findings";
import {
  changedPathsFromDiff,
  type PipelineInput,
  parityTriggered,
  runPipeline,
} from "../src/pipeline";
import type { StepResult, StepRunner, StepSpec } from "../src/step-runner";
import type { SessionUsage } from "../src/usage";

// ---------------------------------------------------------------------------
// FakeStepRunner: scripted per-step-name results, records every spec it saw.
// An unscripted step name throws — the pipeline treating that as a failed
// refuter would mask a fan-out bug, so tests assert on `specs` names too.
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

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    wall_ms: 1_000,
    tokens_in: 100,
    tokens_out: 10,
    tokens_total: 110,
    cost_usd_est: 0.01,
    ...overrides,
  };
}

function ok(
  spec: StepSpec,
  output: unknown,
  usageOverrides: Partial<SessionUsage> = {},
): StepResult {
  return {
    name: spec.name,
    status: "ok",
    output,
    usage: usage(usageOverrides),
    attempts: 1,
    stderrTail: "",
    resultText: "",
  };
}

function failed(spec: StepSpec): StepResult {
  return {
    name: spec.name,
    status: "failed",
    usage: usage({ tokens_in: 5, tokens_out: 1, tokens_total: 6 }),
    attempts: 2,
    stderrTail: "API Error: Connection closed mid-response",
    resultText: "",
  };
}

function draft(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: "REL-1",
    category: 1,
    path: "src/app.ts",
    line: 10,
    symbol: "run",
    severity: "WARNING",
    evidence_class: "deterministic",
    causal_disposition: "introduced",
    claim: "value scaled twice along one path",
    proof_refs: ["src/app.ts:10"],
    hunter: "reliability",
    hops_used: 0,
    hop_trail: [],
    dedupe_key: "src/app.ts:run:1",
    ...overrides,
  };
}

function emptyDraft(): HunterDraft {
  return { findings: [] };
}

// ---------------------------------------------------------------------------
// Fixture builders: a minimal temp agents dir (real frontmatter format,
// {{PRIORS}}/{{GOTCHAS}} anchors in hunter bodies) and a PipelineInput over a
// temp run dir with a real-ish patch + gotchas file.
// ---------------------------------------------------------------------------

const HUNTER_TOOLS = "Read, Grep, Glob, mcp__codegraph__codegraph_explore";

async function makeAgentsDir(
  options: { model?: string } = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-agents-"));
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
      "Hunt bugs in the diff.",
      "",
      "## Priors",
      "",
      "{{PRIORS}}",
      "",
      "## Gotchas",
      "",
      "{{GOTCHAS}}",
      "",
    ].join("\n");
  for (const name of [
    "deep-review-reliability",
    "deep-review-resilience",
    "deep-review-parity",
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

const GOTCHAS = "G-01: seeded fixture values carry unit contracts.";

interface MakeInputOptions {
  gotchas?: string | null; // null = no file on disk
  patch?: string;
  agentsDir?: string;
}

async function makeInput(
  overrides: Partial<PipelineInput> = {},
  options: MakeInputOptions = {},
): Promise<PipelineInput> {
  const runDir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-"));
  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(diffPath, options.patch ?? PATCH);
  const gotchasPath = path.join(runDir, "gotchas.md");
  if (options.gotchas !== null) {
    await Bun.write(gotchasPath, options.gotchas ?? GOTCHAS);
  }
  return {
    pr: 1539,
    baseSha: "06e857b3",
    headSha: "4609456d",
    worktree: "/worktrees/dr-1539",
    diffPath,
    gotchasPath,
    agentsDir: options.agentsDir ?? (await makeAgentsDir()),
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath: "/runs/mcp.json",
    hopBudget: 12,
    parityTriggerPaths: [],
    suspicionPriors: [
      { path: "**/Project.ts", weight: "maximum", reason: "rank 1 hotspot" },
    ],
    ...overrides,
  };
}

const HUNTERS_OK: StepScript = {
  "hunter-reliability": (spec) => ok(spec, { findings: [draft()] }),
  "hunter-resilience": (spec) => ok(spec, emptyDraft()),
};

// ---------------------------------------------------------------------------
// Step 2 — gotchas fail-loud
// ---------------------------------------------------------------------------

describe("gotchas fail-loud", () => {
  const PARTIAL_EMPTY: SkillOutput = {
    findings: [],
    debug: { refuted: [] },
    parity_hunter_fired: false,
    run_status: "partial",
  };

  test("missing gotchas file short-circuits with zero steps run", async () => {
    const runner = new FakeStepRunner(HUNTERS_OK);
    const input = await makeInput({}, { gotchas: null });
    const result = await runPipeline(input, { runner });
    expect(result.skillOutput).toEqual(PARTIAL_EMPTY);
    expect(result.sessionFailed).toBe(false);
    expect(result.perAgent).toEqual({});
    expect(result.usage.tokens_total).toBe(0);
    expect(runner.specs.length).toBe(0);
  });

  test("empty gotchas content short-circuits identically", async () => {
    const runner = new FakeStepRunner(HUNTERS_OK);
    const input = await makeInput({}, { gotchas: "" });
    const result = await runPipeline(input, { runner });
    expect(result.skillOutput).toEqual(PARTIAL_EMPTY);
    expect(runner.specs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — changed paths + parity trigger (pure)
// ---------------------------------------------------------------------------

describe("changedPathsFromDiff", () => {
  test("reads +++ b/ headers, rename-to lines, skips /dev/null", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/old.ts b/src/renamed.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/renamed.ts",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "",
    ].join("\n");
    expect(changedPathsFromDiff(patch)).toEqual(["src/a.ts", "src/renamed.ts"]);
  });
});

describe("parityTriggered", () => {
  test("plain glob hit", () => {
    expect(
      parityTriggered(
        ["packages/common/lib/dtos/FileDto.ts"],
        ["packages/common/lib/dtos/**"],
      ),
    ).toBe(true);
  });

  test("substring hit across a directory component (JD edge)", () => {
    // `*` does not cross `/`, so the glob alone misses this path — the
    // prose's contains-semantics must still fire.
    expect(
      parityTriggered(
        ["src/AbortFileMultipartUpload/index.ts"],
        ["**/AbortFileMultipartUpload*"],
      ),
    ).toBe(true);
  });

  test("no match", () => {
    expect(
      parityTriggered(
        ["src/other/Thing.ts"],
        ["**/FileUploaderStore.ts", "packages/common/lib/dtos/**"],
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — hunter fan-out, templating, models, stamping, failures
// ---------------------------------------------------------------------------

describe("hunter fan-out", () => {
  test("spawns the two fixed hunters when parity does not fire", async () => {
    const runner = new FakeStepRunner(HUNTERS_OK);
    const input = await makeInput();
    const result = await runPipeline(input, { runner });
    expect(runner.specs.map((s) => s.name)).toEqual([
      "hunter-reliability",
      "hunter-resilience",
    ]);
    expect(result.skillOutput.parity_hunter_fired).toBe(false);
    // The user prompt carries the diff, the hop budget, the self-report
    // note, and the output contract.
    const prompt = runner.specs[0]?.prompt ?? "";
    expect(prompt).toContain("+++ b/src/app.ts");
    expect(prompt).toContain("Hop budget: 12");
    expect(prompt).toContain("self-reported");
    expect(prompt).toContain('{"findings":[]}');
  });

  test("adds the parity hunter when a trigger path matches", async () => {
    const runner = new FakeStepRunner({
      ...HUNTERS_OK,
      "hunter-parity": (spec) => ok(spec, emptyDraft()),
    });
    const input = await makeInput({ parityTriggerPaths: ["**/app.ts"] });
    const result = await runPipeline(input, { runner });
    expect(runner.specs.map((s) => s.name)).toEqual([
      "hunter-reliability",
      "hunter-resilience",
      "hunter-parity",
    ]);
    expect(result.skillOutput.parity_hunter_fired).toBe(true);
  });

  test("writes system prompts with anchors replaced", async () => {
    const runner = new FakeStepRunner(HUNTERS_OK);
    const input = await makeInput();
    await runPipeline(input, { runner });
    const systemPromptPath = runner.specs[0]?.systemPromptPath ?? "";
    expect(systemPromptPath).toBe(
      path.join(input.runDir, "steps", "hunter-reliability.system.md"),
    );
    const rendered = await Bun.file(systemPromptPath).text();
    expect(rendered).toContain(
      "- **/Project.ts (weight maximum): rank 1 hotspot",
    );
    expect(rendered).toContain(GOTCHAS);
    expect(rendered).not.toContain("{{PRIORS}}");
    expect(rendered).not.toContain("{{GOTCHAS}}");
  });

  test("input.model overrides agent frontmatter for every step", async () => {
    const runner = new FakeStepRunner(HUNTERS_OK);
    const input = await makeInput(
      { model: "claude-opus-4-5" },
      { agentsDir: await makeAgentsDir({ model: "haiku" }) },
    );
    await runPipeline(input, { runner });
    for (const spec of runner.specs) {
      expect(spec.model).toBe("claude-opus-4-5");
    }
  });

  test("frontmatter model is used when no override is given", async () => {
    const runner = new FakeStepRunner(HUNTERS_OK);
    const input = await makeInput(
      {},
      { agentsDir: await makeAgentsDir({ model: "haiku" }) },
    );
    await runPipeline(input, { runner });
    for (const spec of runner.specs) {
      expect(spec.model).toBe("haiku");
    }
  });

  test("driver stamping overrides a lying draft hunter field", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, { findings: [draft({ hunter: "parity" })] }),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(result.skillOutput.findings[0]?.hunter).toBe("reliability");
  });

  test("parse accepts a draft whose hunter field is not even a valid enum value", async () => {
    // Regression from the first live fixture run: hunters self-reported their
    // agent name ("fixture-reliability-hunter"), which failed validation on a
    // field the driver overwrites anyway. Stamping now happens before
    // validation, so delivery must survive any hunter-field garbage.
    const rogue = {
      findings: [{ ...draft(), hunter: "fixture-reliability-hunter" }],
    };
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, spec.parse(JSON.stringify(rogue))),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(result.skillOutput.findings[0]?.hunter).toBe("reliability");
  });

  test("one failed hunter keeps the other's survivors, run partial", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) => ok(spec, { findings: [draft()] }),
      "hunter-resilience": (spec) => failed(spec),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(result.skillOutput.run_status).toBe("partial");
    expect(result.skillOutput.findings.length).toBe(1);
    expect(result.sessionFailed).toBe(false);
    expect(result.perAgent.resilience?.status).toBe("failed");
  });

  test("ALL hunters failing sets sessionFailed", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) => failed(spec),
      "hunter-resilience": (spec) => failed(spec),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(result.sessionFailed).toBe(true);
    expect(result.skillOutput.run_status).toBe("partial");
    expect(result.skillOutput.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step 5 — dedupe integration
// ---------------------------------------------------------------------------

describe("dedupe integration", () => {
  test("same dedupe_key across hunters collapses to one survivor", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, {
          findings: [draft({ severity: "BLOCKER", proof_refs: ["a", "b"] })],
        }),
      "hunter-resilience": (spec) =>
        ok(spec, {
          findings: [draft({ id: "RES-1", severity: "WARNING" })],
        }),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(result.skillOutput.findings.length).toBe(1);
    expect(result.skillOutput.findings[0]?.id).toBe("F001");
    expect(result.skillOutput.findings[0]?.severity).toBe("BLOCKER");
    const deduped = result.skillOutput.debug.deduped ?? [];
    expect(deduped.length).toBe(1);
    expect(deduped[0]?.merged_into).toBe("F001");
    expect(deduped[0]?.hunter).toBe("resilience");
  });
});

// ---------------------------------------------------------------------------
// Step 6 — refuter batch / skip / failure; Step 7 — verdict mapping
// ---------------------------------------------------------------------------

describe("refuter", () => {
  const inferentialBlocker = (id: string, line: number) =>
    draft({
      id,
      line,
      symbol: `sym${line}`,
      severity: "BLOCKER",
      evidence_class: "inferential",
      dedupe_key: `src/app.ts:sym${line}:1`,
    });

  test("skips entirely when no inferential BLOCKER/CRITICAL survives", async () => {
    // deterministic BLOCKER + inferential WARNING: neither qualifies.
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, {
          findings: [
            draft({ severity: "BLOCKER", evidence_class: "deterministic" }),
            draft({
              id: "REL-2",
              symbol: "other",
              severity: "WARNING",
              evidence_class: "inferential",
              dedupe_key: "src/app.ts:other:1",
            }),
          ],
        }),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(runner.specs.map((s) => s.name)).not.toContain("refuter");
    for (const finding of result.skillOutput.findings) {
      expect(finding.refuter_verdict).toBe("not_submitted");
    }
    expect(result.perAgent.refuter).toBeUndefined();
    expect(result.skillOutput.run_status).toBe("complete");
  });

  test("writes the batch file and inlines it in the prompt", async () => {
    let refuterSpec: StepSpec | undefined;
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, { findings: [inferentialBlocker("REL-1", 10)] }),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
      refuter: (spec) => {
        refuterSpec = spec;
        return ok(spec, {
          results: [
            { finding_id: "F001", outcome: "corroborated", proof_refs: [] },
          ],
        } satisfies RefuterResult);
      },
    });
    const input = await makeInput();
    await runPipeline(input, { runner });
    const batch = (await Bun.file(
      path.join(input.runDir, "steps", "refuter-batch.json"),
    ).json()) as Array<Record<string, unknown>>;
    expect(batch.length).toBe(1);
    expect(batch[0]?.id).toBe("F001");
    expect(batch[0]?.location).toBe("src/app.ts:10");
    expect(batch[0]?.severity).toBe("BLOCKER");
    // Batch CONTENT travels inline in the prompt, not as a path.
    expect(refuterSpec?.prompt).toContain('"location": "src/app.ts:10"');
  });

  test("maps verdicts: corroborated blocks, inconclusive advises, refuted moves to debug", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, {
          findings: [
            inferentialBlocker("REL-1", 10),
            inferentialBlocker("REL-2", 20),
            inferentialBlocker("REL-3", 30),
          ],
        }),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
      refuter: (spec) =>
        ok(spec, {
          results: [
            { finding_id: "F001", outcome: "corroborated", proof_refs: [] },
            { finding_id: "F002", outcome: "inconclusive", proof_refs: [] },
            { finding_id: "F003", outcome: "refuted", proof_refs: [] },
          ],
        } satisfies RefuterResult),
    });
    const result = await runPipeline(await makeInput(), { runner });
    const byId = new Map(
      result.skillOutput.findings.map((f) => [f.id, f] as const),
    );
    expect(byId.get("F001")?.tier).toBe("blocking");
    expect(byId.get("F001")?.refuter_verdict).toBe("corroborated");
    expect(byId.get("F002")?.tier).toBe("advisory");
    expect(byId.get("F003")).toBeUndefined();
    const refuted = result.skillOutput.debug.refuted;
    expect(refuted.length).toBe(1);
    expect(refuted[0]?.id).toBe("F003");
    // tier is STRIPPED, not just nulled, on a refuted finding.
    expect("tier" in (refuted[0] as object)).toBe(false);
    expect(result.skillOutput.run_status).toBe("complete");
  });

  test("refuter failure marks every submitted finding inconclusive", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, {
          findings: [
            inferentialBlocker("REL-1", 10),
            inferentialBlocker("REL-2", 20),
          ],
        }),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
      refuter: (spec) => failed(spec),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(result.skillOutput.run_status).toBe("partial");
    expect(result.skillOutput.findings.length).toBe(2);
    for (const finding of result.skillOutput.findings) {
      // Conservative default: never deleted, never blocking.
      expect(finding.refuter_verdict).toBe("inconclusive");
      expect(finding.tier).toBe("advisory");
    }
    expect(result.perAgent.refuter?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Step 8 — output validity, provenance, telemetry
// ---------------------------------------------------------------------------

describe("assembly", () => {
  test("SkillOutput survives the full envelope round-trip", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, {
          findings: [
            draft({ severity: "BLOCKER", evidence_class: "deterministic" }),
          ],
        }),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
    });
    const result = await runPipeline(await makeInput(), { runner });
    const telemetry: Telemetry = {
      index_ms: 0,
      index_mode: "fresh",
      index_disk_mb: 0,
      wall_ms: result.usage.wall_ms,
      tokens_in: result.usage.tokens_in,
      tokens_out: result.usage.tokens_out,
      tokens_total: result.usage.tokens_total,
      cost_usd_est: result.usage.cost_usd_est,
      per_agent: result.perAgent,
    };
    const doc = mergeRunEnvelope({
      skillOutput: result.skillOutput,
      pr: 1539,
      base_sha: "06e857b3",
      head_sha: "4609456d",
      model: "sonnet",
      iteration: 900,
      sessionFailed: result.sessionFailed,
      telemetry,
    });
    expect(() => validateFindingsDocument(doc)).not.toThrow();
    expect(doc.run_status).toBe("complete");
    expect(doc.findings[0]?.tier).toBe("blocking");
  });

  test("writes pipeline.json with the resolved plan sans prompts", async () => {
    const runner = new FakeStepRunner(HUNTERS_OK);
    const input = await makeInput();
    await runPipeline(input, { runner });
    const plan = (await Bun.file(
      path.join(input.runDir, "pipeline.json"),
    ).json()) as {
      pr: number;
      parity_hunter_fired: boolean;
      steps: Array<Record<string, unknown>>;
    };
    expect(plan.pr).toBe(1539);
    expect(plan.parity_hunter_fired).toBe(false);
    expect(plan.steps.map((s) => s.name)).toEqual([
      "hunter-reliability",
      "hunter-resilience",
    ]);
    for (const step of plan.steps) {
      expect(step.model).toBe("sonnet");
      expect(step.tools).toEqual([
        "Read",
        "Grep",
        "Glob",
        "mcp__codegraph__codegraph_explore",
      ]);
      expect(typeof step.outPath).toBe("string");
      expect("prompt" in step).toBe(false);
    }
  });

  test("no spec: step names and per_agent keys are byte-identical to the pre-spec wiring", async () => {
    // Pipeline-as-data behavior-preservation proof: runPipeline WITHOUT a
    // spec must produce exactly the step names and per_agent keys the
    // hard-coded wiring produced — parity conditional on
    // input.parityTriggerPaths, refuter fed by the inferential-blocker batch.
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(spec, {
          findings: [
            draft({ severity: "BLOCKER", evidence_class: "inferential" }),
          ],
        }),
      "hunter-resilience": (spec) => ok(spec, emptyDraft()),
      "hunter-parity": (spec) => ok(spec, emptyDraft()),
      refuter: (spec) =>
        ok(spec, {
          results: [
            { finding_id: "F001", outcome: "corroborated", proof_refs: [] },
          ],
        } satisfies RefuterResult),
    });
    const input = await makeInput({ parityTriggerPaths: ["**/app.ts"] });
    expect(input.spec).toBeUndefined();
    const result = await runPipeline(input, { runner });
    expect(runner.specs.map((s) => s.name)).toEqual([
      "hunter-reliability",
      "hunter-resilience",
      "hunter-parity",
      "refuter",
    ]);
    expect(Object.keys(result.perAgent).sort()).toEqual([
      "parity",
      "refuter",
      "reliability",
      "resilience",
    ]);
    expect(result.skillOutput.parity_hunter_fired).toBe(true);
  });

  test("perAgent carries per-step usage and totals sum over steps", async () => {
    const runner = new FakeStepRunner({
      "hunter-reliability": (spec) =>
        ok(
          spec,
          { findings: [draft()] },
          {
            wall_ms: 2_000,
            tokens_in: 300,
            tokens_out: 30,
            tokens_total: 330,
            cost_usd_est: 0.05,
          },
        ),
      "hunter-resilience": (spec) =>
        ok(spec, emptyDraft(), {
          wall_ms: 1_500,
          tokens_in: 200,
          tokens_out: 20,
          tokens_total: 220,
          cost_usd_est: 0.03,
        }),
    });
    const result = await runPipeline(await makeInput(), { runner });
    expect(Object.keys(result.perAgent).sort()).toEqual([
      "reliability",
      "resilience",
    ]);
    expect(result.perAgent.reliability).toEqual({
      tokens_total: 330,
      duration_ms: 2_000,
      tokens_in: 300,
      tokens_out: 30,
      cost_usd_est: 0.05,
      attempts: 1,
      status: "ok",
    });
    expect(result.usage.tokens_total).toBe(550);
    expect(result.usage.wall_ms).toBe(3_500);
    expect(result.usage.cost_usd_est).toBeCloseTo(0.08);
  });
});
