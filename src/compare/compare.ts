// Head-to-head bucketing: pr-hero's findings against Greptile's on the SAME
// live PR. This is what replaces the aging golden dataset — instead of scoring
// against an audited snapshot that decays as the codebase moves, every open PR
// carries its own fresh reference reviewer.
//
// Pure and deterministic on purpose. The buckets are an input to a human
// judgement, not the judgement itself, so the same two inputs must always
// produce the same three lists.

import type { GreptileFinding } from "./greptile";

export type Bucket = "both" | "greptile_only" | "prhero_only";

// The subset of a pr-hero `Finding` this comparison needs. Deliberately
// structural rather than an import of `Finding`: the driver may load an
// artifact written by an older schema version, and a comparison must not fail
// because some unrelated field drifted.
export interface PrHeroFindingRef {
  id: string;
  path: string;
  line: number;
  claim: string;
  tier: string;
}

export interface MatchedPair {
  greptile: GreptileFinding;
  prhero: PrHeroFindingRef;
}

export interface ComparisonResult {
  // Ordered first everywhere because it is THE measured number: a finding a
  // production reviewer caught and pr-hero did not is a recall miss with a
  // name, a file and a line — the thing the benchmark exists to count.
  greptileOnly: GreptileFinding[];
  both: MatchedPair[];
  prheroOnly: PrHeroFindingRef[];
}

export interface CompareOptions {
  lineWindow?: number;
}

export const DEFAULT_LINE_WINDOW = 25;

// Normalization is intentionally minimal — trim and drop one leading `./`.
// Both sides quote repo-relative paths already; anything more aggressive
// (case folding, basename matching) would start inventing matches across
// packages/, which this monorepo has plenty of duplicate filenames in.
export function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

// THE MATCHING RULE, stated once so it is arguable:
//
//   same normalized path AND the pr-hero line falls inside the Greptile range
//   expanded by `lineWindow` on both sides (inclusive) — i.e.
//   startLine - window <= line <= endLine + window.
//
// WHY location-only, and explicitly NOT claim-text similarity: "do these two
// sentences describe the same defect" is a judgement call. Any embedding,
// keyword-overlap or LLM-similarity gate would make the bucket counts depend
// on a threshold nobody can defend, and would make the benchmark irreproducible
// across model versions. Location proximity is mechanical, cheap and fully
// explainable — a human can verify any single row by opening the file.
//
// The known cost of that choice: same-location-different-mechanism. Two
// reviewers can both flag line 128 of the same hook and mean completely
// different bugs, and this rule will pair them. That false match is NOT
// silently absorbed — it is why `renderComparison` prints Greptile's title and
// description next to pr-hero's claim for every `both` row, so a human reading
// the report can reject the pairing on sight. The window is a recall net for
// the human, not a verdict.
//
// The default of 25 lines is a deliberate over-match: it is far better to show
// a human a pair they reject than to score a real agreement as a miss and
// inflate pr-hero's apparent recall gap.
export function compareFindings(
  prhero: PrHeroFindingRef[],
  greptile: GreptileFinding[],
  opts?: CompareOptions,
): ComparisonResult {
  const window = opts?.lineWindow ?? DEFAULT_LINE_WINDOW;
  const prheroList = Array.isArray(prhero) ? prhero : [];
  const greptileList = Array.isArray(greptile) ? greptile : [];

  const both: MatchedPair[] = [];
  const greptileOnly: GreptileFinding[] = [];
  // Membership by identity, not by id: two pr-hero findings could in principle
  // share an id across malformed inputs, and identity cannot be spoofed.
  const matchedPrhero = new Set<PrHeroFindingRef>();

  // Greptile drives the outer loop in its own index order, pr-hero the inner
  // loop in input order — that fixes the output order without a sort.
  for (const g of greptileList) {
    const gPath = normalizePath(g.path);
    const low = g.startLine - window;
    const high = g.endLine + window;
    let paired = false;
    for (const p of prheroList) {
      if (normalizePath(p.path) !== gPath) continue;
      if (p.line < low || p.line > high) continue;
      // One Greptile finding may pair with several pr-hero findings, and one
      // pr-hero finding may pair with several Greptile findings — real data has
      // both (PR 1509 reported two distinct defects at the same path:line).
      // Emitting every pair keeps the report honest instead of arbitrarily
      // picking a winner.
      both.push({ greptile: g, prhero: p });
      matchedPrhero.add(p);
      paired = true;
    }
    if (!paired) greptileOnly.push(g);
  }

  const prheroOnly = prheroList.filter((p) => !matchedPrhero.has(p));
  return { greptileOnly, both, prheroOnly };
}
