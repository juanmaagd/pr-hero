import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildStepArgv,
  ClaudeCodeRunner,
  classifyFailure,
  FORMAT_RETRY_REMINDER,
  isTransientSessionFailure,
  type RetryInfo,
  type StepSpec,
} from "../src/step-runner";

// ---------------------------------------------------------------------------
// FakeSpawn: scripted {stdout, stderr, exitCode} per call, records argv/cwd.
// A `hang: true` script entry produces a process whose streams and exit only
// settle when kill() fires — how the watchdog path gets exercised without a
// real 30-minute wait.
// ---------------------------------------------------------------------------

interface ScriptedCall {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
}

interface RecordedCall {
  argv: string[];
  cwd: string | undefined;
}

function makeFakeSpawn(script: ScriptedCall[]): {
  spawnFn: typeof Bun.spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const encoder = new TextEncoder();
  const spawnFn = ((argv: string[], opts?: { cwd?: string }) => {
    // Repeat the last scripted entry when exhausted, so a runner that makes
    // more calls than expected fails an assertion instead of crashing.
    const scripted = script[Math.min(calls.length, script.length - 1)] ?? {};
    calls.push({ argv, cwd: opts?.cwd });
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const held: ReadableStreamDefaultController<Uint8Array>[] = [];
    const stream = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (scripted.hang) {
            held.push(controller);
            return;
          }
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    const stdout = stream(scripted.stdout ?? "");
    const stderr = stream(scripted.stderr ?? "");
    if (!scripted.hang) resolveExit(scripted.exitCode ?? 0);
    return {
      stdout,
      stderr,
      exited,
      kill() {
        for (const controller of held) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        resolveExit(143);
      },
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

// `--output-format json` stdout envelope, as the claude CLI emits it.
function envelope(
  result: string,
  tokens: { input: number; output: number } = { input: 100, output: 20 },
  cost = 0.01,
): string {
  return JSON.stringify({
    result,
    usage: { input_tokens: tokens.input, output_tokens: tokens.output },
    total_cost_usd: cost,
  });
}

async function makeSpec(overrides: Partial<StepSpec> = {}): Promise<StepSpec> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-step-"));
  return {
    name: "hunter-reliability",
    systemPromptPath: "/runs/1/steps/hunter-reliability.system.md",
    prompt: "Review this diff.",
    tools: ["Read", "Grep", "Glob", "mcp__codegraph__codegraph_explore"],
    mcpConfigPath: "/runs/1/mcp.json",
    model: "claude-sonnet-4-5",
    cwd: "/worktrees/pr-1539",
    outPath: path.join(dir, "hunter-reliability.json"),
    timeoutMs: 5_000,
    maxAttempts: 2,
    parse: (finalText) => JSON.parse(finalText) as unknown,
    ...overrides,
  };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const GOOD_DRAFT = { findings: [] };

describe("buildStepArgv", () => {
  test("carries every isolation flag verbatim", async () => {
    const spec = await makeSpec();
    const argv = buildStepArgv(spec);
    expect(argv.slice(0, 3)).toEqual(["claude", "-p", spec.prompt]);
    expect(flagValue(argv, "--append-system-prompt-file")).toBe(
      spec.systemPromptPath,
    );
    expect(flagValue(argv, "--output-format")).toBe("json");
    expect(flagValue(argv, "--mcp-config")).toBe(spec.mcpConfigPath);
    expect(argv).toContain("--strict-mcp-config");
    expect(flagValue(argv, "--setting-sources")).toBe("");
    expect(flagValue(argv, "--tools")).toBe(
      "Read,Grep,Glob,mcp__codegraph__codegraph_explore",
    );
    expect(flagValue(argv, "--permission-mode")).toBe("bypassPermissions");
    expect(flagValue(argv, "--model")).toBe(spec.model);
  });

  test("drops v1's --agents and never grants Write/Task", async () => {
    const spec = await makeSpec();
    const argv = buildStepArgv(spec);
    expect(argv).not.toContain("--agents");
    const tools = flagValue(argv, "--tools") ?? "";
    expect(tools).not.toMatch(/\bWrite\b/);
    expect(tools).not.toMatch(/\bTask\b/);
  });
});

describe("ClaudeCodeRunner success path", () => {
  test("parses the FULL result while log tails stay sliced", async () => {
    // A >8192-char final message: the tail slices are for logs ONLY —
    // feeding a slice to parse() would misclassify a delivered draft.
    const big = { findings: [], pad: "x".repeat(9_000) };
    const result = JSON.stringify(big);
    expect(result.length).toBeGreaterThan(8_192);
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: envelope(result) }]);
    const spec = await makeSpec();
    let seen = "";
    spec.parse = (finalText) => {
      seen = finalText;
      return JSON.parse(finalText) as unknown;
    };
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(1);
    expect(seen).toBe(result);
    expect(stepResult.resultText.length).toBe(8_192);
    expect(calls[0]?.cwd).toBe(spec.cwd);
    expect(stepResult.output).toEqual(big);
  });

  test("writes the artifact atomically (no .tmp leftover)", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    await runner.run(spec);
    expect(await Bun.file(spec.outPath).json()).toEqual(GOOD_DRAFT);
    expect(await Bun.file(`${spec.outPath}.tmp`).exists()).toBe(false);
  });

  test("captures usage from the envelope", async () => {
    const { spawnFn } = makeFakeSpawn([
      {
        stdout: envelope(
          JSON.stringify(GOOD_DRAFT),
          { input: 300, output: 40 },
          0.05,
        ),
      },
    ]);
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(await makeSpec());
    expect(stepResult.usage.tokens_in).toBe(300);
    expect(stepResult.usage.tokens_out).toBe(40);
    expect(stepResult.usage.tokens_total).toBe(340);
    expect(stepResult.usage.cost_usd_est).toBe(0.05);
  });
});

