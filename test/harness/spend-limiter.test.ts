// D1-08 PR4 (§9.1): the transactional spend reservation ledger. These tests
// exercise `InMemorySpendLedger`, `settlementFromUsage`, `beginStep`/
// `nextCycle` directly, at the module level.
//
// 2026-09-02: this header used to add "no harness wiring yet (that is PR5b)",
// which was the same stale claim `spend-limiter.ts`'s own header carried —
// PR5b landed and `StepExecutionHarness` calls all four ledger methods. The
// module-level framing here is still correct, but as a SCOPE choice and not a
// statement about the harness: `test/harness/spend-wiring.test.ts` owns the
// harness-observable half, and every pure rule asserted here has a wiring arm
// there.

import { describe, expect, test } from "bun:test";
import type { RetryDisposition } from "../../src/execution/failure-policy";
import {
  beginStep,
  InMemorySpendLedger,
  nextCycle,
  type ReserveSpendInput,
  type SettlementDecision,
  SpendReservationConflictError,
  SpendReservationFencedError,
  settlementFromUsage,
} from "../../src/execution/spend-limiter";
import {
  normalizeInclusiveUsage,
  normalizePartialUsage,
  normalizeUnavailableUsage,
} from "../../src/execution/usage-normalized";

function reserveInput(
  overrides: Partial<ReserveSpendInput> = {},
): ReserveSpendInput {
  return {
    bucketId: "bucket-default",
    reservedUsd: 1,
    sessionId: "session-1",
    attempt: 1,
    ...overrides,
  };
}

describe("settlementFromUsage (coupling 1 producer)", () => {
  // 4.1 RED: completeness !== "complete" -> ALWAYS the unresolved arm.
  test("complete usage settles with its cash cost", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 1200,
      inputTotal: 100,
      outputTotal: 50,
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.42,
    });

    expect(settlementFromUsage(usage)).toEqual({
      kind: "settle",
      actualUsd: 0.42,
    });
  });

  test("complete usage with undefined cashCostUsd resolves to unresolved, never a fabricated zero settlement", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 1200,
      inputTotal: 100,
      outputTotal: 50,
      billingMode: "metered",
      costSource: "provider",
    });

    expect(settlementFromUsage(usage)).toEqual({
      kind: "unresolved",
      knownUsd: undefined,
    });
  });

  test("partial usage always resolves to unresolved, carrying whatever cash cost is known", () => {
    const usage = normalizePartialUsage({
      wallMs: 800,
      providerReportedTotal: 500,
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.1,
    });

    expect(settlementFromUsage(usage)).toEqual({
      kind: "unresolved",
      knownUsd: 0.1,
    });
  });

  test("unavailable usage resolves to unresolved with no known cost — never a fabricated zero settlement", () => {
    const usage = normalizeUnavailableUsage({ wallMs: 300 });

    expect(settlementFromUsage(usage)).toEqual({
      kind: "unresolved",
      knownUsd: undefined,
    });
  });
});

