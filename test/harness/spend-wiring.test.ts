// D1-08 PR5b (§9.1 five-step order + D8): the FINAL wiring unit of the
// d1-08-usage-spend-concurrency chain. PR4 built the ledger pure (`spend-
// limiter.ts`); PR5a wired concurrency control (`admission.ts`) into
// `runAttempt` with NO ledger call at all. This file is the harness-
// observable tripwire table for the missing half: "PR5b | A stub ledger
// that refuses to reserve means NO SPAWN HAPPENS AT ALL ...; every attempt
// in pipeline.json carries a reservationId and a terminal state; abort-
// before-start releases, abort-after-start does not; AND an unresolved_
// remote state appears in renderResult's returned lines — not only in
// pipeline.json" (design doc, PR5b tripwire row).

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderCapabilityReport,
  ProviderTransport,
} from "../../src/execution/contracts";
import { StepExecutionHarness } from "../../src/execution/harness";
import {
  InMemorySpendLedger,
  type ReserveSpendInput,
  type SettlementDecision,
  type SpendLedger,
  type SpendReservation,
  SpendReservationFencedError,
} from "../../src/execution/spend-limiter";
import type { NormalizedUsage } from "../../src/execution/usage-normalized";
import type { Finding, FindingsDocument, Telemetry } from "../../src/findings";
import { buildStepArgv, type StepSpec } from "../../src/step-runner";
import { type ResultInput, renderResult } from "../../src/ui-result";

// ---- shared fixtures (mirrors test/harness/concurrency-wiring.test.ts) ----

const USAGE: NormalizedUsage = {
  wallMs: 1,
  tokens: { inputUncached: 1 },
  completeness: "complete",
  billingMode: "subscription",
  costSource: "provider",
  cashCostUsd: 0,
};

function capabilities(
  overrides: Partial<ProviderCapabilityReport> = {},
): ProviderCapabilityReport {
  return {
    backend: "claude-code",
    status: "ready",
    auth: {
      kind: "claude_subscription_oauth",
      projectionReady: true,
      probe: "passed",
    },
    isolation: {
      syntheticHome: true,
      workspaceReadBroker: true,
      codegraphPolicy: true,
    },
    protocol: {
      terminalProof: true,
      boundedEvents: true,
      usageMode: "snapshot",
    },
    cancellation: { deadlineMs: 7500, conformance: "passed" },
    billing: { mode: "subscription", pricingReady: true },
    issues: [],
    ...overrides,
  };
}