describe("ClaudeCodeRunner transient retry", () => {
  // The v1 arm-B signature: exit ZERO with the API error in the result text.
  const transientEnvelope = envelope(
    "API Error: Connection closed mid-response",
    { input: 100, output: 20 },
    0.01,
  );

  test("retries once, deletes stale debris, sums usage", async () => {
    const { spawnFn, calls } = makeFakeSpawn([
      { stdout: transientEnvelope },
      {
        stdout: envelope(
          JSON.stringify(GOOD_DRAFT),
          { input: 50, output: 5 },
          0.02,
        ),
      },
    ]);
    const spec = await makeSpec();
    // Truncated attempt-1 debris: must be gone before attempt 2 runs.
    await Bun.write(spec.outPath, '{"findings": [');
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
    // Usage summed across BOTH attempts — the failed one still cost money.
    expect(stepResult.usage.tokens_in).toBe(150);
    expect(stepResult.usage.tokens_out).toBe(25);
    expect(stepResult.usage.cost_usd_est).toBeCloseTo(0.03);
    expect(await Bun.file(spec.outPath).json()).toEqual(GOOD_DRAFT);
  });

  test("exhausted transient attempts fail without a format-retry", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: transientEnvelope }]);
    const spec = await makeSpec();
    await Bun.write(spec.outPath, '{"findings": [');
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.attempts).toBe(2);
    // Transient means infrastructure — a REMINDER cannot fix a dead socket.
    expect(calls.length).toBe(2);
    // Debris deleted so nothing downstream trusts a truncated artifact.
    expect(await Bun.file(spec.outPath).exists()).toBe(false);
  });
});

