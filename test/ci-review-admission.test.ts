import { describe, expect, test } from "bun:test";
import type { Tier } from "../src/findings";
import {
  DEFAULT_CI_ADVISORY_WEIGHT,
  DEFAULT_CI_BLOCKING_WEIGHT,
  DEFAULT_CI_REREVIEW_MIN_SCORE,
  evaluateCiReviewAdmission,
  parseCiAdmissionBlock,
  priorTierScore,
  renderCiAdmissionBlock,
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

function admissionBody(
  counts: { blocking: number; advisory: number },
  reviews = 1,
): string {
  return (
    `<!-- pr-hero-report head=${HEAD_A} -->\n` +
    renderCiAdmissionBlock(HEAD_A, counts, reviews)
  );
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

describe("parseCiAdmissionBlock", () => {
  test("reads tier counts from the admission marker", () => {
    expect(parseCiAdmissionBlock(admissionBody({ blocking: 1, advisory: 2 }))).toEqual({
      headSha: HEAD_A,
      blocking: 1,
      advisory: 2,
      reviews: 1,
    });
  });

  test("ignores severity headline counts", () => {
    expect(
      parseCiAdmissionBlock(
        `<!-- pr-hero-report head=${HEAD_A} -->\n🔴 9 critical · 🟡 0 warning`,
      ),
    ).toBeNull();
  });
});

describe("evaluateCiReviewAdmission", () => {
  test("first review always runs", () => {
    expect(
      evaluateCiReviewAdmission({
        currentHead: HEAD_A,
        summaryHead: null,
        markerSeen: false,
        reviewCount: 0,
        state: null,
        admission: null,
        policy: DEFAULT_POLICY,
      }),
    ).toEqual({ action: "run" });
  });

  test("same head skips", () => {
    const admission = parseCiAdmissionBlock(
      admissionBody({ blocking: 2, advisory: 0 }),
    );
    const verdict = evaluateCiReviewAdmission({
      currentHead: HEAD_A,
      summaryHead: HEAD_A,
      markerSeen: true,
      reviewCount: 1,
      state: null,
      admission,
      policy: DEFAULT_POLICY,
    });
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("same-head");
    }
  });

  test("2 advisory-tier findings on prior review skips re-review", () => {
    const admission = parseCiAdmissionBlock(
      admissionBody({ blocking: 0, advisory: 2 }),
    );
    const verdict = evaluateCiReviewAdmission({
      currentHead: HEAD_B,
      summaryHead: HEAD_A,
      markerSeen: true,
      reviewCount: 1,
      state: null,
      admission,
      policy: DEFAULT_POLICY,
    });
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("below-threshold");
      expect(verdict.prior.score).toBe(2);
    }
  });

  test("severity headline alone does not inflate the score", () => {
    const verdict = evaluateCiReviewAdmission({
      currentHead: HEAD_B,
      summaryHead: HEAD_A,
      markerSeen: true,
      reviewCount: 1,
      state: null,
      admission: null,
      policy: DEFAULT_POLICY,
    });
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("below-threshold");
      expect(verdict.prior.score).toBe(0);
    }
  });

  test("2 advisory + 1 blocking triggers re-review", () => {
    expect(
      evaluateCiReviewAdmission({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
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
        admission: null,
        policy: DEFAULT_POLICY,
      }),
    ).toEqual({ action: "run" });
  });

  test("max reviews blocks a third run", () => {
    const verdict = evaluateCiReviewAdmission({
      currentHead: HEAD_B,
      summaryHead: HEAD_A,
      markerSeen: true,
      reviewCount: 2,
      state: {
        headSha: HEAD_A,
        findings: [finding("blocking"), finding("blocking")],
        reviews: 2,
      },
      admission: null,
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

  test("reads reviews from admission block when state has no counter", () => {
    const admission = parseCiAdmissionBlock(
      admissionBody({ blocking: 0, advisory: 1 }, 2),
    );
    expect(stateReviewCount(null, true, admission)).toBe(2);
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
