import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  ProviderTerminalProof,
  TransportRequest,
} from "../../src/execution/contracts";
import type {
  OpenCodeClientEvent,
  OpenCodeClientLike,
  OpenCodePollResult,
  OpenCodeTransportClock,
} from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";

// §13 line 740: SDK conformance must distinguish a confirmed abort from
// unknown_may_continue without claiming remote cost ended, and §13 line 746
// requires backpressure, snapshot/delta usage, stream/poll races and content
// bounds to be tested. Every deadline below is fired by hand through
// ManualClock — no test sleeps a real deadline.

class ManualClock implements OpenCodeTransportClock {
  private pending: Array<{ fn: () => void }> = [];

  schedule(_ms: number, fn: () => void): () => void {
    const entry = { fn };
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== entry);
    };
  }

  get size(): number {
    return this.pending.length;
  }

  fireNext(): void {
    const entry = this.pending.shift();
    entry?.fn();
  }

  fireAll(): void {
    const fns = this.pending.splice(0).map((entry) => entry.fn);
    for (const fn of fns) fn();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function advance(clock: ManualClock, passes: number): Promise<void> {
  for (let i = 0; i < passes; i += 1) {
    clock.fireAll();
    await flush();
  }
}

function makeRequest(
  overrides: Partial<TransportRequest> = {},
): TransportRequest {
  return {
    sessionId: "oc-sess-1",
    attempt: 1,
    route: {
      backend: "opencode",
      provider: "openai",
      modelFamily: "gpt",
      modelSnapshot: "gpt-test-snapshot",
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

class RecordingSink implements AsyncEventSink {
  readonly events: ProviderEvent[] = [];
  blockDeltas = false;
  closed = false;

  async push(event: ProviderEvent): Promise<"accepted" | "closed"> {
    this.events.push(event);
    if (this.blockDeltas && event.type === "delta") {
      // Never settles — the shape of a sink whose consumer stopped draining.
      return new Promise<"accepted" | "closed">(() => {});
    }
    return this.closed ? "closed" : "accepted";
  }

  close(): void {
    this.closed = true;
  }

  terminals(): ProviderEvent[] {
    return this.events.filter((event) => event.type === "terminal");
  }
}

interface ClientHandle {
  client: OpenCodeClientLike;
  abortCount: () => number;
}

function makeClient(options: {
  stream?: AsyncIterable<OpenCodeClientEvent> | Error;
  polls?: Array<OpenCodePollResult>;
  hangRounds?: number[];
  createError?: Error;
}): ClientHandle {
  let aborts = 0;
  let round = 0;
  const client: OpenCodeClientLike = {
    createSession: async () => {
      if (options.createError) throw options.createError;
      return { id: "oc-sess-1" };
    },
    async *streamEvents() {
      if (options.stream instanceof Error) throw options.stream;
      if (options.stream !== undefined) {
        yield* options.stream;
        return;
      }
      // No scripted stream: stay open forever, like a session mid-generation.
      await new Promise<never>(() => {});
    },
    pollStatus: async () => {
      const index = round;
      round += 1;
      if (options.hangRounds?.includes(index)) {
        return new Promise<OpenCodePollResult>(() => {});
      }
      return options.polls?.[index] ?? ({ kind: "pending" } as const);
    },
    abort: async () => {
      aborts += 1;
    },
  };
  return { client, abortCount: () => aborts };
}

function streamOf(
  events: OpenCodeClientEvent[],
): AsyncIterable<OpenCodeClientEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

const completedProof = (
  eventId: string,
  status = "completed",
): ProviderTerminalProof => ({
  eventId,
  providerStatus: status,
  providerObservedAt: "2026-08-26T00:00:00.000Z",
});

interface RigOptions {
  transport?: Partial<ConstructorParameters<typeof OpenCodeSdkTransport>[0]>;
  client: ReturnType<typeof makeClient>["client"];
}

function makeRig(options: RigOptions) {
  const clock = new ManualClock();
  const sink = new RecordingSink();
  const controller = new AbortController();
  const transport = new OpenCodeSdkTransport({
    client: options.client,
    clock,
    stallDeadlineMs: 50,
    abortConfirmMs: 500,
    cleanupMs: 100,
    maxDeltaBytes: 64 * 1024,
    maxFinalTextBytes: 1024 * 1024,
    pollIntervalMs: 10,
    pollRoundMs: 20,
    ...(options.transport ?? {}),
  });
  return { clock, sink, controller, transport };
}

describe("OpenCodeSdkTransport §197 terminal arbitration", () => {
  test("stream terminal wins the slot; matching poll confirms without a second terminal", async () => {
    const proof = completedProof("evt-stream-1");
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: "hello " },
        { kind: "terminal", proof },
      ]),
      polls: [{ kind: "terminal", proof }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.clock.fireNext();
    await flush();
    rig.clock.fireAll();
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-stream-1");
    expect(outcome.finalText).toBe("hello ");
    expect(rig.sink.terminals()).toHaveLength(1);
    const terminal = rig.sink.terminals()[0];
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.origin).toBe("provider");
    expect(terminal.integrity).toBe("verified");
    expect(outcome.stderrTail).toContain("confirmed the winning terminal");
    expect(outcome.stderrTail).not.toContain("conflicting");
  });

  test("a late conflicting poll terminal flips the outcome malformed", async () => {
    const winner = completedProof("evt-a", "completed");
    const conflict = completedProof("evt-b", "failed");
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: "hi" },
        { kind: "terminal", proof: winner },
      ]),
      polls: [{ kind: "terminal", proof: conflict }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    // The first queued timer is the poll tick — it lands BEFORE the drain
    // window expires, so the conflict is observed pre-settlement.
    rig.clock.fireNext();
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("malformed");
    // The FIRST valid proof stays attached as evidence; arrival order never
    // replaces it.
    expect(outcome.terminalProof?.eventId).toBe("evt-a");
    expect(outcome.stderrTail).toContain("conflicting provider terminal");
    expect(rig.transport.classifyFailure(outcome)).toBe("protocol_mismatch");
    expect(rig.sink.terminals()).toHaveLength(1);
    const terminal = rig.sink.terminals()[0];
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.integrity).toBe("malformed");
  });

  test("EOF alone cannot win the slot; a later valid poll terminal does", async () => {
    const proof = completedProof("evt-poll-late");
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: "abc" }]),
      polls: [
        { kind: "pending" },
        { kind: "pending" },
        { kind: "terminal", proof },
      ],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-poll-late");
    expect(outcome.stderrTail).toContain(
      "EOF is not a terminal proof and cannot win the slot",
    );
    expect(rig.sink.terminals()).toHaveLength(1);
  });

  test("a timed-out poll round cannot win the slot and is only counted", async () => {
    const proof = completedProof("evt-after-timeout");
    // Round 0 hangs past pollRoundMs; the terminal arrives on round 1. The
    // hung round still consumed its script slot, hence the placeholder.
    const handle = makeClient({
      polls: [{ kind: "pending" }, { kind: "terminal", proof }],
      hangRounds: [0],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.terminalProof?.eventId).toBe("evt-after-timeout");
    expect(outcome.stderrTail).toContain("poll round(s) timed out");
  });

  test("an invalid terminal proof cannot win the slot; a valid one can", async () => {
    const invalid: ProviderTerminalProof = {
      eventId: "",
      providerStatus: "completed",
      providerObservedAt: "2026-08-26T00:00:00.000Z",
    };
    const proof = completedProof("evt-valid");
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: "x" },
        { kind: "terminal", proof: invalid },
      ]),
      polls: [{ kind: "terminal", proof }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.terminalProof?.eventId).toBe("evt-valid");
    expect(outcome.stderrTail).toContain("invalid terminal proof");
  });
});

