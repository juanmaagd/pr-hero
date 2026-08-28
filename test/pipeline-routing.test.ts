import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerBackend } from "../src/execution/contracts";
import { armOfRun, scoutFailed } from "../src/floor-test";
import { aliasCanonical, aliasModelFamily, aliasModelSnapshot } from "../src/model-catalog";
import type { RoutingConfig } from "../src/model-routing";
import { type PipelineInput, runPipeline } from "../src/pipeline";
import { rereviewDeltaFromProvenance } from "../src/report";
import type { ReviewSpec } from "../src/spec";
import type { StepResult, StepRunner, StepSpec } from "../src/step-runner";
import {
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
  RouteAdmissionError,
} from "../src/transport-registry";
import { countAttempts, parsePipelineMeta } from "../src/watch-preflight";

class RecordingStepRunner implements StepRunner {
  readonly executedSteps: StepSpec[] = [];

  constructor(
    private readonly handler?: (
      step: StepSpec,
    ) => Promise<StepResult> | StepResult,
  ) {}

  async run(step: StepSpec): Promise<StepResult> {
    this.executedSteps.push(step);
    if (this.handler) {
      return this.handler(step);
    }
    // Default ok response with empty findings
    const isRefuter = step.name.startsWith("refuter");
    const isSummarizer = step.name === "summarizer";
    const isScout = step.name === "scout";

    let resultText = "{}";
    let output: unknown = { findings: [] };

    if (isRefuter) {
      resultText = JSON.stringify({
        results: [
          {
            finding_id: step.name.replace(/^refuter-/, ""),
            verdict: "supported",
            rationale: "valid finding",
          },
        ],
      });
      output = {
        results: [
          {
            finding_id: step.name.replace(/^refuter-/, ""),
            verdict: "supported",
            rationale: "valid finding",
          },
        ],
      };
    } else if (isSummarizer) {
      resultText = JSON.stringify({ summary: "test summary" });
      output = { summary: "test summary" };
    } else if (isScout) {
      resultText = JSON.stringify({ leads: [] });
      output = { leads: [] };
    } else {
      // Hunter
      resultText = JSON.stringify({
        findings: [
          {
            id: "F001",
            path: "src/index.ts",
            line: 1,
            severity: "CRITICAL",
            claim: "Null pointer issue",
            proof_refs: ["src/index.ts:1"],
          },
        ],
      });
      output = {
        findings: [
          {
            id: "F001",
            path: "src/index.ts",
            line: 1,
            severity: "CRITICAL",
            claim: "Null pointer issue",
            proof_refs: ["src/index.ts:1"],
          },
        ],
      };
    }

    return {
      name: step.name,
      status: "ok",
      attempts: 1,
      usage: {
        tokens_total: 100,
        tokens_in: 80,
        tokens_out: 20,
        cost_usd_est: 0.001,
        wall_ms: 50,
      },
      stderrTail: "",
      resultText,
      output,
    };
  }
}

