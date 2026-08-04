// Derived root-cause clustering: how many DISTINCT defects a findings array
// actually describes. Pure and deterministic — same input array, same output.
//
// MEASUREMENT ONLY, and that is load-bearing. Nothing here deletes, merges,
// reorders, retiers, or renumbers a finding: the lab's scorer reads
// `findings[]` alone, so any collapse performed here would surface as a recall
// regression on a run whose recall did not change. Clustering is reported
// alongside the findings, never applied to them.

export interface RootCauseCluster {
  id: string; // RC001, RC002, … in first-appearance order
  anchor: string | null; // null when the finding carried no anchor at all
  finding_ids: string[]; // in input order
}

export interface RootCauseSummary {
  clusters: RootCauseCluster[];
  distinct_root_causes: number;
}

// The minimum a finding must expose to be clustered. Structural on purpose:
// the same function has to serve live engine `Finding`s and raw findings.json
// parsed off disk from a run that predates `root_cause_id` entirely.
export interface RootCauseInput {
  id: string;
  proof_refs: string[];
}

// A proof_ref reads `path:line-range (prose about what happens there)`. The
// location token is the stable part: findings in one fan-out cite the SAME
// root-cause location but describe it differently ("stores raw seconds",
// "returns unscaled value"), so everything from the first whitespace on is
// discarded before comparison.
//
// Comparison is then EXACT — no case folding, no path normalization, no line
// -range merging, so `foo.ts:19` and `foo.ts:19-20` are different anchors.
// Every normalization rule is a guess about whether two citations mean the
// same place, and a wrong guess here merges unrelated findings (see the
// direction-of-error note on clusterByRootCause).
// A ref written `path.tsx: 12-14 (prose)` — a space after the colon — degenerates
// to a bare `path.tsx:` once the prose is cut, and a token with no colon at all is
// bare path too. Both are FILE-level, and a file-level anchor merges every finding
// that happens to live in the same file. `dedupe.ts` already paid for this exact
// mistake: its pass 2 refuses to collapse symbol-less findings because keying on
// path alone over-merges distinct defects file-wide (a judgment-day finding). Same
// rule here — no location component means no anchor, so the finding stays a
// singleton instead of dragging its neighbours in.
export function extractAnchor(proofRefs: string[]): string | null {
  const first = proofRefs[0];
  if (first === undefined) return null;
  const trimmed = first.trim();
  const boundary = trimmed.search(/\s/);
  const anchor = boundary === -1 ? trimmed : trimmed.slice(0, boundary);
  if (anchor.length === 0) return null;
  const colon = anchor.lastIndexOf(":");
  if (colon === -1 || colon === anchor.length - 1) return null;
  return anchor;
}

// Partitions `findings` by the anchor of their FIRST proof_ref only — never a
// union-find over any shared ref.
//
// Transitive clustering is the tempting version and it is wrong: findings in a
// fan-out also share INCIDENTAL refs (every consumer of a broken producer
// tends to cite the same shared formatting or utility helper too), so chaining
// on "shares any ref" welds unrelated defects into one blob. Over-clustering
// deflates the apparent false-positive count, which is the direction that
// flatters the engine — so this deliberately errs toward UNDER-clustering:
// worst case a real fan-out is reported as several root causes, never the
// reverse.
//
// The first ref is not an arbitrary pick either. The hunter output contract
// orders proof_refs as ["producer path:line", "consumer path:line"], so
// proof_refs[0] is where the defect LIVES while the rest is where it shows up.
//
// A finding with no anchor is always its own singleton and never joins
// anything: absence of evidence about the root cause is not evidence that two
// findings share one.
export function clusterByRootCause(
  findings: ReadonlyArray<RootCauseInput>,
): RootCauseSummary {
  const ordered: Array<{ anchor: string | null; finding_ids: string[] }> = [];
  const byAnchor = new Map<string, { finding_ids: string[] }>();
  for (const finding of findings) {
    const anchor = extractAnchor(finding.proof_refs);
    if (anchor === null) {
      ordered.push({ anchor: null, finding_ids: [finding.id] });
      continue;
    }
    const existing = byAnchor.get(anchor);
    if (existing) {
      existing.finding_ids.push(finding.id);
      continue;
    }
    const cluster = { anchor, finding_ids: [finding.id] };
    byAnchor.set(anchor, cluster);
    ordered.push(cluster);
  }
  // Ids are stamped after the partition so RC00N follows the order in which
  // each cluster FIRST appeared over the input array, not the order in which
  // it happened to finish filling up.
  const clusters = ordered.map((cluster, i) => ({
    id: `RC${String(i + 1).padStart(3, "0")}`,
    anchor: cluster.anchor,
    finding_ids: cluster.finding_ids,
  }));
  return { clusters, distinct_root_causes: clusters.length };
}

export function rootCauseIdByFinding(
  summary: RootCauseSummary,
): Map<string, string> {
  const byFinding = new Map<string, string>();
  for (const cluster of summary.clusters) {
    for (const findingId of cluster.finding_ids) {
      byFinding.set(findingId, cluster.id);
    }
  }
  return byFinding;
}