function okOutcome(usage: NormalizedUsage = USAGE) {
  return {
    completion: "success" as const,
    protocolIntegrity: "verified" as const,
    finalText: JSON.stringify({ findings: [] }),
    usage,
    stderrTail: "",
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fakeSpawn = (() => ({}) as unknown) as typeof Bun.spawn;

async function makeStep(
  dir: string,
  overrides: Partial<StepSpec> = {},
): Promise<StepSpec> {
  const name = overrides.name ?? "hunter-reliability";
  const systemPromptPath = path.join(dir, `${name}.system.md`);
  await writeFile(systemPromptPath, "system prompt");
  return {
    name,
    systemPromptPath,
    prompt: "Review diff",
    tools: [],
    mcpConfigPath: path.join(dir, "mcp.json"),
    model: "claude-sonnet-4-5",
    cwd: dir,
    outPath: path.join(dir, `${name}.out.json`),
    timeoutMs: 5_000,
    maxAttempts: 1,
    parse: (text) => JSON.parse(text),
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-spend-wiring-"));
  await mkdir(path.join(dir, "logs"), { recursive: true });
  return dir;
}

// Wraps the real, already-tested InMemorySpendLedger so these tests assert
// harness WIRING (did the harness call the right method at the right time)
// rather than re-testing the ledger's own CAS semantics (spend-limiter.test.ts's
// job).
class SpyLedger implements SpendLedger {
  private readonly inner = new InMemorySpendLedger();
  reserveCalls: ReserveSpendInput[] = [];
  settleCalls = 0;
  releaseUnstartedCalls = 0;
  markUnresolvedCalls = 0;

  async reserve(
    input: ReserveSpendInput,
    token: Parameters<InMemorySpendLedger["reserve"]>[1],
  ): Promise<SpendReservation> {
    this.reserveCalls.push(input);
    return this.inner.reserve(input, token);
  }

  async settle(
    reservationId: string,
    decision: Extract<SettlementDecision, { kind: "settle" }>,
    idempotencyKey: string,
  ): Promise<void> {
    this.settleCalls++;
    return this.inner.settle(reservationId, decision, idempotencyKey);
  }

  async releaseUnstarted(
    reservationId: string,
    idempotencyKey: string,
  ): Promise<void> {
    this.releaseUnstartedCalls++;
    return this.inner.releaseUnstarted(reservationId, idempotencyKey);
  }

  async markUnresolvedRemote(
    reservationId: string,
    knownUsd: number | undefined,
    idempotencyKey: string,
  ): Promise<void> {
    this.markUnresolvedCalls++;
    return this.inner.markUnresolvedRemote(
      reservationId,
      knownUsd,
      idempotencyKey,
    );
  }
}

describe("PR5b — SpendLedger wiring (§9.1 five-step order)", () => {
  // 5b.1 RED→GREEN
  test("a SpendLedger that refuses reserve() fails the step without invoking the transport, preserving prior reservations", async () => {
    const dir = await tempDir();
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => {
        transportCalls++;
        return {
          completion: "failed" as const,
          protocolIntegrity: "verified" as const,
          finalText: "not json",
          usage: {
            ...USAGE,
            completeness: "partial" as const,
            tokens: { providerReportedTotal: 100 },
          },
          stderrTail: "boom",
        };
      },
      classifyFailure: () => undefined,
    };
    let reserveCalls = 0;
    const inner = new InMemorySpendLedger();
    const ledger: SpendLedger = {
      reserve: async (input, token) => {
        reserveCalls++;
        if (reserveCalls > 1) {
          throw new SpendReservationFencedError(input.bucketId);
        }
        return inner.reserve(input, token);
      },
      settle: (id, decision, key) => inner.settle(id, decision, key),
      releaseUnstarted: (id, key) => inner.releaseUnstarted(id, key),
      markUnresolvedRemote: (id, known, key) =>
        inner.markUnresolvedRemote(id, known, key),
    };
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });
    const step = await makeStep(dir, { maxAttempts: 3 });

    const result = await harness.run(step);

    expect(result.status).toBe("failed");
    expect(transportCalls).toBe(1);
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
  });

  // 5b.2 RED→GREEN
  test("every reserved attempt carries a reservationId and a TERMINAL state, never left 'reserved'", async () => {
    const dir = await tempDir();
    let call = 0;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => {
        call++;
        if (call === 1) {
          return {
            completion: "failed" as const,
            protocolIntegrity: "verified" as const,
            finalText: "not json",
            usage: USAGE,
            stderrTail: "boom",
          };
        }
        return okOutcome();
      },
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const step = await makeStep(dir, { maxAttempts: 2 });
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(ledger.reserveCalls.length).toBe(2);
    expect(result.reservations?.length).toBe(2);
    for (const reservation of result.reservations ?? []) {
      expect(reservation.reservationId.length).toBeGreaterThan(0);
      expect(reservation.state).not.toBe("reserved");
    }
    // Settlement is keyed on usage COMPLETENESS, never on transport success —
    // both attempts carried complete usage, so both settled as a number even
    // though the first one failed to parse.
    expect(ledger.settleCalls).toBe(2);
  });

  // 5b.3 RED→GREEN (part 1): abort raced ahead of execution.
  test("abort timing (1/2): a cancellation that lands AFTER reserve() but BEFORE execution releases the reservation as released_unstarted, and the transport is never invoked", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => {
        transportCalls++;
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    // A reservation exists (real CAS state), but the signal is aborted the
    // instant reserve() resolves — before runAttempt ever calls
    // runAdmittedAttempt/executeSession, so the provider attempt has
    // PROVABLY never started.
    const racingLedger: SpendLedger = {
      reserve: async (input, token) => {
        const reservation = await ledger.reserve(input, token);
        controller.abort();
        return reservation;
      },
      settle: (id, decision, key) => ledger.settle(id, decision, key),
      releaseUnstarted: (id, key) => ledger.releaseUnstarted(id, key),
      markUnresolvedRemote: (id, knownUsd, key) =>
        ledger.markUnresolvedRemote(id, knownUsd, key),
    };
    const step = await makeStep(dir);
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: racingLedger,
      signal: controller.signal,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    expect(transportCalls).toBe(0);
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("released_unstarted");
    expect(ledger.releaseUnstartedCalls).toBe(1);
    expect(ledger.markUnresolvedCalls).toBe(0);
  });

  // 5b.3 RED→GREEN (part 2): abort after the provider attempt started.
  test("abort timing (2/2): a cancellation AFTER the provider attempt started does NOT release the reservation — it lands unresolved, never released_unstarted", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const ledger = new SpyLedger();
    // Ignores the abort signal and resolves well after the settlement
    // grace expires — the transport HAS been invoked by the time the
    // cancellation is observed (same shape as PR5a's 5a.3 fixture).
    const hangingTransport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () =>
        capabilities({
          backend: "opencode",
          cancellation: { deadlineMs: 5, conformance: "passed" },
        }),
      execute: async () => {
        await sleepMs(40);
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };
    const step = await makeStep(dir);
    const harness = new StepExecutionHarness({
      transport: hangingTransport,
      spendLedger: ledger,
      signal: controller.signal,
      graceMarginMs: 5,
      spawnFn: fakeSpawn,
    });

    const runPromise = harness.run(step);
    await sleepMs(10);
    controller.abort();
    const result = await runPromise;

    expect(result.status).toBe("failed");
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(ledger.releaseUnstartedCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
  });

  // 5b.4 RED→GREEN
  test("a delivered attempt whose usage completeness is not 'complete' routes to markUnresolvedRemote — settle() is never called for it", async () => {
    const dir = await tempDir();
    const partialUsage: NormalizedUsage = {
      wallMs: 500,
      tokens: { providerReportedTotal: 100 },
      completeness: "partial",
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.05,
    };
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => okOutcome(partialUsage),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const step = await makeStep(dir);
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.05);
    expect(ledger.settleCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
  });

  // 2026-09-02, the metered-zero rule reaching the ledger. `settlementFromUsage`
  // is the only producer of a SettlementDecision, so this is the harness-
  // observable half of the same fact `spend-limiter.test.ts` asserts purely:
  // the CAS transition the harness applies changes with the billing mode, not
  // just the decision object.
  //
  // The pair is the discriminator. A rule that refused every $0 would pass
  // the first arm and fail the second, and a run under a subscription
  // credential would fence its own bucket on the first genuinely free step.
  test("a metered attempt reporting $0 with output tokens lands unresolved_remote, not settled", async () => {
    const dir = await tempDir();
    const meteredZero: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0,
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => okOutcome(meteredZero),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    // Not 0: a zero that cannot be trusted is not a known cost, and carrying
    // it would print "$0 known" beside the fenced bucket.
    expect(result.reservations?.[0]?.knownUsd).toBeUndefined();
    expect(ledger.settleCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
  });

  // #182 follow-up: the free-nonzero fail-fast. Unresolved alone only fences
  // the bucket while the retry loop keeps spending attempts on a flipped
  // model, so a decision carrying reason `free_nonzero_cost` fails the step
  // CLOSED with no retry — `legacy_terminal` breaks the loop before
  // `decideRetryDisposition` can resurrect it. The fence is still applied
  // (the spend may be real).
  //
  // The pair below is the discriminator. The first arm proves fail-closed: a
  // parse failure classified `network_transient` with maxAttempts 3 would
  // otherwise retry twice, but the flip ends the step on attempt 1. The
  // second arm proves restraint: free usage with NO cash figure releases
  // WITHOUT fencing (free-route fence scope) — no evidence of billing, no
  // fail-fast.
  test("a free attempt reporting priced cost fails the step with no retry and fences its bucket", async () => {
    const dir = await tempDir();
    let transportCalls = 0;
    const flipped: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
      cashCostUsd: 0.06,
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        transportCalls++;
        return {
          completion: "failed" as const,
          protocolIntegrity: "verified" as const,
          finalText: "not json",
          usage: flipped,
          stderrTail: "boom",
        };
      },
      // Transient would normally buy two more attempts under maxAttempts 3 —
      // the flip must deny them all.
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir, { maxAttempts: 3 }));

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(transportCalls).toBe(1);
    expect(result.reservations?.length).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.06);
    expect(ledger.settleCalls).toBe(0);
    expect(ledger.markUnresolvedCalls).toBe(1);
    expect(result.stderrTail).toContain("free-route cost flip");
    expect(result.stderrTail).toContain("$0.06");
    expect(result.stderrTail).toContain("re-probe");

    // The bucket is fenced for the rest of the run: a second step on the same
    // ledger is refused before its transport is ever invoked.
    let secondTransportCalls = 0;
    const secondTransport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        secondTransportCalls++;
        return okOutcome();
      },
      classifyFailure: () => undefined,
    };
    const secondHarness = new StepExecutionHarness({
      transport: secondTransport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });
    const second = await secondHarness.run(
      await makeStep(dir, { name: "hunter-resilience" }),
    );
    expect(second.status).toBe("failed");
    expect(secondTransportCalls).toBe(0);
  });

  test("a free attempt with undefined cash releases without fencing: delivered, no flip note, no fail-fast", async () => {
    const dir = await tempDir();
    const freeUnknownCash: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => okOutcome(freeUnknownCash),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    expect(result.status).toBe("ok");
    // #182 follow-up, free-route fence scope: no cash figure means no spend
    // evidence on a free route, so the attempt releases instead of fencing —
    // collectUnresolvedSpend/renderResult only read unresolved_remote, so this
    // reservation is invisible to both (no floor marker, no unresolved row).
    expect(result.reservations?.[0]?.state).toBe("released_unstarted");
    expect(result.reservations?.[0]?.knownUsd).toBeUndefined();
    expect(ledger.markUnresolvedCalls).toBe(0);
    expect(ledger.releaseUnstartedCalls).toBe(1);
    expect(result.stderrTail).not.toContain("free-route cost flip");
  });

  test("a free transient failure retries on the same ledger: no fence, sibling steps unaffected", async () => {
    const dir = await tempDir();
    const freeUnknownCash: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
    };
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        transportCalls++;
        if (transportCalls === 1) {
          return {
            completion: "failed" as const,
            protocolIntegrity: "verified" as const,
            finalText: "not json",
            usage: freeUnknownCash,
            stderrTail: "boom",
          };
        }
        return okOutcome({
          ...freeUnknownCash,
          cashCostUsd: 0,
        });
      },
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir, { maxAttempts: 3 }));

    expect(result.status).toBe("ok");
    expect(transportCalls).toBe(2);
    expect(result.reservations?.length).toBe(2);
    expect(result.reservations?.[0]?.state).toBe("released_unstarted");
    expect(result.reservations?.[1]?.state).toBe("settled");

    // The released reservation fenced nothing: a sibling step on the same
    // ledger reserves and runs fine.
    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("ok");
  });

  test("a metered transient failure still fences: no retry, sibling steps refused", async () => {
    const dir = await tempDir();
    const meteredPartial: NormalizedUsage = {
      wallMs: 500,
      tokens: { providerReportedTotal: 100 },
      completeness: "partial",
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.05,
    };
    let transportCalls = 0;
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => {
        transportCalls++;
        return {
          completion: "failed" as const,
          protocolIntegrity: "verified" as const,
          finalText: "not json",
          usage: meteredPartial,
          stderrTail: "boom",
        };
      },
      classifyFailure: (outcome) =>
        outcome.stderrTail.includes("boom") ? "network_transient" : undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir, { maxAttempts: 3 }));

    // The fence lands before the retry can reserve: one transport call, then
    // the fenced reserve fails the step without a second spawn.
    expect(result.status).toBe("failed");
    expect(transportCalls).toBe(1);
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(ledger.markUnresolvedCalls).toBe(1);

    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("failed");
    expect(sibling.stderrTail).toContain("fenced");
    expect(transportCalls).toBe(1);
  });

  test("a delivered free attempt reporting priced cost stays delivered with the flip note appended", async () => {
    const dir = await tempDir();
    const flipped: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "free",
      costSource: "provider",
      cashCostUsd: 0.06,
    };
    const transport: ProviderTransport = {
      backend: "opencode",
      capabilities: async () => capabilities({ backend: "opencode" }),
      execute: async () => okOutcome(flipped),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const result = await harness.run(await makeStep(dir));

    // Delivered, not failed: the parsed output was already persisted and the
    // loop returns ok on delivered — rewriting it would claim an artifact was
    // never written. The fence is still applied and the note still lands.
    expect(result.status).toBe("ok");
    expect(result.reservations?.[0]?.state).toBe("unresolved_remote");
    expect(result.reservations?.[0]?.knownUsd).toBe(0.06);
    expect(result.stderrTail).toContain("free-route cost flip");
    expect(result.stderrTail).toContain("$0.06");

    // The bucket is still fenced for the rest of the run: fail-closed is not
    // weakened by preserving the kind.
    const sibling = await new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    }).run(await makeStep(dir, { name: "hunter-resilience" }));
    expect(sibling.status).toBe("failed");
    expect(sibling.stderrTail).toContain("fenced");
  });

  test("a subscription attempt reporting $0 with output tokens still settles, leaving its bucket unfenced", async () => {
    const dir = await tempDir();
    const subscriptionZero: NormalizedUsage = {
      wallMs: 500,
      tokens: { outputVisible: 120, outputKnown: 120, totalKnown: 300 },
      completeness: "complete",
      billingMode: "subscription",
      costSource: "provider",
      cashCostUsd: 0,
    };
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => okOutcome(subscriptionZero),
      classifyFailure: () => undefined,
    };
    const ledger = new SpyLedger();
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: ledger,
      spawnFn: fakeSpawn,
    });

    const first = await harness.run(await makeStep(dir));
    expect(first.reservations?.[0]?.state).toBe("settled");
    expect(ledger.settleCalls).toBe(1);
    expect(ledger.markUnresolvedCalls).toBe(0);

    // The bucket is still admissible: an unresolved reservation would have
    // fenced it for the rest of the ledger's life, so a second free step on
    // the same subscription credential proves the rule did not overreach.
    const second = await harness.run(
      await makeStep(dir, { name: "hunter-resilience" }),
    );
    expect(second.status).toBe("ok");
    expect(second.reservations?.[0]?.state).toBe("settled");
  });

  // 5b.7 (threat matrix, mirrors 5a.4): argv/env invariance for the ledger too.
  test("buildStepArgv output is byte-identical with and without a spendLedger configured", async () => {
    const dir = await tempDir();
    const step = await makeStep(dir);
    const withoutLedger = buildStepArgv(step);

    new StepExecutionHarness({ spendLedger: new SpyLedger() });

    const withLedger = buildStepArgv(step);
    expect(withLedger).toEqual(withoutLedger);
  });

  // Backward compatibility: an unconfigured spendLedger reserves nothing —
  // the ledger-free PR5a shape must survive byte-for-byte.
  test("no spendLedger configured means no reservation is ever attempted, and StepResult.reservations stays absent", async () => {
    const dir = await tempDir();
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => capabilities(),
      execute: async () => okOutcome(),
      classifyFailure: () => undefined,
    };
    const harness = new StepExecutionHarness({ transport, spawnFn: fakeSpawn });
    const step = await makeStep(dir);

    const result = await harness.run(step);

    expect(result.status).toBe("ok");
    expect(result.reservations).toBeUndefined();
  });
});

