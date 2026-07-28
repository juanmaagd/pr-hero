import { describe, expect, test } from "bun:test";
import {
  type DraftFinding,
  extractJsonObject,
  validateHunterDraft,
  validateRefuterResult,
} from "../src/drafts";

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