async function setupTestEnvironment() {
  const tmp = await mkdtemp(path.join(tmpdir(), "pr-hero-pipe-routing-"));
  const runDir = path.join(tmp, "run");
  const agentsDir = path.join(tmp, "agents");
  const worktree = path.join(tmp, "worktree");

  await mkdir(runDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(worktree, { recursive: true });

  await Bun.write(
    path.join(agentsDir, "reliability.md"),
    "---\nname: reliability\nmodel: sonnet\ntools: [Read, Grep]\n---\nYou are the reliability hunter.",
  );
  await Bun.write(
    path.join(agentsDir, "refuter.md"),
    "---\nname: refuter\nmodel: opus\ntools: [Read]\n---\nYou are the refuter.",
  );

  await mkdir(path.join(worktree, "src"), { recursive: true });
  await Bun.write(path.join(worktree, "src", "index.ts"), "const x = 2;\n");

  const diffPath = path.join(runDir, "diff.patch");
  await Bun.write(
    diffPath,
    "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  );

  const gotchasPath = path.join(runDir, "gotchas.json");
  await Bun.write(gotchasPath, "[]");

  const mcpConfigPath = path.join(runDir, "mcp.json");
  await Bun.write(mcpConfigPath, "{}");

  const spec: ReviewSpec = {
    agents: [
      {
        key: "reliability",
        file: "reliability.md",
        role: "hunter",
        model: "sonnet",
      },
      { key: "refuter", file: "refuter.md", role: "refuter", model: "opus" },
    ],
  };

  const input: PipelineInput = {
    pr: 42,
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    worktree,
    diffPath,
    gotchasPath,
    agentsDir,
    runDir,
    outPath: path.join(runDir, "findings.json"),
    mcpConfigPath,
    hopBudget: 2,
    parityTriggerPaths: [],
    suspicionPriors: [],
    spec,
  };

  const cleanup = async () => {
    await rm(tmp, { recursive: true, force: true });
  };

  return { tmp, runDir, agentsDir, worktree, spec, input, cleanup };
}

describe("Pipeline Model Routing & Provenance (D2 PR3)", () => {
  test("runPipeline resolves routePlan and threads ResolvedModelRoute into StepSpec", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const result = await runPipeline(env.input, { runner });

      expect(result.sessionFailed).toBe(false);
      expect(runner.executedSteps.length).toBeGreaterThanOrEqual(1);

      // Verify each executed step received a ResolvedModelRoute
      for (const step of runner.executedSteps) {
        expect(step.route).toBeDefined();
        expect(step.route?.backend).toBe("claude-code");
        expect(step.route?.provider).toBe("anthropic");
      }

      const hunterStep = runner.executedSteps.find(
        (s) => s.name === "hunter-reliability",
      );
      expect(hunterStep?.model).toBe("sonnet");
      expect(hunterStep).toBeDefined();
      expect(hunterStep?.route?.modelFamily).toBe(aliasModelFamily("sonnet"));

      // Check refuter step route
      const refuterStep = runner.executedSteps.find((s) =>
        s.name.startsWith("refuter-"),
      );
      expect(refuterStep).toBeDefined();
      expect(refuterStep?.route?.modelFamily).toBe(aliasModelFamily("opus"));
    } finally {
      await env.cleanup();
    }
  });

  test("refuter steps inherit resolved refuter route from the plan", async () => {
    const env = await setupTestEnvironment();
    try {
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: "opus",
            backend: "claude-code",
            provider: "anthropic",
            gateway: "direct",
            modelFamily: aliasModelFamily("opus"),
            modelSnapshot: `${aliasModelSnapshot("opus")}-20240229`,
          },
        ],
      };

      const runner = new RecordingStepRunner();
      await runPipeline({ ...env.input, routingConfig }, { runner });

      const refuterSteps = runner.executedSteps.filter((s) =>
        s.name.startsWith("refuter-"),
      );
      expect(refuterSteps.length).toBeGreaterThanOrEqual(1);

      for (const refuterStep of refuterSteps) {
        expect(refuterStep.route).toBeDefined();
        expect(refuterStep.route?.modelFamily).toBe(aliasModelFamily("opus"));
        expect(refuterStep.route?.modelSnapshot).toBe(
          `${aliasModelSnapshot("opus")}-20240229`,
        );
      }
    } finally {
      await env.cleanup();
    }
  });

  test("pipeline.json records deterministic routeFingerprint and routePlan matching result", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const result = await runPipeline(env.input, { runner });

      const pipelineJsonPath = path.join(env.runDir, "pipeline.json");
      const pipelineJsonRaw = await Bun.file(pipelineJsonPath).text();
      const pipelineJson = JSON.parse(pipelineJsonRaw);

      // Provenance contains routePlan and routeFingerprint
      expect(pipelineJson.routePlan || pipelineJson.route_plan).toBeDefined();
      expect(
        pipelineJson.routeFingerprint || pipelineJson.route_fingerprint,
      ).toBeDefined();

      const planFromArtifact =
        pipelineJson.routePlan ?? pipelineJson.route_plan;
      const fpFromArtifact =
        pipelineJson.routeFingerprint ?? pipelineJson.route_fingerprint;

      expect(typeof fpFromArtifact).toBe("string");
      expect(fpFromArtifact.length).toBe(64); // SHA-256 hex length
      expect(result.routeFingerprint).toBe(fpFromArtifact);
      expect(Array.isArray(planFromArtifact.steps)).toBe(true);

      // Ensure steps in pipeline.json also carry route dimensions
      const hunterMeta = pipelineJson.steps.find(
        (s: { name: string }) => s.name === "hunter-reliability",
      );
      expect(hunterMeta).toBeDefined();
      expect(hunterMeta.route).toBeDefined();
      expect(hunterMeta.route.backend).toBe("claude-code");
      expect(hunterMeta.route.provider).toBe("anthropic");
      expect(hunterMeta.route.modelFamily).toBe(aliasModelFamily("sonnet"));
    } finally {
      await env.cleanup();
    }
  });

  test("route admission gate rejects unregistered backend before step execution", async () => {
    const env = await setupTestEnvironment();
    try {
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: aliasCanonical("sonnet"),
            backend: "unregistered" as RunnerBackend,
            provider: "unknown",
          },
        ],
      };

      const runner = new RecordingStepRunner();
      const registry = new DefaultTransportRegistry();

      await expect(
        runPipeline(
          { ...env.input, routingConfig },
          { runner, transportRegistry: registry },
        ),
      ).rejects.toThrow(RouteAdmissionError);

      // No steps should have been executed
      expect(runner.executedSteps.length).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  test("route admission gate blocks opencode in production mode when missing D1-11 evidence", async () => {
    const env = await setupTestEnvironment();
    try {
      const routingConfig: RoutingConfig = {
        mappings: [
          {
            logical: aliasCanonical("sonnet"),
            backend: "opencode",
            provider: "openai",
          },
        ],
      };

      const runner = new RecordingStepRunner();
      const registry = new DefaultTransportRegistry();

      await expect(
        runPipeline(
          { ...env.input, routingConfig },
          { runner, transportRegistry: registry },
        ),
      ).rejects.toThrow(OpenCodeProductionGatedError);

      expect(runner.executedSteps.length).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  test("schema-1.1 tolerant old readers parse pipeline.json without error", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      await runPipeline(env.input, { runner });

      const pipelineJsonPath = path.join(env.runDir, "pipeline.json");
      const raw = await Bun.file(pipelineJsonPath).text();
      const parsed = JSON.parse(raw);

      // parsePipelineMeta
      const meta = parsePipelineMeta(raw);
      expect(meta).not.toBeNull();
      expect(meta?.pr).toBe(42);
      expect(meta?.head_sha).toBe("2222222222222222222222222222222222222222");

      // countAttempts
      const attemptCount = countAttempts(
        [
          {
            name: "pr-42-22222222-1",
            pipelineMeta: meta,
          },
        ],
        42,
        "2222222222222222222222222222222222222222",
      );
      expect(attemptCount).toBe(1);

      // floor-test armOfRun and scoutFailed
      expect(armOfRun(parsed)).toBe("control");
      expect(scoutFailed(parsed)).toBe(false);

      // rereviewDeltaFromProvenance with mock rereview block
      const delta = rereviewDeltaFromProvenance(
        { live: [{ status: "carried" }] },
        1,
      );
      expect(delta.carried).toBe(1);
      expect(delta.new).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  test("legacy Claude-only model strings run without D2 routes or provenance", async () => {
    const env = await setupTestEnvironment();
    try {
      const runner = new RecordingStepRunner();
      const result = await runPipeline(
        { ...env.input, model: "claude-opus-4-5" },
        { runner },
      );

      expect(result.routePlan).toBeUndefined();
      expect(result.routeFingerprint).toBeUndefined();
      for (const step of runner.executedSteps) {
        expect(step.model).toBe("claude-opus-4-5");
        expect(step.route).toBeUndefined();
      }

      const pipelineJson = JSON.parse(
        await Bun.file(path.join(env.runDir, "pipeline.json")).text(),
      );
      expect(pipelineJson.routePlan).toBeUndefined();
      expect(pipelineJson.route_plan).toBeUndefined();
      expect(parsePipelineMeta(JSON.stringify(pipelineJson))).not.toBeNull();
    } finally {
      await env.cleanup();
    }
  });
});