describe("OpenCodeSdkTransport §5.2 line 272 / §5.3 line 290 abort semantics", () => {
  test("confirmed abort carries the provider proof and never claims unknown_may_continue", async () => {
    const proof = completedProof("evt-cancelled", "cancelled");
    const handle = makeClient({
      polls: [{ kind: "terminal", proof }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.controller.abort();
    // Stepwise: fire only the pending poll tick so the provider terminal
    // lands INSIDE the confirmation window, ahead of the confirm deadline.
    rig.clock.fireNext();
    await flush();
    const outcome = await pending;

    expect(handle.abortCount()).toBe(1);
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("verified");
    expect(outcome.terminalProof?.eventId).toBe("evt-cancelled");
    expect(outcome.stderrTail).toContain("confirmed the abort");
    expect(outcome.stderrTail).not.toContain("unknown_may_continue");
    expect(rig.transport.classifyFailure(outcome)).toBeUndefined();
  });

  test("unconfirmed abort yields unverified integrity, no proof, remote_abort_unconfirmed", async () => {
    const handle = makeClient({});
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    rig.controller.abort();
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(handle.abortCount()).toBe(1);
    expect(outcome.completion).toBe("cancelled");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect("terminalProof" in outcome).toBe(false);
    expect(outcome.stderrTail).toContain("unknown_may_continue");
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "remote_abort_unconfirmed",
    );
    // Exactly one transport-origin terminal, with no proof attached.
    expect(rig.sink.terminals()).toHaveLength(1);
    const terminal = rig.sink.terminals()[0];
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.origin).toBe("transport");
    expect(terminal.proof).toBeUndefined();
    expect(terminal.status).toBe("cancelled");
    expect(terminal.integrity).toBe("unverified");
  });
});

describe("OpenCodeSdkTransport §4.2 line 195 usage aggregation mode", () => {
  test("first usage event fixes snapshot mode and later snapshots replace", async () => {
    const handle = makeClient({
      stream: streamOf([
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.1,
        },
        {
          kind: "usage",
          mode: "snapshot",
          inputTokens: 20,
          outputTokens: 8,
          costUsd: 0.2,
        },
        { kind: "delta", text: "text" },
        { kind: "terminal", proof: completedProof("evt-usage-snap") },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    // Stepwise advancement drives the whole lifecycle: poll ticks while the
    // slot is open, then the post-win drain window.
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.completion).toBe("success");
    expect(outcome.usage.tokens_in).toBe(20);
    expect(outcome.usage.tokens_out).toBe(8);
    expect(outcome.usage.tokens_total).toBe(28);
    expect(outcome.usage.cost_usd_est).toBeCloseTo(0.2);
    const usageEvents = rig.sink.events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(2);
  });

  test("delta mode accumulates disjoint increments", async () => {
    const handle = makeClient({
      stream: streamOf([
        { kind: "usage", mode: "delta", inputTokens: 10, outputTokens: 2 },
        { kind: "usage", mode: "delta", inputTokens: 15, outputTokens: 3 },
        { kind: "delta", text: "t" },
        { kind: "terminal", proof: completedProof("evt-usage-delta") },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(outcome.usage.tokens_in).toBe(25);
    expect(outcome.usage.tokens_out).toBe(5);
    expect(outcome.usage.tokens_total).toBe(30);
  });

  test("a snapshot→delta flip after the mode was fixed makes the outcome malformed", async () => {
    const handle = makeClient({
      stream: streamOf([
        { kind: "usage", mode: "snapshot", inputTokens: 5, outputTokens: 1 },
        { kind: "usage", mode: "delta", inputTokens: 1 },
      ]),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("malformed");
    expect(outcome.stderrTail).toContain("aggregation mode changed");
    expect(rig.transport.classifyFailure(outcome)).toBe("protocol_mismatch");
    expect(handle.abortCount()).toBe(1);
  });
});

describe("OpenCodeSdkTransport §4.2 line 191 hard content bounds", () => {
  test("an oversized delta terminates the attempt and is dropped whole", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: "x".repeat(17) }]),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { maxDeltaBytes: 16 },
    });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("overflow");
    // The offending delta never entered finalText — nothing truncated was
    // parsed or delivered.
    expect(outcome.finalText).toBe("");
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "output_limit_exceeded",
    );
    expect(handle.abortCount()).toBe(1);
    // The oversized delta was never pushed into the sink either.
    expect(rig.sink.events.filter((e) => e.type === "delta")).toHaveLength(0);
  });

  test("breaching the aggregate bound keeps the complete accepted prefix", async () => {
    const first = "aaaa";
    const second = "b".repeat(30);
    const handle = makeClient({
      stream: streamOf([
        { kind: "delta", text: first },
        { kind: "delta", text: second },
      ]),
    });
    const rig = makeRig({
      client: handle.client,
      transport: { maxFinalTextBytes: 32 },
    });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("overflow");
    expect(outcome.finalText).toBe(first);
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "output_limit_exceeded",
    );
    const deltas = rig.sink.events.filter((e) => e.type === "delta");
    expect(deltas).toHaveLength(1);
  });
});

describe("OpenCodeSdkTransport §4.2 lines 188-189 backpressure", () => {
  test("a push stalled past the declared deadline aborts as protocol_overflow", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "delta", text: "slow" }]),
    });
    const rig = makeRig({ client: handle.client });
    rig.sink.blockDeltas = true;
    // The push never settles, so only the injected stall deadline can end the
    // attempt — fire it by hand.
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await flush();
    await advance(rig.clock, 3);
    const outcome = await pending;

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("overflow");
    expect(outcome.stderrTail).toContain(
      "stalled past the declared stall deadline",
    );
    expect(rig.transport.classifyFailure(outcome)).toBe("protocol_overflow");
    // The producer awaited the stuck push instead of firing-and-forgetting:
    // exactly one delta ever reached the sink.
    expect(rig.sink.events.filter((e) => e.type === "delta")).toHaveLength(1);
    expect(handle.abortCount()).toBe(1);
  });
});

