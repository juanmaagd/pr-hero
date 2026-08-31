import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  ProviderTerminalProof,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  decideRetryDisposition,
  legacyClassificationFromCause,
  resolveFailureCause,
} from "../../src/execution/failure-policy";
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
    executionModel: "gpt-test-snapshot",
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
  toolMap?: Readonly<Record<string, boolean>>;
}): ClientHandle {
  let aborts = 0;
  let round = 0;
  const client: OpenCodeClientLike = {
    createSession: async () => {
      if (options.createError) throw options.createError;
      return {
        id: "oc-sess-1",
        ...(options.toolMap !== undefined ? { toolMap: options.toolMap } : {}),
      };
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
    // #126: the confirmation TALLY is ours, so it rides diagnosticsTail; the
    // absence of a conflict marker is a witness fact and stays here.
    expect(outcome.diagnosticsTail).toContain("confirmed the winning terminal");
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
      // Round 0 is taken immediately, before the first interval elapses, so
      // the LATE conflict this test is named for is round 1. Scripting the
      // conflict at round 0 would make it the winner and test the mirror case.
      polls: [{ kind: "pending" }, { kind: "terminal", proof: conflict }],
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
    // #126: the tally lives on the diagnostics channel, never on the
    // classification witness — its own prose ("timed out") and its count both
    // match classifier patterns. Pinned in full by
    // test/conformance/opencode-diagnostic-witness.test.ts.
    expect(outcome.diagnosticsTail).toContain("poll round(s) timed out");
    expect(outcome.stderrTail).not.toContain("poll round(s) timed out");
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
    // #126: both the per-occurrence note and the tally are our own words
    // about our own observation, so they ride diagnosticsTail.
    expect(outcome.diagnosticsTail).toContain("invalid terminal proof");
    expect(outcome.stderrTail).not.toContain("invalid terminal proof");
  });
});

describe("OpenCodeSdkTransport §5.2 line 272 / §5.3 line 290 abort semantics", () => {
  test("confirmed abort carries the provider proof and never claims unknown_may_continue", async () => {
    const proof = completedProof("evt-cancelled", "cancelled");
    const handle = makeClient({
      // Round 0 is taken immediately, before the abort is even requested; the
      // terminal has to arrive AFTER it for this to be a confirmed abort
      // rather than a turn that simply finished first.
      polls: [{ kind: "pending" }, { kind: "terminal", proof }],
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
    expect(outcome.usage.tokens.inputUncached).toBe(20);
    expect(outcome.usage.tokens.outputVisible).toBe(8);
    expect(outcome.usage.tokens.totalKnown).toBe(28);
    expect(outcome.usage.cashCostUsd).toBeCloseTo(0.2);
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

    expect(outcome.usage.tokens.inputUncached).toBe(25);
    expect(outcome.usage.tokens.outputVisible).toBe(5);
    expect(outcome.usage.tokens.totalKnown).toBe(30);
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
    expect(report.auth.projectionReady).toBe(true);
    expect(report.auth.probe).toBe("passed");
    expect(report.isolation.syntheticHome).toBe(true);
    expect(report.isolation.workspaceReadBroker).toBe(true);
    expect(report.protocol.terminalProof).toBe(true);
    expect(report.protocol.boundedEvents).toBe(true);
    expect(report.protocol.usageMode).toBe("none");
    expect(report.cancellation.deadlineMs).toBe(6500);
    expect(report.cancellation.conformance).toBe("passed");
    expect(report.billing.mode).toBe("subscription");
    expect(report.billing.pricingReady).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
    for (const issue of report.issues) expect(issue.blocking).toBe(false);
    expect(
      report.issues.some(
        (issue) => issue.code === "codegraph_policy_unenforced",
      ),
    ).toBe(true);
  });
});

// D1-08 PR3 task 3.11 (§9.2): same optional bucket-scope input as the Claude
// CLI transport — omitted by every existing call site, so behavior stays
// byte-identical until PR5a's harness wiring supplies real credential scope.
describe("OpenCodeSdkTransport.capabilities bucket identity (D1-08 PR3)", () => {
  test("no bucket-scope argument leaves rateLimitBucketId undefined (regression pin)", async () => {
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    const report = await transport.capabilities();
    expect(report.rateLimitBucketId).toBeUndefined();
  });

  test("a supplied bucket-scope input yields the same bucketId deriveBucketId would compute", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const handle = makeClient({});
    const transport = new OpenCodeSdkTransport({ client: handle.client });
    const localKey = Buffer.from("1".repeat(64), "hex");
    const report = await transport.capabilities({
      credentialFingerprint: "fp-opencode-1",
      bucketScope: { project: "proj-9" },
      localKey,
    });
    const expected = deriveBucketId(
      {
        provider: "openai",
        credentialFingerprint: "fp-opencode-1",
        scope: { project: "proj-9" },
      },
      localKey,
    );
    expect(report.rateLimitBucketId).toBe(expected);
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
          wallMs: 0,
          tokens: {},
          completeness: "unavailable",
          billingMode: "unknown",
          costSource: "unknown",
        },
        stderrTail: "something entirely opaque happened",
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pr-hero findings on PR #74 (head 76cd96c2). All five were confirmed against
// the repository before any code moved; these tests pin the fixes.
// ---------------------------------------------------------------------------

describe("OpenCodeSdkTransport per-attempt deadline ownership (F006)", () => {
  // Per-attempt watchdog is harness-owned (StepSpec.timeoutMs → harness
  // watchdog). TransportRequest carries no timeoutMs — see
  // test/production-transport-lifecycle.test.ts and
  // docs/multi-runtime-model-diversity-design.md §3.

  test("a hung provider settles when the harness abort signal fires", async () => {
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

    expect(outcome.completion).toBe("cancelled");
    expect(outcome.timedOut).toBeUndefined();
  });

  test("abort without provider proof is classified remote_abort_unconfirmed", async () => {
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

    expect(outcome.completion).toBe("cancelled");
    expect(rig.transport.classifyFailure(outcome)).toBe(
      "remote_abort_unconfirmed",
    );
    expect(handle.abortCount()).toBe(1);
  });

  test("no transport-internal attempt deadline is armed", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "terminal", proof: completedProof("e1") }]),
      polls: [{ kind: "terminal", proof: completedProof("e1") }],
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;
    expect(outcome.completion).toBe("success");
    expect(outcome.timedOut).toBeUndefined();
  });
});

