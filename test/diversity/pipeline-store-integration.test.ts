import { describe, expect, test } from "bun:test";
import {
  appendAttempt,
  emptyDiversityLedger,
  summarizeDiversityAccounting,
} from "../../src/diversity/accounting";
import { buildDiversityPlan } from "../../src/diversity/identity";
import { normalizeInclusiveUsage } from "../../src/execution/usage-normalized";
import { validateReviewSpec } from "../../src/spec";

describe("pipeline and store diversity integration", () => {
  test("assembles partial failure evidence without treating absence as agreement", () => {
    const spec = validateReviewSpec({
      multiModelDiversity: {
        enabled: true,
        armId: "arm",
        maxLegs: 2,
        cashCapUsd: 10,
      },
      agents: [
        {
          key: "reliability",
          file: "deep-review-reliability.md",
          role: "hunter",
          models: ["sonnet", "opus"],
        },
        { key: "refuter", file: "review-refuter.md", role: "refuter" },
      ],
    });
    const plan = buildDiversityPlan({
      spec,
      c2SchemaVersion: "1.1.0",
    });
    let ledger = emptyDiversityLedger();
    for (const leg of plan.legs) {
      ledger = appendAttempt(ledger, {
        attemptId: `${leg.legId}-1`,
        legId: leg.legId,
        armId: plan.armId,
        specialty: leg.specialty,
        replicate: 1,
        attempt: 1,
        status: leg.legId === plan.legs[0]?.legId ? "failed" : "completed",
        usage: normalizeInclusiveUsage({
          wallMs: 1,
          inputTotal: 1,
          outputTotal: 1,
          billingMode: "metered",
          costSource: "provider",
          cashCostUsd: 0.1,
          notionalCostUsd: 0.05,
        }),
      });
    }
    const totals = summarizeDiversityAccounting(ledger);
    expect(totals.failureCount).toBe(1);
    expect(totals.attemptCount).toBe(2);
    expect(totals.observationCount).toBe(0);
  });
});