// ---- D8: renderResult surfaces unresolved spend (5b.5 / 5b.6) ----

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const joined = (lines: string[]): string => stripAnsi(lines.join("\n"));

const telemetry: Telemetry = {
  index_ms: 0,
  index_mode: "sync",
  index_disk_mb: 0,
  wall_ms: 60_000,
  tokens_in: 1,
  tokens_out: 1,
  tokens_total: 2,
  cost_usd_est: 1.23,
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "F001",
  category: 5,
  path: "src/example.ts",
  line: 10,
  severity: "BLOCKER",
  evidence_class: "deterministic",
  refuter_verdict: "corroborated",
  causal_disposition: "introduced",
  claim: "example claim",
  proof_refs: ["src/example.ts:10"],
  hunter: "reliability",
  tier: "blocking",
  hops_used: 1,
  hop_trail: [],
  dedupe_key: "src/example.ts:10",
  ...over,
});

const doc = (over: Partial<FindingsDocument> = {}): FindingsDocument => ({
  schema_version: "1.0.0",
  pr: 6,
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  model: "sonnet",
  iteration: 0,
  parity_hunter_fired: false,
  run_status: "complete",
  telemetry,
  findings: [finding()],
  debug: { refuted: [] },
  ...over,
});

const resultInput = (over: Partial<ResultInput> = {}): ResultInput => ({
  doc: doc(),
  costUsd: 1.23,
  wallMs: 60_000,
  estimate: { low: 1.0, high: 2.0 },
  runDir: "/tmp/pr-hero-runs/pr-6-abc123",
  artifacts: ["report.md", "findings.json"],
  sessionFailed: false,
  styles: false,
  width: 96,
  ...over,
});

