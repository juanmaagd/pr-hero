import { describe, expect, test } from "bun:test";
import type { TransportRequest } from "../../src/execution/contracts";
import { aliasModelFamily, aliasModelSnapshot } from "../../src/model-catalog";
import { ACTIVE_CHILD_PROCS } from "../../src/step-runner";
import type { ClaudeCodeCliTransportOptions } from "../../src/transports/claude-code-cli";
import { ClaudeCodeCliTransport } from "../../src/transports/claude-code-cli";

const PID = 424242;

// §6.3 pre-spawn verification stubs: an existing 0600 regular file whose
// hash matches makeRequest's systemPromptSha256.
const okPromptFns: Pick<
  ClaudeCodeCliTransportOptions,
  "promptLstatFn" | "promptHashFn"
> = {
  promptLstatFn: () => ({ mode: 0o100600, isSymbolicLink: false }),
  promptHashFn: () => "deadbeef",
};

interface RecordedSignal {
  pid: number;
  signal?: string | number;
  at: number;
}

function makeRequest(
  overrides: Partial<TransportRequest> = {},
): TransportRequest {
  return {
    sessionId: "sess-1",
    attempt: 1,
    route: {
      backend: "claude-code",
      provider: "anthropic",
      modelFamily: "claude",
      modelSnapshot: "claude-test-model",
    },
    executionModel: "claude-test-model",
    systemPromptPath: "/tmp/pr-hero-test/system.md",
    systemPromptSha256: "deadbeef",
    userPrompt: "review this",
    cwd: "/tmp/pr-hero-test",
    tools: ["Read"],
    isolation: {
      credentialProjectionId: "proj-1",
      env: {},
      syntheticHome: "/tmp/pr-hero-test/home",
      syntheticConfigHome: "/tmp/pr-hero-test/config",
      syntheticTmp: "/tmp/pr-hero-test/tmp",
      verifiedBinaryPath: "/usr/bin/true",
    },
    ...overrides,
  };
}

interface FakeHandle {
  proc: Record<string, unknown> & {
    pid: number;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): void;
  };
  finish: (exitCode: number) => void;
  procKillCount: () => number;
}

function makeFakeProc(options: {
  pid?: number;
  stdoutBody?: string;
  exitCode?: number;
}): FakeHandle {
  const pid = options.pid ?? PID;
  let releaseExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    releaseExit = resolve;
    if (options.exitCode !== undefined) resolve(options.exitCode);
  });
  let killCount = 0;
  const encoder = new TextEncoder();
  const body = options.stdoutBody ?? "";
  const streamFor = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await exited;
        if (body.length > 0) controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });

  return {
    proc: {
      pid,
      stdout: streamFor(),
      stderr: streamFor(),
      exited,
      kill() {
        killCount += 1;
      },
    },
    finish: releaseExit,
    procKillCount: () => killCount,
  };
}