// OBSERVATION ONLY: these assert what the callback SAYS and that it cannot
// change what the runner does — no test here may pin a new retry count, an
// ordering, or a watchdog number.
describe("ClaudeCodeRunner onRetry", () => {
  const transientEnvelope = envelope(
    "API Error: Connection closed mid-response",
  );

  test("announces the transient retry that is about to be spawned", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: transientEnvelope },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({ onRetry: (info) => seen.push(info) });
    await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(seen).toEqual([
      {
        step: "hunter-reliability",
        attempt: 2,
        maxAttempts: 2,
        reason: "transient",
      },
    ]);
  });

  test("stays silent when the budget is spent — no retry, nothing to watch", async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: transientEnvelope }]);
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({
      maxAttempts: 1,
      onRetry: (info) => seen.push(info),
    });
    const stepResult = await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(stepResult.status).toBe("failed");
    expect(seen).toEqual([]);
  });

  test("the format retry reports its own reason, never an N-of-M", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: envelope("Sure! Here is some prose instead of JSON.") },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const seen: RetryInfo[] = [];
    const spec = await makeSpec({ onRetry: (info) => seen.push(info) });
    await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(seen.map((i) => i.reason)).toEqual(["format"]);
    expect(seen[0]?.attempt).toBe(2);
  });

  test("a throwing observer cannot kill a paid step", async () => {
    const { spawnFn } = makeFakeSpawn([
      { stdout: transientEnvelope },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec({
      onRetry: () => {
        throw new Error("the panel exploded");
      },
    });
    const stepResult = await new ClaudeCodeRunner({ spawnFn }).run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
  });
});

describe("ClaudeCodeRunner format-retry", () => {
  const proseEnvelope = envelope(
    "Sure! Here are my findings described in friendly prose.",
  );

  test("re-prompts once with the REMINDER suffix, then succeeds", async () => {
    const { spawnFn, calls } = makeFakeSpawn([
      { stdout: proseEnvelope },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
    expect(calls[1]?.argv[2]).toBe(spec.prompt + FORMAT_RETRY_REMINDER);
  });

  test("is capped at one: a second parse failure fails the step", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: proseEnvelope }]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });
});

describe("ClaudeCodeRunner watchdog", () => {
  test("kills a hung attempt and recovers on the retry", async () => {
    const { spawnFn, calls } = makeFakeSpawn([
      { hang: true },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec({ timeoutMs: 50 });
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("ok");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  test("two hangs exhaust the transient budget and fail", async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ hang: true }]);
    const spec = await makeSpec({ timeoutMs: 50 });
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });
});

describe("ClaudeCodeRunner malformed stdout", () => {
  test("fails without throwing, with zero token usage", async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: "this is not json" }]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    const stepResult = await runner.run(spec);
    expect(stepResult.status).toBe("failed");
    expect(stepResult.usage.tokens_total).toBe(0);
    expect(stepResult.usage.cost_usd_est).toBe(0);
  });
});

describe("ClaudeCodeRunner attempt logs", () => {
  test("writes one numbered log per attempt with its classification", async () => {
    const { spawnFn } = makeFakeSpawn([
      {
        stdout: envelope("Sure! Here are my findings described in prose."),
      },
      { stdout: envelope(JSON.stringify(GOOD_DRAFT)) },
    ]);
    const spec = await makeSpec();
    const runner = new ClaudeCodeRunner({ spawnFn });
    await runner.run(spec);
    const logsDir = path.join(path.dirname(spec.outPath), "logs");
    const first = await Bun.file(
      path.join(logsDir, `${spec.name}.1.log`),
    ).text();
    const second = await Bun.file(
      path.join(logsDir, `${spec.name}.2.log`),
    ).text();
    expect(first).toContain("classification: format");
    expect(second).toContain("kind: format-retry");
    expect(second).toContain("classification: ok");
  });
});

describe("failure classification", () => {
  test("isTransientSessionFailure matches the v1 witness regexes", () => {
    const witnesses = [
      "API Error: Connection closed mid-response",
      "read ECONNRESET",
      "socket hang up",
      "request timed out",
      "upstream returned 529",
      "overloaded_error",
    ];
    for (const witness of witnesses) {
      expect(
        isTransientSessionFailure({ stderrTail: witness, resultText: "" }),
      ).toBe(true);
    }
    expect(
      isTransientSessionFailure({
        stderrTail: "",
        resultText: "clean prose with no infrastructure witness",
      }),
    ).toBe(false);
  });

  test("classifyFailure treats a watchdog kill as transient", () => {
    expect(
      classifyFailure({ stderrTail: "", resultText: "", timedOut: true }),
    ).toBe("transient");
    expect(
      classifyFailure({ stderrTail: "", resultText: "prose", timedOut: false }),
    ).toBe("format");
  });
});
