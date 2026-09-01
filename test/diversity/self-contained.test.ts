import { describe, expect, test } from "bun:test";
import path from "node:path";
import { assertDiversityGraphSelfContained } from "../../src/diversity/self-contained";

// The root is supplied HERE, from the test's own location, because this is a
// source-tree lint: test/ is outside the src/** glob that forbids deriving a
// filesystem path from import.meta, and a test always runs from a checkout.
const DIVERSITY_DIR = path.resolve(import.meta.dir, "../../src/diversity");

describe("diversity self-contained graph", () => {
  test("D3 modules have no sibling lab imports or absolute lab paths", () => {
    const report = assertDiversityGraphSelfContained(DIVERSITY_DIR);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });
});
