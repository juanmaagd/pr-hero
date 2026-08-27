import { describe, expect, test } from "bun:test";
import type { TransportRequest } from "../../src/execution/contracts";
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

describe("ClaudeCodeCliTransport.classifyFailure", () => {
  const transport = new ClaudeCodeCliTransport(okPromptFns);

  function classify(witness: string, where: "stderr" | "final" = "stderr") {
    return transport.classifyFailure({
      completion: "failed",
      protocolIntegrity: "verified",
      finalText: where === "final" ? witness : "",
      usage: {
        wall_ms: 1,
        tokens_in: 1,
        tokens_out: 0,
        tokens_total: 1,
        cost_usd_est: 0,
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

  test("clean prose is not a transport failure at all", () => {
    expect(classify("here are my findings", "final")).toBeUndefined();
  });

  test("the witness spans stderr AND the final message", () => {
    expect(classify("overloaded_error", "final")).toBe("rate_limit");
  });
});