describe("PR5b — D8: renderResult surfaces unresolved spend", () => {
  // 5b.5 RED→GREEN
  test("an unresolved_remote reservation appears in renderResult's returned lines, not only in pipeline.json", () => {
    const text = joined(
      renderResult(
        resultInput({
          unresolved: [
            {
              step: "hunter-reliability",
              bucketId: "bucket-fenced",
              reservationId: "resv-1",
              knownUsd: 0.1,
            },
          ],
        }),
      ),
    );
    expect(text).toContain("bucket-fenced");
    expect(text).toContain("unresolved");
  });

  test("no unresolved reservations means no unresolved row at all", () => {
    const text = joined(renderResult(resultInput()));
    expect(text).not.toContain("unresolved");
  });

  // 5b.6 RED→GREEN
  test("the header's cost figure is marked as a floor (not a bare total) when unresolved is non-empty", () => {
    const clean = stripAnsi(renderResult(resultInput())[1] ?? "");
    const withUnresolved = stripAnsi(
      renderResult(
        resultInput({
          unresolved: [
            {
              step: "hunter-reliability",
              bucketId: "bucket-fenced",
              reservationId: "resv-1",
            },
          ],
        }),
      )[1] ?? "",
    );
    expect(clean).toContain("$1.23");
    expect(clean).not.toContain("≥$1.23");
    expect(withUnresolved).toContain("≥$1.23");
  });
});