describe("OpenCodeSdkTransport capabilities honesty (§11/D1-09)", () => {
  test("degraded report claims only what this slice implements", async () => {
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    const report = await transport.capabilities();

    expect(report.backend).toBe("opencode");
    expect(report.status).toBe("degraded");
    expect(report.auth.kind).toBe("opencode_chatgpt_oauth");
    expect(report.auth.projectionReady).toBe(false);
    expect(report.isolation.syntheticHome).toBe(false);
    expect(report.isolation.workspaceReadBroker).toBe(false);
    expect(report.protocol.terminalProof).toBe(true);
    expect(report.protocol.boundedEvents).toBe(true);
    expect(report.protocol.usageMode).toBe("none");
    expect(report.cancellation.deadlineMs).toBe(6500);
    expect(report.cancellation.conformance).toBe("passed");
    expect(report.billing.mode).toBe("subscription");
    expect(report.billing.pricingReady).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
    for (const issue of report.issues) expect(issue.blocking).toBe(false);
    expect(report.issues.some((issue) => issue.code.includes("d1_11"))).toBe(
      true,
    );
  });
});

describe("OpenCodeSdkTransport failure surface", () => {
  test("session creation failure is failed/unverified and classifies auth text", async () => {
    const handle = makeClient({
      createError: new Error("OpenCode unauthorized: ChatGPT login required"),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(rig.transport.classifyFailure(outcome)).toBe("auth_invalid");
  });

  test("stream errors terminate unverified and classify transient network text", async () => {
    const handle = makeClient({
      stream: new Error("fetch failed: ECONNRESET"),
    });
    const rig = makeRig({ client: handle.client });
    const outcome = await rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });

    expect(outcome.completion).toBe("failed");
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(rig.transport.classifyFailure(outcome)).toBe("network_transient");
  });

  test("classifyFailure returns undefined for an unmapped witness", () => {
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: {
          wall_ms: 0,
          tokens_in: 0,
          tokens_out: 0,
          tokens_total: 0,
          cost_usd_est: 0,
        },
        stderrTail: "something entirely opaque happened",
      }),
    ).toBeUndefined();
  });
});
