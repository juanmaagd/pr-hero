import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  TransportOutcome,
} from "../../src/execution/contracts";
import {
  projectChildEnv,
  StepExecutionHarness,
} from "../../src/execution/harness";

describe("projectChildEnv", () => {
  test("passes through only enumerated keys and never GIT_*", () => {
    const projected = projectChildEnv({
      HOME: "/Users/juanma",
      USER: "juanma",
      PATH: "/usr/bin:/bin",
      GIT_DIR: "/evil/.git",
      GIT_WORK_TREE: "/evil",
      ANTHROPIC_API_KEY: "sk-test",
      OPERATOR_SECRET: "leak-me",
    });
    expect(projected).toEqual({
      HOME: "/Users/juanma",
      USER: "juanma",
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "sk-test",
    });
  });

  test("omits unset keys instead of writing empty strings", () => {
    const projected = projectChildEnv({ HOME: "/h", HTTPS_PROXY: undefined });
    expect(Object.keys(projected)).toEqual(["HOME"]);
  });

  test("the harness hands the projected env to the transport request", async () => {
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => {
        throw new Error("not used");
      },
      classifyFailure: () => undefined,
      async execute(request) {
        seenEnv = request.isolation.env;
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: "{}",
          usage: {
            wall_ms: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            cost_usd_est: 0,
          },
          stderrTail: "",
        } satisfies TransportOutcome;
      },
    };
    const harness = new StepExecutionHarness({
      transport,
      // Marks the harness as offline-test (skips the production allowlist
      // gate); the custom transport above means it is never invoked.
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: { HOME: "/Users/juanma", GIT_DIR: "/evil" },
    });
    // The harness hashes the system prompt before admitting the step, so it
    // must exist on disk even in this offline projection probe.
    const promptDir = await mkdtemp(path.join(tmpdir(), "pr-hero-env-probe-"));
    const systemPromptPath = path.join(promptDir, "system.md");
    await writeFile(systemPromptPath, "system prompt");
    await harness.run({
      name: "env-probe",
      systemPromptPath,
      prompt: "p",
      tools: [],
      model: "sonnet",
      cwd: "/tmp/ws",
      outPath: `/tmp/env-probe-${Date.now()}.json`,
      mcpConfigPath: "/tmp/mcp.json",
      timeoutMs: 1000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
    });
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.HOME).toBe("/Users/juanma");
    expect(seenEnv?.GIT_DIR).toBeUndefined();
  });
});