// 2026-09-02, the metered-zero rule. #133 taught the capability report that a
// `provider_api_token` route bills as METERED; this describe is the same
// under-reporting failure arriving through the other door — not a missing
// cost, but a present one that reads $0.
//
// The door: the OpenCode client reads the provider's own `cost` field
// (opencode-client.ts, `asNumber(info.cost)`), and `asNumber` returns 0 for 0
// rather than undefined. A provider OpenCode holds no price for, or a custom
// endpoint, reports `cost: 0` — which reaches here as a COMPLETE usage with a
// defined `cashCostUsd` and settles as a truthful-looking zero wearing the
// provider's badge.
//
// The discriminator is the credential's billing mode, not the number: zero
// cash cost is truthful for a SUBSCRIPTION credential and is not truthful for
// a metered one that produced output tokens. Both arms below are needed —
// either alone would also pass against a rule that simply refuses every zero,
// which would misfile every genuinely-free subscription attempt.
describe("settlementFromUsage: a metered zero is not a settlement", () => {
  test("a metered attempt reporting $0 with output tokens settles unresolved", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 1200,
      inputTotal: 100,
      outputTotal: 50,
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0,
    });

    // `knownUsd` is absent on purpose: the whole point is that 0 is NOT a
    // known cost here. Carrying it would relocate the same lie into the
    // unresolved arm, where renderResult would print "$0 known".
    expect(settlementFromUsage(usage)).toEqual({
      kind: "unresolved",
      knownUsd: undefined,
    });
  });

  test("a subscription attempt reporting $0 with output tokens still settles 0", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 1200,
      inputTotal: 100,
      outputTotal: 50,
      billingMode: "subscription",
      costSource: "provider",
      cashCostUsd: 0,
    });

    expect(settlementFromUsage(usage)).toEqual({
      kind: "settle",
      actualUsd: 0,
    });
  });

  test("a metered attempt that produced no output tokens still settles 0", () => {
    // The refusal-shaped case: a session that never reached the provider
    // (opencode-sdk.ts `noSessionUsage`) is a real, truthful $0 even on a
    // metered route. Gating on output tokens is what keeps it settleable.
    const usage = normalizeInclusiveUsage({
      wallMs: 40,
      inputTotal: 0,
      outputTotal: 0,
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0,
    });

    expect(settlementFromUsage(usage)).toEqual({
      kind: "settle",
      actualUsd: 0,
    });
  });

  test("a metered attempt with a real cost is untouched by the rule", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 1200,
      inputTotal: 100,
      outputTotal: 50,
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.42,
    });

    expect(settlementFromUsage(usage)).toEqual({
      kind: "settle",
      actualUsd: 0.42,
    });
  });

  test("a transport that reports only outputVisible is not exempt from the rule", () => {
    // `outputKnown` is what the OpenCode transport populates, but the rule
    // must not be dodgeable by a transport that fills the leaves and skips
    // the rollup — otherwise the exemption is decided by which fields a
    // transport happens to set rather than by whether tokens were produced.
    expect(
      settlementFromUsage({
        wallMs: 1200,
        tokens: { outputVisible: 50 },
        completeness: "complete",
        billingMode: "metered",
        costSource: "provider",
        cashCostUsd: 0,
      }),
    ).toEqual({ kind: "unresolved", knownUsd: undefined });
  });

  test("an unknown billing mode reporting $0 is left to the capability gate", () => {
    // `billingMode: "unknown"` is already a BLOCKING preflight result
    // (design doc line 461, enforced by `cashCostAccountingValid`), so no
    // such route reaches an attempt. Widening this rule to cover it would
    // add a second, weaker enforcement point for a fact the gate already
    // refuses outright.
    expect(
      settlementFromUsage({
        wallMs: 1200,
        tokens: { outputVisible: 50, outputKnown: 50 },
        completeness: "complete",
        billingMode: "unknown",
        costSource: "provider",
        cashCostUsd: 0,
      }),
    ).toEqual({ kind: "settle", actualUsd: 0 });
  });
});

describe("settle() type gate (coupling 1 consumer)", () => {
  // 4.2 RED: settle()'s second argument is
  // Extract<SettlementDecision, {kind:"settle"}> — a raw number must fail
  // tsc, not be caught by a runtime guard. This is a compile-time proof:
  // `bun run typecheck` fails if the `@ts-expect-error` below stops being
  // necessary (i.e. if the signature is ever loosened to accept a number).
  test("a bare number is not assignable to settle's decision parameter", () => {
    type SettleDecisionArg = Parameters<InMemorySpendLedger["settle"]>[1];
    // @ts-expect-error — a raw number is not assignable to
    // Extract<SettlementDecision, {kind:"settle"}>; this must stay a type
    // error, proving coupling 1 is type-unreachable rather than test-asserted.
    const invalid: SettleDecisionArg = 5;
    expect(invalid as unknown as number).toBe(5);
  });

  test("the settle arm is the only variant settle() accepts at the value level too", async () => {
    const ledger = new InMemorySpendLedger();
    const token = beginStep();
    const reservation = await ledger.reserve(reserveInput(), token);
    const decision: Extract<SettlementDecision, { kind: "settle" }> = {
      kind: "settle",
      actualUsd: 3.14,
    };

    await ledger.settle(reservation.reservationId, decision, "idem-settle-1");

    const settled = await ledger.getReservation(reservation.reservationId);
    expect(settled?.state).toBe("settled");
    expect(settled?.settledUsd).toBe(3.14);
  });
});

describe("ReserveToken coupling (coupling 2)", () => {
  // 4.3 RED: reserve() requires a ReserveToken; nextCycle() on a terminal
  // disposition returns undefined, so a terminal attempt cannot construct
  // one to open a new cycle.
  test("beginStep() yields a token that opens the first reservation of a step", async () => {
    const ledger = new InMemorySpendLedger();
    const token = beginStep();

    const reservation = await ledger.reserve(reserveInput(), token);

    expect(reservation.state).toBe("reserved");
  });

  test("nextCycle() on a terminal disposition returns undefined", () => {
    const terminal: RetryDisposition = { action: "terminal" };

    expect(nextCycle(terminal)).toBeUndefined();
  });

  test("nextCycle() on a non-terminal disposition returns a token that opens a new reservation", async () => {
    const retryNow: RetryDisposition = {
      action: "retry_now",
      budget: "transient",
    };
    const token = nextCycle(retryNow);
    expect(token).toBeDefined();

    const ledger = new InMemorySpendLedger();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const reservation = await ledger.reserve(reserveInput(), token!);

    expect(reservation.state).toBe("reserved");
  });

  test("reserve()'s token parameter is mandatory at compile time — undefined does not widen into it", () => {
    type ReserveTokenArg = Parameters<InMemorySpendLedger["reserve"]>[1];
    // @ts-expect-error — a terminal disposition's `undefined` (from
    // nextCycle) cannot be assigned where a ReserveToken is required; this
    // must stay a type error so a terminal disposition structurally cannot
    // open a new reserve+admit cycle.
    const invalid: ReserveTokenArg = undefined;
    expect(invalid).toBeUndefined();
  });
});

