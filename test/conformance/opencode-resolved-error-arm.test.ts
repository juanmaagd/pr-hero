import { describe, expect, test } from "bun:test";
import type {
  AsyncEventSink,
  ProviderEvent,
  TransportRequest,
} from "../../src/execution/contracts";
import {
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "../../src/transports/opencode-client";
import type { OpenCodeTransportClock } from "../../src/transports/opencode-sdk";
import { OpenCodeSdkTransport } from "../../src/transports/opencode-sdk";

// The defect class PR #123 named and then only half-closed. Under the SDK's
// default `ThrowOnError = false` an API-level failure RESOLVES with
// `{ data: undefined, error }` — it never rejects. So `.catch()` never fires
// and `await` never throws, and every call whose result is discarded records
// a provider refusal as a success.
//
// Two calls were left that way after the surface fix: the fired-not-awaited
// `session.prompt` (the attempt sat armed waiting for a terminal a turn that
// never started could not produce, until the harness watchdog killed it) and
// `session.abort` (a refused abort was recorded as a confirmed one, so paid
// remote work could keep running with no diagnostic trail).

const SESSION_ID = "ses_error_arm";

// Every deadline the transport owns is fired by hand; nothing here sleeps a
// real one (PR #118: host-dependent waits are how this suite flaked before).
class ManualClock implements OpenCodeTransportClock {
  private pending: Array<() => void> = [];

  schedule(_ms: number, fn: () => void): () => void {
    this.pending.push(fn);
    return () => {
      this.pending = this.pending.filter((candidate) => candidate !== fn);
    };
  }

  fireAll(): void {
    for (const fn of this.pending.splice(0)) fn();
  }
}

class RecordingSink implements AsyncEventSink {
  readonly events: ProviderEvent[] = [];

  async push(event: ProviderEvent): Promise<"accepted" | "closed"> {
    this.events.push(event);
    return "accepted";
  }

  close(): void {}
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

// Pre-fix both scenarios hang rather than fail, so every assertion here is
// raced against a bounded timer: a hang must read as a verdict, not as bun's
// generic 5 s timeout.
function withinWindow<T>(work: Promise<T>, hung: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(hung), 250);
    }),
  ]);
}

interface FakeSdk {
  sdk: OpenCodeSdkLike;
  abortCalls: () => number;
}

function fakeSdk(
  options: {
    promptError?: unknown;
    abortError?: unknown;
    // The subscription ends at once instead of staying open. Used where the
    // stream must not be the thing under test.
    emptyStream?: boolean;
  } = {},
): FakeSdk {
  let aborts = 0;
  const sdk: OpenCodeSdkLike = {
    createOpencodeClient: () => ({
      session: {
        create: async () => ({ data: { id: SESSION_ID } }),
        prompt: async () =>
          options.promptError !== undefined
            ? { data: undefined, error: options.promptError }
            : { data: { info: {}, parts: [] } },
        messages: async () => ({ data: [] }),
        abort: async () => {
          aborts += 1;
          return options.abortError !== undefined
            ? { data: undefined, error: options.abortError }
            : { data: true };
        },
      },
      event: {
        subscribe: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              // A refused prompt produces no events at all: no message is
              // created, so neither observer has anything to observe.
              if (options.emptyStream === true) return;
              await new Promise<never>(() => {});
            },
          },
        }),
      },
    }),
  };
  return { sdk, abortCalls: () => aborts };
}

function rigClient(fake: FakeSdk) {
  return createOpenCodeClient({
    loadSdk: async () => fake.sdk,
    launchServer: async () => ({
      url: "http://127.0.0.1:1",
      pid: 1,
      close: async () => {},
    }),
    model: { providerID: "openai", modelID: "test-model" },
    readSystemPrompt: async () => "SYSTEM",
  });
}

const INPUT = {
  cwd: "/tmp/work",
  userPrompt: "review this",
  systemPromptPath: "/tmp/system.md",
  tools: ["read"],
};

function makeRequest(): TransportRequest {
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
  };
}

