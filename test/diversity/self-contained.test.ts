import { describe, expect, test } from "bun:test";
import { assertDiversityGraphSelfContained } from "../../src/diversity/self-contained";

describe("diversity self-contained graph", () => {
  test("D3 modules have no sibling lab imports or absolute lab paths", () => {
    const report = assertDiversityGraphSelfContained();
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });
});