describe("OpenCodeSdkTransport stream teardown (F005)", () => {
  // execute() awaits `done`, not the watchers (opencode-sdk.ts:631-633). The
  // poll watcher self-terminates because it wakes on its own delay() and
  // re-checks `settled`; the stream watcher has no timer of its own — it is
  // parked on next(), and its `if (settled) return` only runs when an event
  // arrives. When settlement comes from the poll watcher or the timeout, a
  // provider that then goes quiet leaves that subscription open forever.
  test("the stream iterator is closed when settlement comes from elsewhere", async () => {
    let returned = false;
    let opened = false;
    const client: OpenCodeClientLike = {
      createSession: async () => ({ id: "oc-sess-1" }),
      streamEvents: () =>
        ({
          [Symbol.asyncIterator]() {
            opened = true;
            return {
              // Parked forever: the provider went quiet after settlement.
              next: () => new Promise<never>(() => {}),
              return: async () => {
                returned = true;
                return { done: true as const, value: undefined };
              },
            };
          },
        }) as AsyncIterable<OpenCodeClientEvent>,
      pollStatus: async () => ({
        kind: "terminal" as const,
        proof: completedProof("e-poll"),
      }),
      abort: async () => {},
    };
    const rig = makeRig({ client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(opened).toBe(true);
    expect(outcome.completion).toBe("success");
    await flush();
    expect(returned).toBe(true);
  });
});

describe("OpenCodeSdkTransport declared capabilities (F001)", () => {
  // harness.ts:425 reads report.cancellation.deadlineMs and TRUSTS it as the
  // real bound before treating a cancellation as unconfirmed. Declaring a
  // fixed module constant while abortConfirmMs/cleanupMs are constructor
  // options means an instance can be configured to need longer than it
  // promises, and the harness would give up early on a transport that was
  // still within its own budget.
  test("the declared deadline follows the instance's actual budgets", async () => {
    const handle = makeClient({});
    const rig = makeRig({
      client: handle.client,
      transport: { abortConfirmMs: 500, cleanupMs: 100 },
    });
    const report = await rig.transport.capabilities();
    expect(report.cancellation.deadlineMs).toBe(1100);

    const slow = makeRig({
      client: handle.client,
      transport: { abortConfirmMs: 20_000, cleanupMs: 3_000 },
    });
    expect((await slow.transport.capabilities()).cancellation.deadlineMs).toBe(
      23_500,
    );
  });

  test("the production defaults still declare the §5.2 SDK row's 6,500 ms", async () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });
    expect((await transport.capabilities()).cancellation.deadlineMs).toBe(6500);
  });
});

