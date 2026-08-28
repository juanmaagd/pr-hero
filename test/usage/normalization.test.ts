import { describe, expect, test } from "bun:test";
import {
  applyUsageUpdate,
  normalizeInclusiveUsage,
  normalizePartialUsage,
  projectLegacyUsage,
  sumNormalizedUsage,
  UsageModeMismatchError,
} from "../../src/execution/usage-normalized";

describe("normalizeInclusiveUsage — proven inclusion split (§8 line 455)", () => {
  test("splits a proven-inclusive total into disjoint cache leaves plus a non-negative residual", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 4200,
      inputTotal: 100,
      inputCacheRead: 30,
      inputCacheWrite: 10,
      outputTotal: 50,
      outputReasoning: 20,
      billingMode: "metered",
      costSource: "provider",
    });

    expect(result.tokens.inputCacheRead).toBe(30);
    expect(result.tokens.inputCacheWrite).toBe(10);
    expect(result.tokens.inputOther).toBe(60);
    expect(result.tokens.outputReasoning).toBe(20);
    expect(result.tokens.outputOther).toBe(30);
    expect(result.completeness).toBe("complete");
  });

  test("triangulation: a different provider's shape (cache-read only, no cache-write) still splits correctly", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 0,
      inputTotal: 1000,
      inputCacheRead: 400,
      outputTotal: 200,
      billingMode: "metered",
      costSource: "provider",
    });

    expect(result.tokens.inputCacheRead).toBe(400);
    expect(result.tokens.inputCacheWrite).toBeUndefined();
    expect(result.tokens.inputOther).toBe(600);
    expect(result.tokens.outputReasoning).toBeUndefined();
    expect(result.tokens.outputOther).toBe(200);
  });

  test("never adds the cache detail atop the inclusive total", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 0,
      inputTotal: 100,
      inputCacheRead: 40,
      outputTotal: 0,
      billingMode: "metered",
      costSource: "provider",
    });

    const leafSum =
      (result.tokens.inputCacheRead ?? 0) + (result.tokens.inputOther ?? 0);
    expect(leafSum).toBe(100);
    expect(leafSum).not.toBe(140);
  });

  test("clamps the residual to non-negative even when reported detail exceeds the total", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 0,
      inputTotal: 10,
      inputCacheRead: 15,
      outputTotal: 0,
      billingMode: "metered",
      costSource: "provider",
    });

    expect(result.tokens.inputOther).toBe(0);
  });
});

describe("normalizePartialUsage — unproven inclusion (§8 line 457)", () => {
  test("keeps providerReportedTotal and marks completeness partial with no invented split", () => {
    const result = normalizePartialUsage({
      wallMs: 500,
      providerReportedTotal: 1234,
      billingMode: "metered",
      costSource: "provider",
    });

    expect(result.completeness).toBe("partial");
    expect(result.tokens.providerReportedTotal).toBe(1234);
    expect(result.tokens.inputOther).toBeUndefined();
    expect(result.tokens.outputOther).toBeUndefined();
    expect(result.tokens.inputKnown).toBeUndefined();
    expect(result.tokens.outputKnown).toBeUndefined();
  });

  test("triangulation: a different total still comes through untouched, never split", () => {
    const result = normalizePartialUsage({
      wallMs: 0,
      providerReportedTotal: 42,
      billingMode: "subscription",
      costSource: "subscription",
    });

    expect(result.tokens.providerReportedTotal).toBe(42);
    expect(result.completeness).toBe("partial");
  });
});

describe("cash and notional cost stay separate", () => {
  test("a subscription attempt keeps cashCostUsd at 0 while notionalCostUsd is nonzero, untouched", () => {
    const result = normalizeInclusiveUsage({
      wallMs: 1000,
      inputTotal: 100,
      outputTotal: 50,
      billingMode: "subscription",
      costSource: "subscription",
      cashCostUsd: 0,
      notionalCostUsd: 3.5,
    });

    expect(result.cashCostUsd).toBe(0);
    expect(result.notionalCostUsd).toBe(3.5);
  });

  test("sumNormalizedUsage accumulates cash and notional independently, never crossing", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 100,
      inputTotal: 10,
      outputTotal: 10,
      billingMode: "subscription",
      costSource: "subscription",
      cashCostUsd: 0,
      notionalCostUsd: 1,
    });
    const b = normalizeInclusiveUsage({
      wallMs: 100,
      inputTotal: 10,
      outputTotal: 10,
      billingMode: "subscription",
      costSource: "subscription",
      cashCostUsd: 0,
      notionalCostUsd: 2,
    });

    const total = sumNormalizedUsage(a, b);
    expect(total.cashCostUsd).toBe(0);
    expect(total.notionalCostUsd).toBe(3);
  });

  test("projectLegacyUsage's cost_usd_est reflects only cashCostUsd, never notionalCostUsd", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 100,
      inputTotal: 10,
      outputTotal: 10,
      billingMode: "subscription",
      costSource: "subscription",
      cashCostUsd: 0,
      notionalCostUsd: 99,
    });

    const legacy = projectLegacyUsage(usage);
    expect(legacy.cost_usd_est).toBe(0);
  });
});

