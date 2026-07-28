// Slice-3 live micro-eval (plan §Evals): one REAL ClaudeCodeRunner.run() with
// a trivial StepSpec. Proves the actual spawn path, JSON envelope parsing and
// usage capture outside the fake — costs cents. Run: bun run scripts/live-micro-eval.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeRunner } from "../src/step-runner";

const dir = mkdtempSync(path.join(tmpdir(), "pr-hero-micro-eval-"));
const systemPromptPath = path.join(dir, "system.md");
writeFileSync(
  systemPromptPath,
  "When asked for output, reply with exactly this JSON object and nothing " +
    'else: {"findings":[]}',
);
const mcpConfigPath = path.join(dir, "mcp.json");
writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

const runner = new ClaudeCodeRunner();
const started = performance.now();
const result = await runner.run({
  name: "micro-eval",
  systemPromptPath,
  prompt: "Produce your output now.",
  tools: ["Read"],
  mcpConfigPath,
  model: "sonnet",
  cwd: dir,
  outPath: path.join(dir, "out.json"),
  timeoutMs: 5 * 60 * 1000,
  maxAttempts: 2,
  parse: (finalText) => {
    const parsed: unknown = JSON.parse(finalText.trim());
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { findings?: unknown }).findings)
    ) {
      throw new Error("not the mandated {findings:[]} shape");
    }
    return parsed;
  },
});

const wallMs = Math.round(performance.now() - started);
console.log(
  JSON.stringify(
    {
      status: result.status,
      attempts: result.attempts,
      output: result.output,
      usage: result.usage,
      wall_ms: wallMs,
      run_dir: dir,
    },
    null,
    2,
  ),
);
if (result.status !== "ok") process.exit(1);