describe("CAS idempotency", () => {
  // 4.4 RED: double-settle/double-release on one reservationId+idempotencyKey
  // is a no-op.
  test("calling settle twice with the same idempotency key does not re-apply", async () => {
    const ledger = new InMemorySpendLedger();
    const token = beginStep();
    const reservation = await ledger.reserve(reserveInput(), token);
    const decision: Extract<SettlementDecision, { kind: "settle" }> = {
      kind: "settle",
      actualUsd: 2.5,
    };

    await ledger.settle(reservation.reservationId, decision, "idem-repeat");
    await ledger.settle(reservation.reservationId, decision, "idem-repeat");

    const settled = await ledger.getReservation(reservation.reservationId);
    expect(settled?.state).toBe("settled");
    expect(settled?.settledUsd).toBe(2.5);
  });

  test("calling releaseUnstarted twice with the same idempotency key does not throw", async () => {
    const ledger = new InMemorySpendLedger();
    const token = beginStep();
    const reservation = await ledger.reserve(reserveInput(), token);

    await ledger.releaseUnstarted(reservation.reservationId, "idem-release");
    await ledger.releaseUnstarted(reservation.reservationId, "idem-release");

    const released = await ledger.getReservation(reservation.reservationId);
    expect(released?.state).toBe("released_unstarted");
  });

  test("a second settle under a DIFFERENT idempotency key on an already-terminal reservation is a conflict, not a silent overwrite", async () => {
    const ledger = new InMemorySpendLedger();
    const token = beginStep();
    const reservation = await ledger.reserve(reserveInput(), token);

    await ledger.settle(
      reservation.reservationId,
      { kind: "settle", actualUsd: 1 },
      "idem-first",
    );

    await expect(
      ledger.settle(
        reservation.reservationId,
        { kind: "settle", actualUsd: 999 },
        "idem-second",
      ),
    ).rejects.toBeInstanceOf(SpendReservationConflictError);

    // The conflicting call must not have overwritten the settled amount.
    const settled = await ledger.getReservation(reservation.reservationId);
    expect(settled?.settledUsd).toBe(1);
  });

  test("the same idempotency key with a different terminal operation is a conflict, not a silent overwrite", async () => {
    const ledger = new InMemorySpendLedger();
    const token = beginStep();
    const reservation = await ledger.reserve(reserveInput(), token);

    await ledger.settle(
      reservation.reservationId,
      { kind: "settle", actualUsd: 1 },
      "idem-shared",
    );

    await expect(
      ledger.releaseUnstarted(reservation.reservationId, "idem-shared"),
    ).rejects.toBeInstanceOf(SpendReservationConflictError);

    const settled = await ledger.getReservation(reservation.reservationId);
    expect(settled?.state).toBe("settled");
    expect(settled?.settledUsd).toBe(1);
  });
});

describe("unresolved_remote fences the bucket", () => {
  // 4.5 RED: an unresolved_remote reservation in a bucket blocks any new
  // reservation in that bucket for the rest of the run.
  test("once a bucket has an unresolved_remote reservation, a new reservation in that bucket is refused before it runs", async () => {
    const ledger = new InMemorySpendLedger();
    const first = await ledger.reserve(
      reserveInput({ bucketId: "bucket-fenced" }),
      beginStep(),
    );
    await ledger.markUnresolvedRemote(
      first.reservationId,
      0.5,
      "idem-unresolved",
    );

    await expect(
      ledger.reserve(
        reserveInput({ bucketId: "bucket-fenced", sessionId: "session-2" }),
        beginStep(),
      ),
    ).rejects.toBeInstanceOf(SpendReservationFencedError);
  });

  test("a different bucket is unaffected by another bucket's unresolved_remote fence", async () => {
    const ledger = new InMemorySpendLedger();
    const first = await ledger.reserve(
      reserveInput({ bucketId: "bucket-fenced-2" }),
      beginStep(),
    );
    await ledger.markUnresolvedRemote(first.reservationId, undefined, "idem-2");

    const other = await ledger.reserve(
      reserveInput({ bucketId: "bucket-healthy" }),
      beginStep(),
    );

    expect(other.state).toBe("reserved");
  });
});