describe("ClaudeCodeCliTransport §5.2 cancellation and terminal proof", () => {
  test("PGID proof failure fails execution before launch with no signal sent", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      // pgid differs from pid: the child is NOT a group leader
      getPgid: (pid) => pid - 1,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
      },
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("PGID proof failed");
    expect(signals).toHaveLength(0);
    expect(fake.procKillCount()).toBe(0);
    expect(ACTIVE_CHILD_PROCS.has(fake.proc as never)).toBe(false);

    expect(outcome.terminalProof).toBeUndefined();
  });

  test("spawn requests a detached child (own process group)", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "ok" }),
      exitCode: 0,
    });
    let spawnOptions: Record<string, unknown> | undefined;
    const spawnFn = ((_args: string[], opts: Record<string, unknown>) => {
      spawnOptions = opts;
      return fake.proc;
    }) as unknown as typeof Bun.spawn;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn,
      getPgid: (pid) => pid,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
      },
    });

    await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(spawnOptions?.detached).toBe(true);
    expect(signals).toHaveLength(0);
  });

  test("direct routes pass executionModel (alias) to --model, not route snapshot", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "ok" }),
      exitCode: 0,
    });
    let spawnArgs: string[] | undefined;
    const spawnFn = ((args: string[]) => {
      spawnArgs = args;
      return fake.proc;
    }) as unknown as typeof Bun.spawn;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn,
      getPgid: (pid) => pid,
    });

    await transport.execute(
      makeRequest({
        executionModel: "sonnet",
        route: {
          backend: "claude-code",
          provider: "anthropic",
          gateway: "direct",
          modelFamily: aliasModelFamily("sonnet"),
          modelSnapshot: aliasModelSnapshot("sonnet"),
        },
      }),
      { signal: new AbortController().signal },
    );

    const modelIndex = spawnArgs?.indexOf("--model");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(spawnArgs?.[modelIndex! + 1]).toBe("sonnet");
  });

  test("abort sends SIGTERM to negative pgid first; group exiting during grace receives no SIGKILL", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      termGraceMs: 50,
      killReapMs: 500,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
        if (signal === "SIGTERM") {
          exitTimer = setTimeout(() => fake.finish(143), 5);
        }
      },
    });

    const controller = new AbortController();
    const pending = transport.execute(makeRequest(), {
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    if (exitTimer) clearTimeout(exitTimer);

    expect(outcome.completion).toBe("cancelled");
    expect(signals.map((s) => [s.pid, s.signal])).toEqual([[-PID, "SIGTERM"]]);
    expect(fake.procKillCount()).toBe(1);
    expect(outcome.terminalProof).toBeDefined();
    expect(outcome.exitCode).toBe(143);
  });

  test("group ignoring SIGTERM is escalated to SIGKILL after the injected grace", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      termGraceMs: 60,
      killReapMs: 500,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
        if (signal === "SIGKILL") fake.finish(137);
      },
    });

    const startedAt = Date.now();
    const outcome = await transport.execute(makeRequest({ timeoutMs: 10 }), {
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - startedAt;

    expect(outcome.timedOut).toBe(true);
    expect(outcome.completion).toBe("failed");
    expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals.every((s) => s.pid === -PID)).toBe(true);
    const graceObserved = signals[1].at - signals[0].at;
    expect(graceObserved).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2000);
    expect(outcome.terminalProof?.signal).toBe("SIGKILL");
    expect(outcome.terminalProof?.providerStatus).toBe("failed");
    expect(outcome.exitCode).toBe(137);
  });

  test("group surviving SIGKILL yields a bounded reap wait with a recorded warning", async () => {
    const signals: RecordedSignal[] = [];
    const fake = makeFakeProc({});
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      termGraceMs: 20,
      killReapMs: 40,
      killFn: (pid, signal) => {
        signals.push({ pid, signal, at: Date.now() });
      },
    });

    const startedAt = Date.now();
    const outcome = await transport.execute(makeRequest({ timeoutMs: 5 }), {
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000);
    expect(signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals.every((s) => s.pid === -PID)).toBe(true);
    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.stderrTail).toContain("not reaped");
    expect(outcome.terminalProof).toBeUndefined();
    expect(ACTIVE_CHILD_PROCS.has(fake.proc as never)).toBe(false);
  });

  test("success carries terminal proof; failure exit maps to failed provider status", async () => {
    const successFake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "all good" }),
      exitCode: 0,
    });
    const successSignals: RecordedSignal[] = [];
    const successTransport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => successFake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: (pid, signal) => {
        successSignals.push({ pid, signal, at: Date.now() });
      },
    });

    const success = await successTransport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(success.completion).toBe("success");
    expect(success.protocolIntegrity).toBe("verified");
    const proof = success.terminalProof;
    if (!proof) throw new Error("success without terminal proof");
    expect(proof.eventId).toBe("sess-1-1-terminal");
    expect(proof.providerStatus).toBe("completed");
    expect(proof.exitCode).toBe(0);
    expect(proof.providerObservedAt).toEqual(
      new Date(proof.providerObservedAt).toISOString(),
    );

    const failureFake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "" }),
      exitCode: 1,
    });
    const failureTransport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => failureFake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const failure = await failureTransport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(failure.completion).toBe("failed");
    expect(failure.terminalProof?.providerStatus).toBe("failed");
    expect(failure.terminalProof?.exitCode).toBe(1);
    expect(successSignals).toHaveLength(0);
  });
});

