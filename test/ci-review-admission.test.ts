import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CI_ADVISORY_WEIGHT,
  DEFAULT_CI_BLOCKING_WEIGHT,
  DEFAULT_CI_REREVIEW_MIN_SCORE,
  evaluateCiReviewAdmission,
  parseCiAdmissionBlock,
  parseFindingCommentTier,
  priorScoreForAdmission,
  priorTierScore,
  renderCiAdmissionBlock,
  resolveCiReviewPolicy,
  scanPostedFindingTiers,
  stateReviewCount,
} from "../src/ci-review-admission";
import type { Tier } from "../src/findings";
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

function postedFindingComment(input: {
  head: string;
  tier: Tier;
  path?: string;
  line?: number;
  c?: string;
}): string {
  const emoji = input.tier === "blocking" ? "🔴" : "🟡";
  const severity = input.tier === "blocking" ? "CRITICAL" : "WARNING";
  const path = encodeURIComponent(input.path ?? "src/ci-review-admission.ts");
  const line = input.line ?? 121;
  const c = input.c ?? "abcd1234abcd";
  return (
    `<!-- pr-hero-finding path=${path} line=${line} head=${input.head} c=${c} -->\n\n` +
    `${emoji} ${input.tier} · ${severity} · introduced · reliability\n\n` +
    "claim text"
  );
}

describe("priorTierScore", () => {
  test("2 advisory → score 2", () => {
    expect(
      priorTierScore([finding("advisory"), finding("advisory")], DEFAULT_POLICY)
        .score,
    ).toBe(2);
  });

  test("1 advisory + 1 blocking → score 3", () => {
    expect(
      priorTierScore([finding("advisory"), finding("blocking")], DEFAULT_POLICY)
        .score,
    ).toBe(3);
  });

  test("2 advisory + 1 blocking → score 4", () => {
    expect(
      priorTierScore(
        [finding("advisory"), finding("advisory"), finding("blocking")],
        DEFAULT_POLICY,
      ).score,
    ).toBe(4);
  });
});

describe("parseFindingCommentTier", () => {
  test("reads blocking tier from the posted header line", () => {
    expect(
      parseFindingCommentTier(
        postedFindingComment({ head: HEAD_A, tier: "blocking" }),
      ),
    ).toBe("blocking");
  });

  test("reads advisory tier from the posted header line", () => {
    expect(
      parseFindingCommentTier(
        postedFindingComment({ head: HEAD_A, tier: "advisory" }),
      ),
    ).toBe("advisory");
  });

  test("returns null when the header line is missing", () => {
    expect(
      parseFindingCommentTier(
        `<!-- pr-hero-finding path=src%2Fa.ts line=1 head=${HEAD_A} c=abcd1234abcd -->\n\njust a claim`,
      ),
    ).toBeNull();
  });
});

describe("scanPostedFindingTiers", () => {
  test("counts only markers for the prior summary head", () => {
    expect(
      scanPostedFindingTiers({
        summaryHead: HEAD_A,
        comments: [
          {
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              c: "111111111111",
            }),
          },
          {
            body: postedFindingComment({
              head: HEAD_A,
              tier: "blocking",
              c: "222222222222",
            }),
          },
          {
            body: postedFindingComment({
              head: HEAD_B,
              tier: "blocking",
              c: "333333333333",
            }),
          },
        ],
      }),
    ).toEqual({
      blocking: 2,
      advisory: 0,
      matchedMarkers: 2,
      parsedTiers: 2,
    });
  });

  test("uses tier from the header line, not severity", () => {
    const demotedCritical =
      `<!-- pr-hero-finding path=src%2Fa.ts line=1 head=${HEAD_A} c=abcd1234abcd -->\n\n` +
      "🟡 advisory · CRITICAL · introduced · reliability\n\nclaim";
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings: scanPostedFindingTiers({
          summaryHead: HEAD_A,
          comments: [{ body: demotedCritical }],
        }),
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({
      source: "posted-findings",
      blocking: 0,
      advisory: 1,
      score: 1,
    });
  });
});

