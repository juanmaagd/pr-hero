import { describe, expect, test } from "bun:test";
import type { Finding } from "../src/findings";
import {
  findingsToCandidates,
  findingsToMartianReview,
  lookupGolden,
  type MartianGoldenPr,
  prNumberFromUrl,
} from "../src/martian-adapter";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 1,
    path: "packages/features/bookings/lib/handleNewBooking.ts",
    line: 88,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "forEach with async callbacks fire-and-forget",
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "handleNewBooking.ts:forEach:1",
    ...over,
  };
}

const GOLDENS: MartianGoldenPr[] = [
  {
    pr_title: "Async import",
    url: "https://github.com/calcom/cal.com/pull/8087",
    comments: [
      { comment: "try-catch", severity: "Low", category: "speculative" },
    ],
  },
];

describe("prNumberFromUrl", () => {
  test("reads the pull number", () => {
    expect(prNumberFromUrl("https://github.com/calcom/cal.com/pull/8087")).toBe(
      8087,
    );
  });

  test("rejects a non-pull URL", () => {
    expect(() => prNumberFromUrl("https://github.com/calcom/cal.com")).toThrow(
      /not a GitHub pull URL/,
    );
  });
});

describe("findingsToCandidates", () => {
  test("projects path, line, and claim; nothing else", () => {
    expect(findingsToCandidates([finding()])).toEqual([
      {
        path: "packages/features/bookings/lib/handleNewBooking.ts",
        line: 88,
        body: "forEach with async callbacks fire-and-forget",
      },
    ]);
  });

  test("empty findings produce empty candidates", () => {
    expect(findingsToCandidates([])).toEqual([]);
  });
});

describe("findingsToMartianReview", () => {
  test("stamps tool pr-hero and duplicates claim as candidate text", () => {
    const review = findingsToMartianReview({
      prUrl: "https://github.com/calcom/cal.com/pull/8087",
      findings: [finding(), finding({ id: "F002", claim: "second" })],
    });
    expect(review.tool).toBe("pr-hero");
    expect(review.candidates).toEqual([
      "forEach with async callbacks fire-and-forget",
      "second",
    ]);
    expect(review.review_comments).toHaveLength(2);
  });
});

describe("lookupGolden", () => {
  test("finds the PR by number", () => {
    expect(lookupGolden(GOLDENS, 8087).pr_title).toBe("Async import");
  });

  test("fails loud on a missing PR", () => {
    expect(() => lookupGolden(GOLDENS, 1)).toThrow(
      /no Martian golden for PR 1/,
    );
  });
});