// D1-08 PR2 (§8): TransportOutcome.usage is NormalizedUsage now. Corrupted
// stdout must never fabricate a zero-cost leaf — the exact "$0 on parse
// failure" collapse this slice exists to kill, just moved one layer down.
// Cache-read and cache-write are Anthropic's own disjoint additive fields
// (input_tokens/cache_read_input_tokens/cache_creation_input_tokens sum to
// total input; they are not a total-minus-subset split), so the transport
// must carry them straight into their own NormalizedTokens leaves.
describe("ClaudeCodeCliTransport usage normalization (D1-08 PR2)", () => {
  test('corrupted stdout yields completeness "unavailable", never a zero-cost leaf', async () => {
    const fake = makeFakeProc({
      stdoutBody: "this is not json at all {{{",
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("unavailable");
    expect(outcome.usage.tokens).toEqual({});
    expect(outcome.usage.cashCostUsd).toBeUndefined();
  });

  test("valid JSON with no usage block at all is also unavailable, not a fabricated zero", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({ result: "reviewed" }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("unavailable");
    expect(outcome.usage.tokens.inputUncached).toBeUndefined();
  });

  test("cache-read and cache-write land in distinct disjoint leaves, apart from uncached input", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({
        result: "reviewed",
        total_cost_usd: 0.042,
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 300,
          output_tokens: 45,
        },
      }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("complete");
    expect(outcome.usage.tokens.inputUncached).toBe(120);
    expect(outcome.usage.tokens.inputCacheRead).toBe(900);
    expect(outcome.usage.tokens.inputCacheWrite).toBe(300);
    expect(outcome.usage.tokens.inputCacheRead).not.toBe(
      outcome.usage.tokens.inputUncached,
    );
    expect(outcome.usage.tokens.outputVisible).toBe(45);
    expect(outcome.usage.cashCostUsd).toBe(0.042);
  });

  test("a usage block missing any token leaf is partial, never complete with fabricated zeros", async () => {
    const fake = makeFakeProc({
      stdoutBody: JSON.stringify({
        result: "reviewed",
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 900,
          output_tokens: 45,
        },
      }),
      exitCode: 0,
    });
    const transport = new ClaudeCodeCliTransport({
      ...okPromptFns,
      spawnFn: (() => fake.proc) as unknown as typeof Bun.spawn,
      getPgid: (pid) => pid,
      killFn: () => {},
    });

    const outcome = await transport.execute(makeRequest(), {
      signal: new AbortController().signal,
    });

    expect(outcome.usage.completeness).toBe("partial");
    expect(outcome.usage.tokens.providerReportedTotal).toBe(1065);
    expect(outcome.usage.tokens.inputUncached).toBeUndefined();
    expect(outcome.usage.tokens.inputKnown).toBeUndefined();
  });
});

// D1-08 PR3 task 3.11 (§9.2): capabilities() gains an OPTIONAL bucket-scope
// input so a caller that HAS resolved a credential's scope (PR5a's harness
// wiring, not yet built) can ask the transport to report the resulting
// rateLimitBucketId on ProviderCapabilityReport. Calling with no argument —
// every existing call site — must keep reporting rateLimitBucketId as
// undefined, byte-identical to pre-PR3 behavior.
describe("ClaudeCodeCliTransport.capabilities bucket identity (D1-08 PR3)", () => {
  test("no bucket-scope argument leaves rateLimitBucketId undefined (regression pin)", async () => {
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    const report = await transport.capabilities();
    expect(report.rateLimitBucketId).toBeUndefined();
  });

  test("a supplied bucket-scope input yields the same bucketId deriveBucketId would compute", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    const localKey = Buffer.from("e".repeat(64), "hex");
    const report = await transport.capabilities({
      credentialFingerprint: "fp-claude-1",
      bucketScope: { account: "acct-1" },
      localKey,
    });
    const expected = deriveBucketId(
      {
        provider: "anthropic",
        credentialFingerprint: "fp-claude-1",
        scope: { account: "acct-1" },
      },
      localKey,
    );
    expect(report.rateLimitBucketId).toBe(expected);
  });

  test("an unknown (empty) bucket-scope still yields a deterministic bucketId, not undefined", async () => {
    const transport = new ClaudeCodeCliTransport(okPromptFns);
    const localKey = Buffer.from("f".repeat(64), "hex");
    const report = await transport.capabilities({
      credentialFingerprint: "fp-claude-2",
      localKey,
    });
    expect(report.rateLimitBucketId).toBeDefined();
    expect(typeof report.rateLimitBucketId).toBe("string");
  });
});