describe("parseCiAdmissionBlock", () => {
  test("reads tier counts from the admission marker", () => {
    expect(
      parseCiAdmissionBlock(admissionBody({ blocking: 1, advisory: 2 })),
    ).toEqual({
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

describe("priorScoreForAdmission precedence", () => {
  test("state findings beat admission and posted comments", () => {
    expect(
      priorScoreForAdmission({
        state: { headSha: HEAD_A, findings: [finding("advisory")] },
        admission: { headSha: HEAD_A, blocking: 9, advisory: 0, reviews: 1 },
        postedFindings: {
          blocking: 9,
          advisory: 0,
          matchedMarkers: 1,
          parsedTiers: 1,
        },
        policy: DEFAULT_POLICY,
      }).source,
    ).toBe("state");
  });

  test("admission block beats posted comments", () => {
    expect(
      priorScoreForAdmission({
        state: null,
        admission: { headSha: HEAD_A, blocking: 1, advisory: 0, reviews: 1 },
        postedFindings: {
          blocking: 9,
          advisory: 0,
          matchedMarkers: 1,
          parsedTiers: 1,
        },
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({ source: "admission", score: 2 });
  });

  test("posted comments bootstrap when no machine-readable summary block exists", () => {
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings: {
          blocking: 3,
          advisory: 0,
          matchedMarkers: 3,
          parsedTiers: 3,
        },
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({ source: "posted-findings", score: 6 });
  });

  test("markers without tier lines fail open instead of scoring zero", () => {
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings: {
          blocking: 0,
          advisory: 0,
          matchedMarkers: 2,
          parsedTiers: 0,
        },
        policy: DEFAULT_POLICY,
      }),
    ).toMatchObject({ score: 0, failOpen: true });
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
        postedFindings: null,
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
      postedFindings: null,
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
      postedFindings: null,
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
      postedFindings: null,
      policy: DEFAULT_POLICY,
    });
    expect(verdict.action).toBe("skip");
    if (verdict.action === "skip") {
      expect(verdict.reason).toBe("below-threshold");
      expect(verdict.prior.score).toBe(0);
    }
  });

  test("bootstrap: three posted blocking findings trigger re-review without admission block", () => {
    const postedFindings = scanPostedFindingTiers({
      summaryHead: HEAD_A,
      comments: [
        {
          body: postedFindingComment({
            head: HEAD_A,
            tier: "blocking",
            c: "111111111111",
          }),
        },
        {
          body: postedFindingComment({
            head: HEAD_A,
            tier: "blocking",
            c: "222222222222",
            line: 143,
          }),
        },
        {
          body: postedFindingComment({
            head: HEAD_A,
            tier: "blocking",
            c: "333333333333",
            line: 121,
          }),
        },
      ],
    });
    expect(postedFindings).toMatchObject({
      blocking: 3,
      parsedTiers: 3,
    });
    expect(
      evaluateCiReviewAdmission({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: null,
        postedFindings,
        policy: DEFAULT_POLICY,
      }),
    ).toEqual({ action: "run" });
    expect(
      priorScoreForAdmission({
        state: null,
        admission: null,
        postedFindings,
        policy: DEFAULT_POLICY,
      }).score,
    ).toBe(6);
  });

  test("unreadable posted markers fail open", () => {
    expect(
      evaluateCiReviewAdmission({
        currentHead: HEAD_B,
        summaryHead: HEAD_A,
        markerSeen: true,
        reviewCount: 1,
        state: null,
        admission: null,
        postedFindings: {
          blocking: 0,
          advisory: 0,
          matchedMarkers: 1,
          parsedTiers: 0,
        },
        policy: DEFAULT_POLICY,
      }),
    ).toEqual({ action: "run" });
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
        postedFindings: null,
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
      postedFindings: null,
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
      stateReviewCount({ headSha: HEAD_A, findings: [], reviews: 2 }, true),
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
