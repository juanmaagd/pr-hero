import { describe, expect, test } from "bun:test";
import type { Tier } from "../src/findings";
import {
  DEFAULT_CI_ADVISORY_WEIGHT,
  DEFAULT_CI_BLOCKING_WEIGHT,
  DEFAULT_CI_REREVIEW_MIN_SCORE,
  evaluateCiReviewAdmission,
  parsePostedSummaryTierCounts,
  priorTierScore,
  resolveCiReviewPolicy,
  stateReviewCount,
} from "../src/ci-review-admission";
import { stateFinding } from "../src/rereview-state";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const DEFAULT_POLICY = resolveCiReviewPolicy({});

function finding(tier: Tier) {
  return stateFinding({
    id: "R001",
    sev: tier === "blocking" ? "CRITICAL" : "WARNING",
    tier,
    channel: "inline",
    locs: ["src/a.ts:1"],
    claim: "x",
  });
}

describe("priorTierScore", () => {
  test("2 advisory → score 2", () => {
    expect(
      priorTierScore(
        [finding("advisory"), finding("advisory")],
        DEFAULT_POLICY,
      ).score,
    ).toBe(2);
  });

  test("1 advisory + 1 blocking → score 3", () => {
    expect(
      priorTierScore(
        [finding("advisory"), finding("blocking")],
        DEFAULT_POLICY,
      ).score,
    ).toBe(3);
  });

  test("2 advisory + 1 blocking → score 4", () => {
    expect(
      priorTierScore(
        [
          finding("advisory"),
          finding("advisory"),
          finding("blocking"),
        ],
        DEFAULT_POLICY,
      ).score,
    ).toBe(4);
  });
});

describe("parsePostedSummaryTierCounts", () => {
  test("reads the summary headline counts", () => {
    expect(
      parsePostedSummaryTierCounts(
        `<!-- pr-hero-report head=${HEAD_A} -->\n🔴 1 critical · 🟡 2 warning — head`,
      ),
    ).toEqual({ blocking: 1, advisory: 2 });
  });
});

describe("evaluateCiReviewAdmission", () => {
  test("first review always runs", () => {
    expect(
      evaluateCiReviewAdmission({
        currentHead: HEAD_A,
        summaryHead: null,
        summaryBody: null,
        markerSeen: false,
        reviewCount: 0,
        state: null,
        policy: DEFAULT_POLICY,
      }),
    ).toEqual({ action: "run" });
  });

  test("same head skips", () => {
    const verdict = evaluateCiReviewAdmission({
      currentHead: HEAD_A,
      summaryHead: HEAD_A,
      summaryBody: `🔴 2 critical · 🟡 0 warning`,
      markerSeen: true,
      reviewCount: 1,
      state: null,
      policy: DEFAULT_POLICY,
    });
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("same-head");
    }
  });

  test("2 warnings on prior review skips re-review", () => {
    const verdict = evaluateCiReviewAdmission({
      currentHead: HEAD_B,
      summaryHead: HEAD_A,
      summaryBody: `🔴 0 critical · 🟡 2 warning`,
      markerSeen: true,
      reviewCount: 1,
      state: null,
      policy: DEFAULT_POLICY,
    });
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("below-threshold");
      expect(verdict.prior.score).toBe(2);
    }
  });

  test("2 warnings + 1 blocking triggers re-review", () => {
    expect(
      evaluateCiReviewAdmission({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        summaryBody: null,
        markerSeen: true,
        reviewCount: 1,
        state: {
          headSha: HEAD_A,
          findings: [
            finding("advisory"),
            finding("advisory"),
            finding("blocking"),
          ],
        },
        policy: DEFAULT_POLICY,
      }),
    ).toEqual({ action: "run" });
  });

  test("max reviews blocks a third run", () => {
    const verdict = evaluateCiReviewAdmission({
      currentHead: HEAD_B,
      summaryHead: HEAD_A,
      summaryBody: null,
      markerSeen: true,
      reviewCount: 2,
      state: {
        headSha: HEAD_A,
        findings: [finding("blocking"), finding("blocking")],
        reviews: 2,
      },
      policy: DEFAULT_POLICY,
    });
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("max-reviews");
    }
  });
});

describe("stateReviewCount", () => {
  test("reads reviews from state when present", () => {
    expect(
      stateReviewCount(
        { headSha: HEAD_A, findings: [], reviews: 2 },
        true,
      ),
    ).toBe(2);
  });

  test("falls back to 1 when a marker exists but state has no counter", () => {
    expect(stateReviewCount(null, true)).toBe(1);
  });
});

describe("resolveCiReviewPolicy defaults", () => {
  test("matches the agreed floor", () => {
    expect(resolveCiReviewPolicy({})).toEqual({
      maxReviews: 2,
      rereviewMinScore: DEFAULT_CI_REREVIEW_MIN_SCORE,
      blockingWeight: DEFAULT_CI_BLOCKING_WEIGHT,
      advisoryWeight: DEFAULT_CI_ADVISORY_WEIGHT,
    });
  });
});
