import { describe, expect, test } from "bun:test";
import {
  DEDUPE_SYMBOL_LINE_WINDOW,
  type DedupeLoser,
  mergeAndDedupe,
} from "../src/dedupe";
import type { DraftFinding } from "../src/drafts";

function draft(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: "R1",
    category: 1,
    path: "src/upload.ts",
    line: 42,
    symbol: "abortUpload",
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

describe("pass 1 — dedupe_key groups", () => {
  test("higher severity wins the group", () => {
    const winner = draft({ id: "R1", severity: "CRITICAL" });
    const loser = draft({ id: "R2", severity: "WARNING" });
    const { survivors, deduped } = mergeAndDedupe([loser, winner]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.claim).toBe(winner.claim);
    expect(survivors[0]?.severity).toBe("CRITICAL");
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("R2");
  });

  test("severity tie falls to more proof_refs", () => {
    const thin = draft({ id: "R1", proof_refs: ["a"] });
    const rich = draft({ id: "R2", proof_refs: ["a", "b", "c"] });
    const { survivors, deduped } = mergeAndDedupe([thin, rich]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.proof_refs).toEqual(["a", "b", "c"]);
    expect(deduped[0]?.id).toBe("R1");
  });
});

describe("pass 2 — cross-category collapse on path:symbol", () => {
  test("collapses when both carry a symbol; winner keeps its category and folds refs uniquely", () => {
    const winner = draft({
      id: "R1",
      category: 3,
      severity: "BLOCKER",
      proof_refs: ["a", "b"],
      dedupe_key: "src/upload.ts:abortUpload:3",
    });
    const loser = draft({
      id: "P1",
      category: 13,
      severity: "CRITICAL",
      proof_refs: ["b", "c"],
      hunter: "parity",
      dedupe_key: "src/upload.ts:abortUpload:13",
    });
    const { survivors, deduped } = mergeAndDedupe([winner, loser]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.category).toBe(3);
    // Winner's refs first, losers' distinct refs appended, no duplicates.
    expect(survivors[0]?.proof_refs).toEqual(["a", "b", "c"]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.merged_into).toBe("F001");
    // Loser is verbatim: its own refs, untouched by the fold.
    expect(deduped[0]?.proof_refs).toEqual(["b", "c"]);
  });

  test("symbol-less findings on the same path never collapse across categories", () => {
    const a = draft({
      id: "R1",
      category: 1,
      symbol: undefined,
      dedupe_key: "src/upload.ts::1",
    });
    const b = draft({
      id: "R2",
      category: 5,
      symbol: undefined,
      dedupe_key: "src/upload.ts::5",
    });
    const { survivors, deduped } = mergeAndDedupe([a, b]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
  });

  test("distinct paths stay untouched even with the same symbol", () => {
    const a = draft({ id: "R1", path: "src/a.ts", dedupe_key: "src/a.ts:x:1" });
    const b = draft({ id: "R2", path: "src/b.ts", dedupe_key: "src/b.ts:x:1" });
    const { survivors, deduped } = mergeAndDedupe([a, b]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
  });

  test("same path:symbol findings far apart stay distinct (Musive #1727)", () => {
    const tap = draft({
      id: "R1",
      line: 544,
      proof_refs: ["store.ts:544"],
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const leak = draft({
      id: "S1",
      line: 935,
      hunter: "resilience",
      category: 6,
      proof_refs: ["store.ts:935"],
      dedupe_key: "src/upload.ts:abortUpload:6",
    });
    const { survivors, deduped } = mergeAndDedupe([tap, leak]);
    expect(survivors).toHaveLength(2);
    expect(deduped).toHaveLength(0);
    expect(survivors.map((s) => s.line)).toEqual([544, 935]);
  });

  test("same path:symbol findings within the line window still collapse", () => {
    const leakA = draft({
      id: "S1",
      line: 935,
      hunter: "resilience",
      category: 6,
      proof_refs: ["store.ts:935"],
      dedupe_key: "src/upload.ts:abortUpload:6",
    });
    const leakB = draft({
      id: "L1",
      line: 978,
      hunter: "lifecycle",
      category: 2,
      proof_refs: ["store.ts:978"],
      dedupe_key: "src/upload.ts:abortUpload:2",
    });
    const { survivors, deduped } = mergeAndDedupe([leakA, leakB]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.line).toBe(935);
    expect(survivors[0]?.proof_refs).toEqual(["store.ts:935", "store.ts:978"]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("L1");
  });

  test("1727 shape: off-diff metric and in-diff leak stay two survivors; nearby leak drafts still fold", () => {
    const tap = draft({
      id: "R1",
      line: 544,
      proof_refs: ["store.ts:544", "store.ts:938"],
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const leakA = draft({
      id: "S1",
      line: 935,
      hunter: "resilience",
      category: 6,
      proof_refs: ["store.ts:935"],
      dedupe_key: "src/upload.ts:abortUpload:6",
    });
    const leakB = draft({
      id: "L1",
      line: 978,
      hunter: "lifecycle",
      category: 2,
      proof_refs: ["store.ts:978"],
      dedupe_key: "src/upload.ts:abortUpload:2",
    });
    const { survivors, deduped } = mergeAndDedupe([tap, leakA, leakB]);
    expect(survivors).toHaveLength(2);
    expect(survivors[0]?.line).toBe(544);
    expect(survivors[1]?.line).toBe(935);
    expect(survivors[1]?.proof_refs).toEqual(["store.ts:935", "store.ts:978"]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.merged_into).toBe("F002");
  });

  test("the line window is inclusive at DEDUPE_SYMBOL_LINE_WINDOW and exclusive past it", () => {
    const a = draft({
      id: "R1",
      line: 1,
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const atWindow = draft({
      id: "R2",
      line: 1 + DEDUPE_SYMBOL_LINE_WINDOW,
      category: 5,
      dedupe_key: "src/upload.ts:abortUpload:5",
    });
    expect(mergeAndDedupe([a, atWindow]).survivors).toHaveLength(1);
    const past = draft({
      id: "R3",
      line: 1 + DEDUPE_SYMBOL_LINE_WINDOW + 1,
      category: 5,
      dedupe_key: "src/upload.ts:abortUpload:5",
    });
    expect(mergeAndDedupe([a, past]).survivors).toHaveLength(2);
  });
});

describe("renumbering and loser bookkeeping", () => {
  test("survivors renumber to F001, F002 in first-appearance order", () => {
    const first = draft({ id: "Z9", dedupe_key: "src/a.ts:f:1", symbol: "f" });
    const second = draft({ id: "A1", dedupe_key: "src/b.ts:g:2", symbol: "g" });
    const third = draft({ id: "M5", dedupe_key: "src/c.ts:h:3", symbol: "h" });
    const { survivors } = mergeAndDedupe([first, second, third]);
    expect(survivors.map((s) => s.id)).toEqual(["F001", "F002", "F003"]);
    expect(survivors.map((s) => s.dedupe_key)).toEqual([
      "src/a.ts:f:1",
      "src/b.ts:g:2",
      "src/c.ts:h:3",
    ]);
  });

  test("merged_into names the post-renumber id, not the hunter draft id", () => {
    const standalone = draft({
      id: "R1",
      path: "src/other.ts",
      symbol: "solo",
      dedupe_key: "src/other.ts:solo:1",
    });
    const winner = draft({ id: "R2", severity: "BLOCKER" });
    const loser = draft({ id: "R3", severity: "WARNING" });
    const { survivors, deduped } = mergeAndDedupe([standalone, winner, loser]);
    // The winner is the SECOND survivor, so the loser must point at F002.
    expect(survivors[1]?.claim).toBe(winner.claim);
    expect(deduped[0]?.merged_into).toBe("F002");
  });

  test("losers carry the original draft verbatim plus merged_into", () => {
    const winner = draft({ id: "R1", severity: "BLOCKER" });
    const loser = draft({
      id: "R2",
      severity: "SUGGESTION",
      claim: "same defect, weaker lens",
      proof_refs: ["x"],
      hops_used: 4,
    });
    const { deduped } = mergeAndDedupe([winner, loser]);
    const { merged_into, ...verbatim } = deduped[0] as DedupeLoser;
    expect(verbatim).toEqual(loser);
    expect(merged_into).toBe("F001");
  });

  test("a pass-1 loser whose winner falls in pass 2 points at the ultimate survivor", () => {
    const pass1Winner = draft({
      id: "R1",
      category: 1,
      severity: "CRITICAL",
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const pass1Loser = draft({
      id: "R2",
      category: 1,
      severity: "WARNING",
      dedupe_key: "src/upload.ts:abortUpload:1",
    });
    const pass2Winner = draft({
      id: "P1",
      category: 13,
      severity: "BLOCKER",
      hunter: "parity",
      dedupe_key: "src/upload.ts:abortUpload:13",
    });
    const { survivors, deduped } = mergeAndDedupe([
      pass1Winner,
      pass1Loser,
      pass2Winner,
    ]);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.category).toBe(13);
    expect(deduped).toHaveLength(2);
    for (const loser of deduped) {
      expect(loser.merged_into).toBe("F001");
    }
  });
});

describe("edges", () => {
  test("empty input yields empty survivors and deduped", () => {
    expect(mergeAndDedupe([])).toEqual({ survivors: [], deduped: [] });
  });

  test("single finding passes through with a renumbered id only", () => {
    const only = draft({ id: "R7" });
    const { survivors, deduped } = mergeAndDedupe([only]);
    expect(survivors).toEqual([{ ...only, id: "F001" }]);
    expect(deduped).toEqual([]);
  });

  test("same input always produces the same output", () => {
    const input = [
      draft({ id: "R1", severity: "BLOCKER" }),
      draft({ id: "R2", severity: "WARNING" }),
      draft({ id: "R3", path: "src/b.ts", dedupe_key: "src/b.ts:g:2" }),
    ];
    expect(mergeAndDedupe(input)).toEqual(mergeAndDedupe(input));
  });
});
