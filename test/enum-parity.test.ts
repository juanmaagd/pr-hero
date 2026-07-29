// Behavioural closed-set parity test (design D3): the Hunter enum is
// duplicated across four validators on purpose (findings.ts, spec.ts,
// drafts.ts, plus the lab mirror out of this repo's reach) rather than
// collapsed into one shared export. This test is the mechanical guard
// against the "third copy is easy to miss" trap — every validator here
// MUST accept exactly the same key set and reject the same out-of-set key.
import { describe, expect, test } from "bun:test";
import { type DraftFinding, validateDraftFinding } from "../src/drafts";
import { type Finding, validateFinding } from "../src/findings";
import { type AgentSpec, validateReviewSpec } from "../src/spec";

const IN_ENUM = ["reliability", "resilience", "parity", "lifecycle"] as const;
const OUT_OF_ENUM = "security";

function baseFinding(hunter: string): Finding {
  return {
    id: "F001",
    category: 1,
    path: "src/example.ts",
    line: 1,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "not_submitted",
    causal_disposition: "introduced",
    claim: "example",
    proof_refs: ["diff-hunk#1"],
    hunter: hunter as Finding["hunter"],
    tier: "blocking",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/example.ts:1",
  };
}

function baseDraft(hunter: string): DraftFinding {
  return {
    id: "F001",
    category: 1,
    path: "src/example.ts",
    line: 1,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    causal_disposition: "introduced",
    claim: "example",
    proof_refs: ["diff-hunk#1"],
    hunter: hunter as DraftFinding["hunter"],
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/example.ts:1",
  };
}

function agentSpec(key: string): AgentSpec {
  return { key, file: `deep-review-${key}.md`, role: "hunter" };
}

describe("closed-set enum parity across validators", () => {
  for (const key of IN_ENUM) {
    test(`validateFinding accepts hunter "${key}"`, () => {
      expect(() => validateFinding(baseFinding(key), 0)).not.toThrow();
    });

    test(`validateDraftFinding accepts hunter "${key}"`, () => {
      expect(() => validateDraftFinding(baseDraft(key), 0)).not.toThrow();
    });

    test(`validateReviewSpec accepts hunter key "${key}"`, () => {
      expect(() =>
        validateReviewSpec({ agents: [agentSpec(key)] }),
      ).not.toThrow();
    });
  }

  test(`validateFinding rejects out-of-enum hunter "${OUT_OF_ENUM}"`, () => {
    expect(() => validateFinding(baseFinding(OUT_OF_ENUM), 0)).toThrow(
      /hunter invalid/,
    );
  });

  test(`validateDraftFinding rejects out-of-enum hunter "${OUT_OF_ENUM}"`, () => {
    expect(() => validateDraftFinding(baseDraft(OUT_OF_ENUM), 0)).toThrow(
      /hunter invalid/,
    );
  });

  test(`validateReviewSpec rejects out-of-enum hunter key "${OUT_OF_ENUM}"`, () => {
    expect(() =>
      validateReviewSpec({ agents: [agentSpec(OUT_OF_ENUM)] }),
    ).toThrow(/Hunter enum/);
  });
});
