import { describe, expect, test } from "bun:test";
import {
  type DraftFinding,
  extractJsonObject,
  validateHunterDraft,
  validateRefuterResult,
  validateSummary,
} from "../src/drafts";
import type { RunSummary } from "../src/findings";

function draft(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: "R1",
    category: 1,
    path: "src/upload.ts",
    line: 42,
    severity: "WARNING",
    evidence_class: "inferential",
    causal_disposition: "introduced",
    claim: "stale derived state after mutation",
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/upload.ts:abortUpload:1",
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    prose: "This change improves upload state handling.",
    score: 4,
    score_reason: "The change is focused and the main behavior is covered.",
    ...overrides,
  };
}

describe("extractJsonObject", () => {
  const payload = { findings: [draft()] };

  test("parses a direct JSON-only final message", () => {
    expect(extractJsonObject(JSON.stringify(payload))).toEqual(payload);
  });

  test("parses a ```json fenced final message", () => {
    const text = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    expect(extractJsonObject(text)).toEqual(payload);
  });

  test("parses a prose-wrapped final message", () => {
    const text = `Here is the result: ${JSON.stringify(payload)}`;
    expect(extractJsonObject(text)).toEqual(payload);
  });

  test("parses an oversized (>8KB) prose-wrapped draft in full", () => {
    // A multi-finding draft with long claims easily exceeds 8192 chars; the
    // extractor must never operate on a truncated slice of the final text.
    const big = {
      findings: Array.from({ length: 12 }, (_, i) =>
        draft({
          id: `R${i + 1}`,
          claim: `finding ${i} — ${"very long evidence chain ".repeat(40)}`,
        }),
      ),
    };
    const json = JSON.stringify(big);
    expect(json.length).toBeGreaterThan(8192);
    const wrapped = `The draft follows.\n${json}\nDone.`;
    expect(extractJsonObject(wrapped)).toEqual(big);
  });

  test("returns undefined on garbage", () => {
    expect(extractJsonObject("no findings worth reporting")).toBeUndefined();
    expect(extractJsonObject("broken { not json ] here")).toBeUndefined();
  });
});

describe("validateHunterDraft", () => {
  test("accepts a well-formed draft", () => {
    const candidate = { findings: [draft(), draft({ id: "R2" })] };
    expect(validateHunterDraft(candidate)).toEqual(candidate);
  });

  test("rejects a finding missing a required field", () => {
    const { dedupe_key: _key, ...withoutKey } = draft();
    expect(() => validateHunterDraft({ findings: [withoutKey] })).toThrow();
    expect(() => validateHunterDraft({})).toThrow();
  });
});

describe("validateSummary", () => {
  test("accepts a well-formed summary", () => {
    expect(validateSummary(summary())).toEqual(summary());
  });

  test("accepts inclusive length limits and score endpoints", () => {
    const candidate = summary({
      prose: "x".repeat(1200),
      score: 1,
      score_reason: "x".repeat(400),
    });
    expect(validateSummary(candidate)).toEqual(candidate);
    expect(validateSummary({ ...candidate, score: 5 })).toEqual({
      ...candidate,
      score: 5,
    });
  });

  test("rejects empty prose and score reason", () => {
    expect(() => validateSummary(summary({ prose: "" }))).toThrow();
    expect(() => validateSummary(summary({ score_reason: "" }))).toThrow();
  });

  test("rejects prose over 1200 characters", () => {
    expect(() =>
      validateSummary(summary({ prose: "x".repeat(1201) })),
    ).toThrow();
  });

  test("rejects score reasons over 400 characters", () => {
    expect(() =>
      validateSummary(summary({ score_reason: "x".repeat(401) })),
    ).toThrow();
  });

  test("rejects non-integer and out-of-range scores", () => {
    expect(() => validateSummary(summary({ score: 2.5 }))).toThrow();
    expect(() => validateSummary(summary({ score: 0 }))).toThrow();
    expect(() => validateSummary(summary({ score: 6 }))).toThrow();
  });

  test("rejects HTML comment markers in either string", () => {
    expect(() =>
      validateSummary(summary({ prose: "before <!-- after" })),
    ).toThrow();
    expect(() =>
      validateSummary(summary({ score_reason: "before --> after" })),
    ).toThrow();
  });
});

describe("validateRefuterResult", () => {
  const verdict = (finding_id: string) => ({
    finding_id,
    outcome: "corroborated" as const,
    proof_refs: ["src/upload.ts:42"],
  });

  test("accepts one verdict per submitted id, exactly", () => {
    const candidate = { results: [verdict("F001"), verdict("F002")] };
    expect(validateRefuterResult(candidate, ["F001", "F002"])).toEqual(
      candidate,
    );
  });

  test("rejects a missing verdict", () => {
    const candidate = { results: [verdict("F001")] };
    expect(() => validateRefuterResult(candidate, ["F001", "F002"])).toThrow();
  });

  test("rejects a verdict for a never-submitted id", () => {
    const candidate = { results: [verdict("F001"), verdict("F999")] };
    expect(() => validateRefuterResult(candidate, ["F001"])).toThrow();
  });

  test("rejects a duplicate verdict", () => {
    const candidate = { results: [verdict("F001"), verdict("F001")] };
    expect(() => validateRefuterResult(candidate, ["F001"])).toThrow();
  });

  test("rejects an invalid outcome", () => {
    const candidate = { results: [{ ...verdict("F001"), outcome: "maybe" }] };
    expect(() => validateRefuterResult(candidate, ["F001"])).toThrow();
  });
});
