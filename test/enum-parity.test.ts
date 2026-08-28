// Behavioural closed-set parity test (design D3): the Hunter enum is
// duplicated across four validators on purpose (findings.ts, spec.ts,
// drafts.ts, plus the lab mirror out of this repo's reach) rather than
// collapsed into one shared export. This test is the mechanical guard
// against the "third copy is easy to miss" trap — every validator here
// MUST accept exactly the same key set and reject the same out-of-set key.
import { describe, expect, test } from "bun:test";
import { type DraftFinding, validateDraftFinding } from "../src/drafts";
import {
  type Finding,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V1_1,
  validateFinding,
  validateFindingsDocument,
} from "../src/findings";
import { FINDINGS_CONFORMANCE_CASES } from "../src/findings-conformance";
import { type AgentSpec, validateReviewSpec } from "../src/spec";

const IN_ENUM = ["reliability", "resilience", "parity", "lifecycle"] as const;
const OPEN_SLUG = "security";
const UNSAFE_SLUG = "Security";

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

  test(`validateDraftFinding accepts open slug hunter "${OPEN_SLUG}"`, () => {
    expect(() => validateDraftFinding(baseDraft(OPEN_SLUG), 0)).not.toThrow();
  });

  test(`validateReviewSpec accepts open hunter key "${OPEN_SLUG}"`, () => {
    expect(() =>
      validateReviewSpec({ agents: [agentSpec(OPEN_SLUG)] }),
    ).not.toThrow();
  });

  test(`validateFinding rejects out-of-enum hunter "${OPEN_SLUG}"`, () => {
    expect(() => validateFinding(baseFinding(OPEN_SLUG), 0)).toThrow(
      /hunter invalid/,
    );
  });

  test(`validateDraftFinding rejects unsafe hunter slug "${UNSAFE_SLUG}"`, () => {
    expect(() => validateDraftFinding(baseDraft(UNSAFE_SLUG), 0)).toThrow(
      /hunter invalid/,
    );
  });

  test(`validateReviewSpec rejects unsafe hunter key "${UNSAFE_SLUG}"`, () => {
    expect(() =>
      validateReviewSpec({ agents: [agentSpec(UNSAFE_SLUG)] }),
    ).toThrow(/safe slug/);
  });
});

describe("validateFinding stays v1.0 closed-hunter for enum parity", () => {
  test(`validateFindingsDocument v1.1 accepts "${OPEN_SLUG}" while validateFinding rejects it`, () => {
    const doc = {
      schema_version: SCHEMA_VERSION_V1_1,
      pr: 1,
      base_sha: "abc",
      head_sha: "def",
      model: "sonnet",
      iteration: 1,
      parity_hunter_fired: false,
      run_status: "complete" as const,
      engine: { name: "pr-hero", version: "1.0.0" },
      telemetry: {
        index_ms: 1,
        index_mode: "fresh" as const,
        index_disk_mb: 1,
        wall_ms: 1,
        tokens_in: 1,
        tokens_out: 1,
        tokens_total: 2,
        cost_usd_est: 0.1,
      },
      findings: [baseFinding(OPEN_SLUG)],
      debug: { refuted: [] },
    };
    expect(() => validateFindingsDocument(doc)).not.toThrow();
    expect(() => validateFinding(baseFinding(OPEN_SLUG), 0)).toThrow(
      /hunter invalid/,
    );
  });

  test("validateFindingsDocument v1.0 still rejects out-of-enum hunter", () => {
    const doc = {
      schema_version: SCHEMA_VERSION,
      pr: 1,
      base_sha: "abc",
      head_sha: "def",
      model: "sonnet",
      iteration: 1,
      parity_hunter_fired: false,
      run_status: "complete" as const,
      telemetry: {
        index_ms: 1,
        index_mode: "fresh" as const,
        index_disk_mb: 1,
        wall_ms: 1,
        tokens_in: 1,
        tokens_out: 1,
        tokens_total: 2,
        cost_usd_est: 0.1,
      },
      findings: [baseFinding(OPEN_SLUG)],
      debug: { refuted: [] },
    };
    expect(() => validateFindingsDocument(doc)).toThrow(/hunter invalid/);
  });
});

describe("conformance cases match validateFindingsDocument acceptance", () => {
  for (const conformanceCase of FINDINGS_CONFORMANCE_CASES) {
    test(`${conformanceCase.id} semantics are identical`, () => {
      const parsed = JSON.parse(conformanceCase.raw);
      if (conformanceCase.expect === "accept") {
        expect(() => validateFindingsDocument(parsed)).not.toThrow();
      } else {
        expect(() => validateFindingsDocument(parsed)).toThrow();
      }
    });
  }
});