describe("OpenCodeSdkTransport stderrTail byte bound (F002)", () => {
  // MAX_STDERR_TAIL_BYTES is declared and documented as a BYTE bound, and the
  // file's own utf8Bytes() helper is used correctly for the delta and
  // aggregate bounds. String.slice counts UTF-16 code units, so multi-byte
  // provider text sails past the bound the transport claims to enforce.
  test("a multi-byte tail is bounded in bytes, not code units", async () => {
    // Each stream error detail is multi-byte; enough of them to blow a
    // code-unit-based trim well past 64 KiB of actual bytes.
    const detail = "→".repeat(40_000);
    const handle = makeClient({ stream: new Error(detail) });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 8);
    const outcome = await pending;

    expect(
      new TextEncoder().encode(outcome.stderrTail).length,
    ).toBeLessThanOrEqual(64 * 1024);
    // Still a usable tail, not an empty string.
    expect(outcome.stderrTail.length).toBeGreaterThan(0);
  });
});

describe("OpenCodeSdkTransport classification witness (F003)", () => {
  // finalText is model-generated REVIEW PROSE, and pr-hero reviews code for
  // exactly these failure modes — "no rate limit on this endpoint",
  // "unauthorized access is possible". Matching generic patterns against it
  // makes the tool's own subject-matter vocabulary look like provider
  // diagnostics. Every violation this transport detects is stamped into
  // `notes` → stderrTail (opencode-sdk.ts:664-672), so stderrTail is the
  // complete diagnostics channel and finalText has no business in the
  // witness at all.
  test("review prose about auth and rate limits is not a transport failure", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });
    const prose = [
      "The handler allows unauthorized access when the token is absent.",
      "There is no rate limit on this endpoint, so quota exceeded errors are likely.",
      "Please log in is rendered even after a successful network error retry.",
    ].join("\n");
    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "verified",
        finalText: prose,
        usage: {
          wallMs: 1,
          tokens: { inputUncached: 1 },
          completeness: "complete" as const,
          billingMode: "subscription" as const,
          costSource: "provider" as const,
          cashCostUsd: 0,
        },
        stderrTail: "",
      }),
    ).toBeUndefined();
  });

  test("the same words in the provider's own stderr still classify", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });
    const base = {
      completion: "failed" as const,
      protocolIntegrity: "verified" as const,
      finalText: "",
      usage: {
        wallMs: 1,
        tokens: { inputUncached: 1 },
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "provider" as const,
        cashCostUsd: 0,
      },
    };
    expect(
      transport.classifyFailure({ ...base, stderrTail: "401 unauthorized" }),
    ).toBe("auth_invalid");
    expect(
      transport.classifyFailure({ ...base, stderrTail: "rate limit exceeded" }),
    ).toBe("rate_limit");
    expect(
      transport.classifyFailure({ ...base, stderrTail: "socket hang up" }),
    ).toBe("network_transient");
  });

  // Issue #121, part D. When `sdk.createClient is not a function` killed every
  // live step, the outcome carried no mapped witness, so the harness fell
  // through to the legacy classifier and called a TypeError inside our own
  // transport a FORMAT violation — spending the format-reminder budget on an
  // attempt the model never saw, and filing an infrastructure failure in the
  // bucket reserved for model misbehaviour. A session that could not be
  // created is the runtime being unavailable, which §7 makes terminal.
  describe("a session that could not be created", () => {
    const base = {
      completion: "failed" as const,
      protocolIntegrity: "unverified" as const,
      finalText: "",
      usage: {
        wallMs: 1,
        tokens: { inputUncached: 1 },
        completeness: "complete" as const,
        billingMode: "subscription" as const,
        costSource: "provider" as const,
        cashCostUsd: 0,
      },
    };

    test("classifies as runtime_unavailable, not a format violation", () => {
      const transport = new OpenCodeSdkTransport({
        client: makeClient({}).client,
      });
      const outcome = {
        ...base,
        stderrTail:
          "[pr-hero] opencode sdk: session creation failed: sdk.createClient is not a function.",
      };

      expect(transport.classifyFailure(outcome)).toBe("runtime_unavailable");

      // What the harness actually does with it: a terminal ruling, and no
      // format retry spent.
      const resolution = resolveFailureCause({
        outcome,
        classifyFailure: (o) => transport.classifyFailure(o),
        parseThrew: true,
      });
      expect(resolution).toEqual({
        kind: "cause",
        cause: "runtime_unavailable",
      });
      expect(legacyClassificationFromCause(resolution)).toBe("terminal");
      expect(
        decideRetryDisposition("runtime_unavailable", {
          transientAttemptsUsed: 0,
          formatRetriesUsed: 0,
        }),
      ).toEqual({ action: "terminal" });
    });

    // ORDERING, not decoration. A creation failure whose text is a refused
    // connection is a transient network failure and keeps its retry; the
    // creation witness is the LAST resort, so it can never shadow the
    // auth/rate-limit/network patterns above it and silently delete a retry
    // path.
    test("still yields to the network witness inside its own message", () => {
      const transport = new OpenCodeSdkTransport({
        client: makeClient({}).client,
      });
      expect(
        transport.classifyFailure({
          ...base,
          stderrTail:
            "[pr-hero] opencode sdk: session creation failed: fetch failed",
        }),
      ).toBe("network_transient");
      expect(
        transport.classifyFailure({
          ...base,
          stderrTail:
            "[pr-hero] opencode sdk: session creation failed: 401 unauthorized",
        }),
      ).toBe("auth_invalid");
    });
  });
});

