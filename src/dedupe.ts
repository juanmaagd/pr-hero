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

// Pass 2 collapses same-path:symbol findings only when their lines sit
// inside this window of each other (connected components). JUDGEMENT, but
// measured: Musive PR 1727 had a same-defect pair 43 lines apart (935 vs
// 978, one try/catch/finally) and a distinct-defect pair 391 apart (544 vs
// 935, tap-to-audio vs timer leak). 100 clears the same-block pair with
// slack and still splits 544 from 935. Widen only with another measurement.
// Direction of error is under-merge: a duplicate comment is visible, an
// over-merge that dumps an in-diff finding into the summary is not.
export const DEDUPE_SYMBOL_LINE_WINDOW = 100;

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

// Connected components on |lineA - lineB| <= window, preserving the group's
// first-appearance order so survivors still emit where the cluster first
// showed up. Transitive on purpose: 935 and 978 join through each other
// without a middle finding; 544 cannot join them without a finding every
// ~100 lines in between, which 1727 did not have.
function clusterByProximity(
  group: DraftFinding[],
  window: number,
): DraftFinding[][] {
  const n = group.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cursor = i;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = group[i];
      const b = group[j];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a.line - b.line) > window) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }
  }
  const clusters: DraftFinding[][] = [];
  const indexByRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const member = group[i];
    if (member === undefined) continue;
    const root = find(i);
    const existing = indexByRoot.get(root);
    if (existing === undefined) {
      indexByRoot.set(root, clusters.length);
      clusters.push([member]);
    } else {
      clusters[existing]?.push(member);
    }
  }
  return clusters;
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
  //
  // Same-symbol is a recall net for "same defect, different hunter
  // category", not "everything in this function is one bug". Musive PR 1727
  // collapsed a tap-to-audio finding at playAudio:544 into a timer-leak
  // finding at :935 because both carried symbol `playAudio`; pickRichest
  // kept line 544 (off-diff) and the in-diff leak posted only as Evidence
  // inside the summary. Within a path:symbol group, collapse only the
  // connected component whose lines fall inside DEDUPE_SYMBOL_LINE_WINDOW.
  const bySymbol = new Map<string, DraftFinding[]>();
  for (const draft of pass1) {
    if (!draft.symbol) continue;
    const key = `${draft.path}:${draft.symbol}`;
    const group = bySymbol.get(key);
    if (group) group.push(draft);
    else bySymbol.set(key, [draft]);
  }
  const clusterOf = new Map<DraftFinding, DraftFinding[]>();
  const clusterWinnerOf = new Map<DraftFinding, DraftFinding>();
  for (const group of bySymbol.values()) {
    for (const cluster of clusterByProximity(
      group,
      DEDUPE_SYMBOL_LINE_WINDOW,
    )) {
      const winner = pickRichest(cluster);
      clusterOf.set(winner, cluster);
      for (const draft of cluster) {
        clusterWinnerOf.set(draft, winner);
        if (draft !== winner) winnerOf.set(draft, winner);
      }
    }
  }

  // Emit survivors in first-appearance order: a collapsed cluster's winner
  // surfaces at the position where the cluster first appeared. The winner
  // keeps its own category; losers' proof_refs fold in after the winner's
  // own, deduplicated. Two clusters that share a path:symbol (1727: 544 vs
  // 935/978) each emit — emittedKeys used to be path:symbol and would have
  // dropped the second cluster.
  const survivorsRaw: DraftFinding[] = [];
  const emittedWinners = new Set<DraftFinding>();
  // Folded survivors are new objects; winnerOf chains still point at the
  // original winner, so renumbering has to key on that original.
  const originalOf = new Map<DraftFinding, DraftFinding>();
  for (const draft of pass1) {
    if (!draft.symbol) {
      survivorsRaw.push(draft);
      originalOf.set(draft, draft);
      continue;
    }
    const winner = clusterWinnerOf.get(draft) as DraftFinding;
    if (emittedWinners.has(winner)) continue;
    emittedWinners.add(winner);
    const cluster = clusterOf.get(winner) as DraftFinding[];
    if (cluster.length === 1) {
      survivorsRaw.push(winner);
      originalOf.set(winner, winner);
      continue;
    }
    const foldedRefs = [...winner.proof_refs];
    for (const member of cluster) {
      if (member === winner) continue;
      for (const ref of member.proof_refs) {
        if (!foldedRefs.includes(ref)) foldedRefs.push(ref);
      }
    }
    const folded = { ...winner, proof_refs: foldedRefs };
    survivorsRaw.push(folded);
    originalOf.set(folded, winner);
  }

  // Renumbering happens HERE, before the refuter (a JD finding): the refuter
  // batch, verdict mapping, and losers' merged_into all use these final ids —
  // renumbering later would leave debug.deduped[] pointing at dead ids.
  const finalId = new Map<DraftFinding, string>();
  const survivors = survivorsRaw.map((survivor, i) => {
    const id = `F${String(i + 1).padStart(3, "0")}`;
    const original = originalOf.get(survivor) ?? survivor;
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
