import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  recordPromotion,
  requiresExplicitLiveAuthorization,
  scoreBenchmarkRuns,
  validateBenchmarkPlan,
} from "../../src/diversity/benchmark";

const planPath = path.join(
  import.meta.dir,
  "../../docs/benchmarks/d3-musive-plan.json",
);

describe("diversity benchmark", () => {
  test("validates frozen plan with R>=3 and interleaving", () => {
    const plan = validateBenchmarkPlan(
      JSON.parse(readFileSync(planPath, "utf8")),
    );
    expect(plan.interleaved).toBe(true);
    expect(plan.treatmentArm.replicates).toBeGreaterThanOrEqual(3);
  });

  test("excludes invalid runs from promotion metrics", () => {
    const report = scoreBenchmarkRuns([
      {
        runId: "r1",
        armId: "diversity",
        valid: false,
        cashCostUsd: 5,
        notionalCostUsd: 4,
        uniqueTruePositives: 2,
        recall: 1,
        cleanPrRestraint: 1,
        blindSpots: 0,
      },
      {
        runId: "r2",
        armId: "diversity",
        valid: true,
        cashCostUsd: 2,
        notionalCostUsd: 1,
        uniqueTruePositives: 1,
        recall: 0.5,
        cleanPrRestraint: 1,
        blindSpots: 1,
      },
    ]);
    expect(report.invalidRuns).toBe(1);
    expect(report.validRuns).toBe(1);
    expect(report.cashCostPerUniqueTp).toBe(2);
    expect(report.blindSpots).toBe(1);
  });

  test("requires separate live authorization and explicit promotion", () => {
    expect(requiresExplicitLiveAuthorization()).toBe(true);
    expect(() => recordPromotion({ approved: false, scope: "none" })).toThrow();
    expect(recordPromotion({ approved: true, scope: "reliability" })).toEqual({
      approved: true,
      scope: "reliability",
    });
  });
});
