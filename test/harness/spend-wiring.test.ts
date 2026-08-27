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
  test("a SpendLedger that refuses reserve() prevents the transport from ever being invoked", async () => {
    const dir = await tempDir();
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
    const refusingLedger: SpendLedger = {
      reserve: async (input) => {
        throw new SpendReservationFencedError(input.bucketId);
      },
      settle: async () => {},
      releaseUnstarted: async () => {},
      markUnresolvedRemote: async () => {},
    };
    const harness = new StepExecutionHarness({
      transport,
      spendLedger: refusingLedger,
      spawnFn: fakeSpawn,
    });
    const step = await makeStep(dir);

    await expect(harness.run(step)).rejects.toBeInstanceOf(
      SpendReservationFencedError,
    );
    expect(transportCalls).toBe(0);
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
