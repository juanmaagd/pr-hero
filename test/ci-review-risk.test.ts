import { describe, expect, test } from "bun:test";
import {
  CI_RISK_POLICY_VERSION,
  classifyChangedPaths,
  deltaRiskTriggersReview,
} from "../src/ci-review-risk";

describe("classifyChangedPaths", () => {
  test("docs-only delta is low risk", () => {
    const assessment = classifyChangedPaths([
      "docs/guide.md",
      "README.md",
      "test/ci-review-risk.test.ts",
    ]);
    expect(assessment).toEqual({
      version: CI_RISK_POLICY_VERSION,
      class: "low",
      reason: "all changed paths match the low-risk allowlist",
      changedPaths: [
        "README.md",
        "docs/guide.md",
        "test/ci-review-risk.test.ts",
      ],
      highRiskPaths: [],
      lowRiskPaths: [
        "README.md",
        "docs/guide.md",
        "test/ci-review-risk.test.ts",
      ],
    });
    expect(deltaRiskTriggersReview(assessment)).toBe(false);
  });

  test("src change is high risk", () => {
    const assessment = classifyChangedPaths(["src/pipeline.ts"]);
    expect(assessment.class).toBe("high");
    expect(assessment.highRiskPaths).toEqual(["src/pipeline.ts"]);
    expect(assessment.lowRiskPaths).toEqual([]);
    expect(deltaRiskTriggersReview(assessment)).toBe(true);
  });

  test("empty path list is unknown", () => {
    const assessment = classifyChangedPaths([]);
    expect(assessment).toEqual({
      version: CI_RISK_POLICY_VERSION,
      class: "unknown",
      reason: "no changed paths in delta metadata",
      changedPaths: [],
      highRiskPaths: [],
      lowRiskPaths: [],
    });
    expect(deltaRiskTriggersReview(assessment)).toBe(true);
  });

  test("deleted file is high risk when compare status is provided", () => {
    const assessment = classifyChangedPaths(
      ["docs/old-guide.md"],
      [{ path: "docs/old-guide.md", status: "removed" }],
    );
    expect(assessment.class).toBe("high");
    expect(assessment.highRiskPaths).toEqual(["docs/old-guide.md"]);
    expect(deltaRiskTriggersReview(assessment)).toBe(true);
  });

  test("mixed docs and src paths is unknown", () => {
    const assessment = classifyChangedPaths([
      "docs/guide.md",
      "src/pipeline.ts",
    ]);
    expect(assessment.class).toBe("unknown");
    expect(assessment.highRiskPaths).toEqual(["src/pipeline.ts"]);
    expect(assessment.lowRiskPaths).toEqual(["docs/guide.md"]);
    expect(deltaRiskTriggersReview(assessment)).toBe(true);
  });
});
