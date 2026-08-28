// D1-08 PR4 (§9.1): the transactional spend reservation ledger. Pure/offline
// — no harness wiring yet (that is PR5b, per the design's own tripwire
// table: "PR4 | None — pure by design"). These tests exercise
// `InMemorySpendLedger`, `settlementFromUsage`, `beginStep`/`nextCycle`
// directly, at the module level.

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