// Issue #122. Nothing in the artifacts recorded the tool allow map that was
// actually sent, so the only evidence the map was inert came from reading a
// hunter narrate tool use it never performed. #116's ledger requires the
// tools/MCP axis be provable by READING artifacts, and `allowMapEnforced:
// true` in the capability report is a hardcoded constant, not an observation.
describe("OpenCodeSdkTransport resolved tool map diagnostics (#122)", () => {
  const TOOL_MAP = {
    read: true,
    grep: true,
    glob: true,
    bash: false,
    write: false,
    edit: false,
  };

  test("stamps the resolved map into diagnosticsTail, once, with sorted keys", async () => {
    const handle = makeClient({
      toolMap: TOOL_MAP,
      stream: streamOf([{ kind: "terminal", proof: completedProof("evt-1") }]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    const line =
      "[pr-hero] opencode sdk: resolved tool map: " +
      "bash=false,edit=false,glob=true,grep=true,read=true,write=false";
    // #126: the line moved off the classification witness. It says what WE
    // resolved, in a provider-supplied id vocabulary we do not control.
    expect(outcome.diagnosticsTail).toContain(line);
    expect((outcome.diagnosticsTail ?? "").split(line)).toHaveLength(2);
    expect(outcome.stderrTail).not.toContain("resolved tool map");
  });

  // #122 asked whether OpenCode's ids could read as provider diagnostics —
  // "invalid" against `invalid api key`, an id that looks like a rate limit or
  // a socket error. #126 answers it structurally instead of by vocabulary
  // audit: the line rides diagnosticsTail, which classifyFailure never reads,
  // so no id can classify an attempt no matter how the surface grows. The
  // hostile map below would have matched on the old channel.
  test("the map line never becomes a failure classification by itself", () => {
    const transport = new OpenCodeSdkTransport({
      client: makeClient({}).client,
    });

    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: {
          wallMs: 1,
          tokens: { inputUncached: 1 },
          completeness: "complete",
          billingMode: "subscription",
          costSource: "provider",
          cashCostUsd: 0,
        },
        stderrTail: "",
        diagnosticsTail:
          "[pr-hero] opencode sdk: resolved tool map: " +
          "apply_patch=false,bash=false,edit=false,glob=true,grep=true," +
          "invalid=false,question=false,read=true,skill=false,task=false," +
          "todowrite=false,webfetch=false,websearch=false,write=false," +
          "unauthorized=false,rate_limit_429=false,econnreset=false",
      }),
    ).toBeUndefined();
  });

  test("a client that reports no map adds no line", async () => {
    const handle = makeClient({
      stream: streamOf([{ kind: "terminal", proof: completedProof("evt-1") }]),
    });
    const rig = makeRig({ client: handle.client });
    const pending = rig.transport.execute(makeRequest(), {
      signal: rig.controller.signal,
      events: rig.sink,
    });
    await advance(rig.clock, 6);
    const outcome = await pending;

    expect(outcome.diagnosticsTail).not.toContain("resolved tool map");
    expect(outcome.stderrTail).not.toContain("resolved tool map");
  });
});
