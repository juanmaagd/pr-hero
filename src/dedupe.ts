// Prose Step 5 as a pure function: merge every hunter's drafts, collapse
// duplicates, renumber survivors. Deterministic — same input, same output.

import type { DraftFinding } from "./drafts";
import type { Severity } from "./findings";

// A survivor is a draft whose id has been renumbered to the canonical
// F001, F002, … sequence (and, for a cross-category winner, whose proof_refs
// absorbed its losers' evidence).
export type DedupedSurvivor = DraftFinding;

// A loser is the original hunter-assigned draft VERBATIM plus the surviving
// finding's post-renumber id — the shape debug.deduped[] requires so a
// benchmark miss stays attributable.
export type DedupeLoser = DraftFinding & { merged_into: string };

const SEVERITY_RANK: Record<Severity, number> = {
  BLOCKER: 0,
  CRITICAL: 1,
  WARNING: 2,
  SUGGESTION: 3,
};

// Richest claim: higher severity first, then more proof_refs; a full tie
// keeps the earlier finding (first appearance), which keeps the pass stable.
function pickRichest(group: DraftFinding[]): DraftFinding {
  return group.reduce((best, candidate) => {
    const bySeverity =
      SEVERITY_RANK[candidate.severity] - SEVERITY_RANK[best.severity];
    if (bySeverity < 0) return candidate;
    if (
      bySeverity === 0 &&
      candidate.proof_refs.length > best.proof_refs.length
    ) {
      return candidate;
    }
    return best;
  });
}

export function mergeAndDedupe(drafts: DraftFinding[]): {
  survivors: DedupedSurvivor[];
  deduped: DedupeLoser[];
} {
  // Loser → the finding it merged into. Chained at the end: a pass-1 loser
  // whose winner then loses pass 2 must point at the ultimate survivor.
  const winnerOf = new Map<DraftFinding, DraftFinding>();

  // Pass 1 — exact dedupe_key groups. Map preserves insertion order, so
  // winners come out in first-appearance order of their groups.
  const byKey = new Map<string, DraftFinding[]>();
  for (const draft of drafts) {
    const group = byKey.get(draft.dedupe_key);
    if (group) group.push(draft);
    else byKey.set(draft.dedupe_key, [draft]);
  }
  const pass1: DraftFinding[] = [];
  for (const group of byKey.values()) {
    const winner = pickRichest(group);
    pass1.push(winner);
    for (const draft of group) {
      if (draft !== winner) winnerOf.set(draft, winner);
    }
  }

  // Pass 2 — cross-category collapse on path:symbol, ONLY when both findings
  // carry a non-empty symbol. The schema has `symbol?:` — collapsing
  // symbol-less findings would key on path alone and over-merge distinct
  // defects file-wide (a JD finding), so they never participate here.
  const bySymbol = new Map<string, DraftFinding[]>();
  for (const draft of pass1) {
    if (!draft.symbol) continue;
    const key = `${draft.path}:${draft.symbol}`;
    const group = bySymbol.get(key);
    if (group) group.push(draft);
    else bySymbol.set(key, [draft]);
  }
  const pass2Winner = new Map<string, DraftFinding>();
  for (const [key, group] of bySymbol) {
    const winner = pickRichest(group);
    pass2Winner.set(key, winner);
    for (const draft of group) {
      if (draft !== winner) winnerOf.set(draft, winner);
    }
  }

  // Emit survivors in first-appearance order: a collapsed group's winner
  // surfaces at the position where the group first appeared. The winner keeps
  // its own category; losers' proof_refs fold in after the winner's own,
  // deduplicated.
  const survivorsRaw: DraftFinding[] = [];
  const emittedKeys = new Set<string>();
  for (const draft of pass1) {
    if (!draft.symbol) {
      survivorsRaw.push(draft);
      continue;
    }
    const key = `${draft.path}:${draft.symbol}`;
    if (emittedKeys.has(key)) continue;
    emittedKeys.add(key);
    const winner = pass2Winner.get(key) as DraftFinding;
    const group = bySymbol.get(key) as DraftFinding[];
    if (group.length === 1) {
      survivorsRaw.push(winner);
      continue;
    }
    const foldedRefs = [...winner.proof_refs];
    for (const member of group) {
      if (member === winner) continue;
      for (const ref of member.proof_refs) {
        if (!foldedRefs.includes(ref)) foldedRefs.push(ref);
      }
    }
    survivorsRaw.push({ ...winner, proof_refs: foldedRefs });
  }

  // Renumbering happens HERE, before the refuter (a JD finding): the refuter
  // batch, verdict mapping, and losers' merged_into all use these final ids —
  // renumbering later would leave debug.deduped[] pointing at dead ids.
  const finalId = new Map<DraftFinding, string>();
  const survivors = survivorsRaw.map((survivor, i) => {
    const id = `F${String(i + 1).padStart(3, "0")}`;
    // Pass-2 winners were re-created with folded refs; key resolution on the
    // ORIGINAL draft object, which winnerOf chains reference.
    const key = survivor.symbol ? `${survivor.path}:${survivor.symbol}` : "";
    const original = pass2Winner.get(key) ?? survivor;
    finalId.set(original, id);
    return { ...survivor, id };
  });

  const resolve = (loser: DraftFinding): string => {
    let current = loser;
    let next = winnerOf.get(current);
    while (next) {
      current = next;
      next = winnerOf.get(current);
    }
    return finalId.get(current) as string;
  };

  // Losers in original input order, each verbatim plus merged_into.
  const deduped: DedupeLoser[] = [];
  for (const draft of drafts) {
    if (winnerOf.has(draft)) {
      deduped.push({ ...draft, merged_into: resolve(draft) });
    }
  }

  return { survivors, deduped };
}