describe("a prompt the provider refuses", () => {
  // The prompt is FIRED, never awaited, and that shape is load-bearing:
  // session.prompt blocks until the turn finishes (the probe measured 4.5 s)
  // and the ROADMAP forbids completing an attempt from one blocking HTTP
  // call. What must change is that the RESOLVED error arm is observed — not
  // that the call becomes synchronous.
  test("reaches the stream consumer instead of vanishing", async () => {
    const fake = fakeSdk({ promptError: { message: "model not found" } });
    const client = rigClient(fake);
    const session = await client.createSession(INPUT);

    const drained = (async () => {
      for await (const _event of client.streamEvents(session)) {
        // A refused prompt yields nothing; only the failure may arrive.
      }
      return "the stream ended without surfacing the refusal";
    })().catch((error: unknown) => (error as Error).message);

    expect(
      await withinWindow(
        drained,
        "the stream hung: the refusal was never observed",
      ),
    ).toMatch(/session\.prompt failed.*model not found/s);
  });

  test("fails the attempt promptly, with the provider's own words", async () => {
    const fake = fakeSdk({ promptError: { message: "model not found" } });
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fake),
      clock,
      cleanupMs: 20,
      pollIntervalMs: 10,
      pollRoundMs: 20,
    });

    const outcome = await withinWindow(
      transport.execute(makeRequest(), {
        signal: new AbortController().signal,
        events: sink,
      }),
      undefined,
    );

    // No watchdog, no stall deadline: the failure is decided by the refusal
    // itself, which an API-level rejection delivers at CALL time.
    if (outcome === undefined) throw new Error("the attempt never settled");
    expect(outcome.completion).toBe("failed");
    // A transport-side observation is never a provider terminal proof.
    expect(outcome.protocolIntegrity).toBe("unverified");
    expect(outcome.terminalProof).toBeUndefined();
    expect(outcome.stderrTail).toContain("session.prompt failed");
    expect(outcome.stderrTail).toContain("model not found");
    // Best-effort release of a remote session that may exist even though the
    // turn never started.
    expect(fake.abortCalls()).toBeGreaterThan(0);
  });

  // §7 makes runtime_unavailable TERMINAL. A turn that never started is the
  // same class as a session that never opened: there is no model output to
  // reformat, so spending the format-reminder budget on it repeats issue
  // #121's mistake in a new place.
  test("classifies as runtime_unavailable, not a format violation", () => {
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fakeSdk()),
    });
    expect(
      transport.classifyFailure({
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: {
          wallMs: 1,
          tokens: {},
          completeness: "unavailable",
          billingMode: "subscription",
          costSource: "unknown",
        },
        stderrTail:
          "[pr-hero] opencode sdk: stream errored: opencode session.prompt failed: model not found",
      }),
    ).toBe("runtime_unavailable");
  });

  // ORDERING, not decoration — the same rule the session-creation witness
  // lives under. A refused prompt carries the provider's own text, and a 429
  // or a 401 in it is a retryable fact the last-resort witness must never
  // shadow.
  test("still yields to the network witness inside its own message", () => {
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fakeSdk()),
    });
    const base = {
      completion: "failed" as const,
      protocolIntegrity: "unverified" as const,
      finalText: "",
      usage: {
        wallMs: 1,
        tokens: {},
        completeness: "unavailable" as const,
        billingMode: "subscription" as const,
        costSource: "unknown" as const,
      },
    };
    expect(
      transport.classifyFailure({
        ...base,
        stderrTail:
          "[pr-hero] opencode sdk: stream errored: opencode session.prompt failed: 429 rate limit",
      }),
    ).toBe("rate_limit");
    expect(
      transport.classifyFailure({
        ...base,
        stderrTail:
          "[pr-hero] opencode sdk: stream errored: opencode session.prompt failed: 401 unauthorized",
      }),
    ).toBe("auth_invalid");
  });
});

describe("an abort the provider refuses", () => {
  // §5.2/§290: abort is best-effort and runs while the attempt is unwinding,
  // so it must stay non-fatal. Best-effort means OBSERVED, not silent: a
  // refused abort leaves remote work running — and billing — and the note is
  // the only trail that says so.
  test("is recorded as a failure instead of a confirmed abort", async () => {
    const fake = fakeSdk({
      abortError: { message: "session already gone" },
      emptyStream: true,
    });
    const clock = new ManualClock();
    const sink = new RecordingSink();
    const controller = new AbortController();
    const transport = new OpenCodeSdkTransport({
      client: rigClient(fake),
      clock,
      abortConfirmMs: 500,
      cleanupMs: 20,
      pollIntervalMs: 10,
      pollRoundMs: 20,
    });

    const pending = transport.execute(makeRequest(), {
      signal: controller.signal,
      events: sink,
    });
    await flush();
    controller.abort();
    // The note rides `void callAbortOnce()`; firing the confirmation deadline
    // before it lands would assemble the notes without it.
    await flush();
    clock.fireAll();

    const outcome = await withinWindow(pending, undefined);
    if (outcome === undefined) throw new Error("the attempt never settled");
    // Still non-fatal: the teardown path completed and returned an outcome.
    expect(outcome.completion).toBe("cancelled");
    expect(fake.abortCalls()).toBe(1);
    expect(outcome.stderrTail).toContain("abort call failed");
    expect(outcome.stderrTail).toContain("session already gone");
  });
});