describe("sumNormalizedUsage — accumulation across attempts", () => {
  test("keeps billingMode and costSource when both attempts agree", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
      costSource: "provider",
    });
    const b = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
      costSource: "provider",
    });

    const total = sumNormalizedUsage(a, b);
    expect(total.billingMode).toBe("metered");
    expect(total.costSource).toBe("provider");
  });

  test("falls back to unknown when attempts disagree rather than guessing", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
      costSource: "provider",
    });
    const b = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "subscription",
      costSource: "subscription",
    });

    const total = sumNormalizedUsage(a, b);
    expect(total.billingMode).toBe("unknown");
    expect(total.costSource).toBe("unknown");
  });

  test("completeness degrades to the worst of the two attempts", () => {
    const complete = normalizeInclusiveUsage({
      wallMs: 1,
      inputTotal: 1,
      outputTotal: 1,
      billingMode: "metered",
      costSource: "provider",
    });
    const partial = normalizePartialUsage({
      wallMs: 1,
      providerReportedTotal: 5,
      billingMode: "metered",
      costSource: "provider",
    });

    const total = sumNormalizedUsage(complete, partial);
    expect(total.completeness).toBe("partial");
  });

  test("token leaves and wall time sum across attempts", () => {
    const a = normalizeInclusiveUsage({
      wallMs: 100,
      inputTotal: 10,
      inputCacheRead: 4,
      outputTotal: 5,
      billingMode: "metered",
      costSource: "provider",
    });
    const b = normalizeInclusiveUsage({
      wallMs: 200,
      inputTotal: 20,
      inputCacheRead: 8,
      outputTotal: 7,
      billingMode: "metered",
      costSource: "provider",
    });

    const total = sumNormalizedUsage(a, b);
    expect(total.wallMs).toBe(300);
    expect(total.tokens.inputCacheRead).toBe(12);
    expect(total.tokens.inputKnown).toBe(30);
    expect(total.tokens.outputKnown).toBe(12);
  });
});

describe("applyUsageUpdate — snapshot/delta mode guard (§4.1 line 195)", () => {
  test("delta mode accumulates increments across updates", () => {
    let state = applyUsageUpdate(undefined, "delta", { inputUncached: 10 });
    state = applyUsageUpdate(state, "delta", {
      inputUncached: 5,
      outputVisible: 2,
    });

    expect(state.tokens.inputUncached).toBe(15);
    expect(state.tokens.outputVisible).toBe(2);
  });

  test("snapshot mode replaces rather than accumulates", () => {
    let state = applyUsageUpdate(undefined, "snapshot", { inputUncached: 10 });
    state = applyUsageUpdate(state, "snapshot", { inputUncached: 7 });

    expect(state.tokens.inputUncached).toBe(7);
  });

  test("a delta update after a snapshot start is rejected", () => {
    const state = applyUsageUpdate(undefined, "snapshot", {
      inputUncached: 10,
    });

    expect(() =>
      applyUsageUpdate(state, "delta", { inputUncached: 1 }),
    ).toThrow(UsageModeMismatchError);
  });

  test("a snapshot update after a delta start is rejected", () => {
    const state = applyUsageUpdate(undefined, "delta", { inputUncached: 10 });

    expect(() =>
      applyUsageUpdate(state, "snapshot", { inputUncached: 1 }),
    ).toThrow(UsageModeMismatchError);
  });
});

describe("projectLegacyUsage — exact legacy shape at the runPipeline boundary", () => {
  test("returns exactly the legacy field names/values for a complete normalized usage", () => {
    const usage = normalizeInclusiveUsage({
      wallMs: 4200,
      inputTotal: 120,
      inputCacheRead: 40,
      outputTotal: 60,
      outputReasoning: 10,
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 0.42,
    });

    const legacy = projectLegacyUsage(usage);
    expect(legacy).toEqual({
      wall_ms: 4200,
      tokens_in: 120,
      tokens_out: 60,
      tokens_total: 180,
      cost_usd_est: 0.42,
    });
  });

  test("a partial usage preserves the total while leaving the in/out split at zero, never invented", () => {
    const usage = normalizePartialUsage({
      wallMs: 100,
      providerReportedTotal: 999,
      billingMode: "metered",
      costSource: "provider",
      cashCostUsd: 1.1,
    });

    const legacy = projectLegacyUsage(usage);
    expect(legacy).toEqual({
      wall_ms: 100,
      tokens_in: 0,
      tokens_out: 0,
      tokens_total: 999,
      cost_usd_est: 1.1,
    });
  });
});