describe("ClaudeCodeCliTransport.classifyFailure", () => {
  const transport = new ClaudeCodeCliTransport(okPromptFns);

  function classify(witness: string, where: "stderr" | "final" = "stderr") {
    return transport.classifyFailure({
      completion: "failed",
      protocolIntegrity: "verified",
      finalText: where === "final" ? witness : "",
      usage: {
        wallMs: 1,
        tokens: { inputUncached: 1 },
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "provider" as const,
        cashCostUsd: 0,
      },
      stderrTail: where === "stderr" ? witness : "",
    });
  }

  // §7 gives rate_limit its own disposition — bounded retry with backoff —
  // precisely because retrying INSTANTLY against a server that just said it
  // is saturated makes the saturation worse and burns the whole transient
  // budget in milliseconds. That separation only exists if something actually
  // classifies backpressure as backpressure.
  test("server backpressure is rate_limit, not a network blip", () => {
    for (const witness of [
      "upstream returned 529",
      "overloaded_error",
      "API Error: 529 overloaded_error",
      "HTTP 429 Too Many Requests",
      "rate limit exceeded",
      "rate_limit_error",
      "503 Service Unavailable",
    ]) {
      expect(classify(witness)).toBe("rate_limit");
    }
  });

  // The connection-level witnesses stay immediate: nothing upstream asked us
  // to slow down, and waiting out a reset socket buys nothing.
  test("connection-level failures stay network_transient", () => {
    for (const witness of [
      "API Error: Connection closed mid-response",
      "read ECONNRESET",
      "socket hang up",
      "request timed out",
      "502 Bad Gateway",
    ]) {
      expect(classify(witness)).toBe("network_transient");
    }
  });

  // Ordering trap: the real CLI witness for an overload is "API Error: 529
  // overloaded_error", which matches the network regex too. Whichever test
  // runs first wins, so backpressure has to be decided BEFORE the generic
  // network match or the fix silently does nothing for the exact string it
  // exists to catch.
  test("a witness carrying BOTH signals is treated as backpressure", () => {
    expect(classify("API Error: Connection closed · 529 overloaded")).toBe(
      "rate_limit",
    );
  });

  test("a status code embedded in a larger number is not a status code", () => {
    expect(classify("processed 15291 tokens, then finished")).toBeUndefined();
    expect(classify("job 1429 completed")).toBeUndefined();
  });

  test("the login witness still outranks everything else", () => {
    expect(classify("Not logged in · Please run /login")).toBe("auth_invalid");
    // Auth is terminal; a 529 in the same witness must not downgrade it into
    // a retryable cause.
    expect(classify("529 overloaded\nNot logged in · Please run /login")).toBe(
      "auth_invalid",
    );
  });

  // The witness includes finalText, which is `JSON.parse(stdout).result` — a
  // MIXED channel carrying both the CLI's own error text and the model's
  // final message. pr-hero's model output is code-review prose about exactly
  // these failure modes, so English phrases like "rate limit" match the tool's
  // own subject-matter vocabulary. Reported as F003 on PR #74 against the
  // sibling SDK transport; the same defect reached this file through #78.
  test("review prose about rate limiting is not a rate limit", () => {
    for (const prose of [
      "The endpoint has no rate limit, so a burst of requests goes straight through.",
      "Consider returning 429 Too Many Requests once the quota is spent.",
      "This path renders Service Unavailable instead of retrying.",
      "The worker pool is overloaded under this traffic shape.",
    ]) {
      expect(classify(prose, "final")).toBeUndefined();
    }
  });

  // Narrowing prose must not cost a single audited witness. These are the v1
  // observed strings (test/step-runner.test.ts:465-474) — machine tokens and
  // status codes the provider actually emits, not sentences about them.
  test("the audited provider witnesses still classify from stderr", () => {
    expect(classify("upstream returned 529")).toBe("rate_limit");
    expect(classify("overloaded_error")).toBe("rate_limit");
    expect(classify("API Error: 529 overloaded_error")).toBe("rate_limit");
    expect(classify("rate_limit_error")).toBe("rate_limit");
    expect(classify("HTTP 429")).toBe("rate_limit");
  });

  test("clean prose is not a transport failure at all", () => {
    expect(classify("here are my findings", "final")).toBeUndefined();
  });

  test("the witness spans stderr AND the final message", () => {
    expect(classify("overloaded_error", "final")).toBe("rate_limit");
  });
});
