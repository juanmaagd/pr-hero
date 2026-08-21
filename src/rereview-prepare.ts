// Impure-half orchestration for item 7 discovery (`docs/item7-rereview-design.md`
// §3.1). Git facts arrive through `RereviewGit` so the CLI owns `cat-file`,
// `merge-base --is-ancestor`, and `diff --name-only`, and tests inject fakes.
// The case machine itself stays in rereview-plan.ts.

import type { RereviewCase } from "./rereview-classify";
import {
  type DiscoveryPlan,
  decideRereviewCase,
  type LastHeadSource,
  type LastReviewedHead,
  type MarkerHead,
  planDiscovery,
  resolveLastReviewedHead,
  restrictedDiscoveryFiles,
} from "./rereview-plan";

export interface RereviewGit {
  commitExists(sha: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  nameOnly(from: string, to: string): Promise<string[]>;
}

export interface PreparedDiscovery {
  last: LastReviewedHead;
  case: RereviewCase;
  plan: DiscoveryPlan;
  // Null: unrestricted B..H (hunters see the full PR range). Empty: skip
  // discovery — no files in the restricted intersection, or case B.
  discoveryPaths: string[] | null;
  discoveryFrom: string;
  discoveryTo: string;
  discoverySkippedEmptyDelta: boolean;
}

export interface RereviewProvenance {
  case: RereviewCase;
  last_reviewed_head: string | null;
  last_head_source: LastHeadSource;
  discovery_range: string;
  discovery_restricted: boolean;
  discovery_skipped_empty_delta: boolean;
  prior_findings: number;
  settled_deterministically: number;
  verified: number;
  verification_capped: number;
  verification_triggers: {
    applied: number;
    touched: number;
    overlap: number;
    verify_all: number;
  };
  live: readonly unknown[];
}

export function parseNameOnly(stdout: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const path = line.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  out.sort();
  return out;
}

export function shouldAbortEmptyDiscovery(
  plan: DiscoveryPlan,
  patch: string,
): boolean {
  return plan.emptyDeltaIsError && patch.trim().length === 0;
}

export async function prepareDiscovery(input: {
  B: string;
  H: string;
  full: boolean;
  summaryHead: string | null;
  findingMarkers: readonly MarkerHead[];
  git: RereviewGit;
}): Promise<PreparedDiscovery> {
  const last = resolveLastReviewedHead({
    summaryHead: input.summaryHead,
    findingMarkers: input.findingMarkers,
  });
  let objectExists: boolean | null = null;
  let isAncestor: boolean | null = null;
  if (last.L !== null) {
    objectExists = await input.git.commitExists(last.L);
    if (objectExists) {
      isAncestor = await input.git.isAncestor(last.L, input.H);
    }
  }
  const rereviewCase = decideRereviewCase({
    L: last.L,
    H: input.H,
    objectExists,
    isAncestor,
  });
  const plan = planDiscovery({ case: rereviewCase, full: input.full });

  if (plan.skipDiscovery) {
    const from = last.L ?? input.B;
    return {
      last,
      case: rereviewCase,
      plan,
      discoveryPaths: [],
      discoveryFrom: from,
      discoveryTo: input.H,
      discoverySkippedEmptyDelta: true,
    };
  }

  if (plan.discovery !== "restricted" || last.L === null) {
    return {
      last,
      case: rereviewCase,
      plan,
      discoveryPaths: null,
      discoveryFrom: input.B,
      discoveryTo: input.H,
      discoverySkippedEmptyDelta: false,
    };
  }

  const [prFiles, deltaFiles] = await Promise.all([
    input.git.nameOnly(input.B, input.H),
    input.git.nameOnly(last.L, input.H),
  ]);
  const discoveryPaths = restrictedDiscoveryFiles(prFiles, deltaFiles);
  return {
    last,
    case: rereviewCase,
    plan,
    discoveryPaths,
    discoveryFrom: last.L,
    discoveryTo: input.H,
    discoverySkippedEmptyDelta: discoveryPaths.length === 0,
  };
}

// First review (case A) carries no block at all (W-prov). Counts that the
// verify spawn has not filled yet stay zero rather than omitted — an
// artifact that cannot name its case is unscorable; zeros are still a case.
export function toRereviewProvenance(
  prepared: PreparedDiscovery,
  priorFindings = 0,
): RereviewProvenance | undefined {
  if (prepared.case === "A") return undefined;
  return {
    case: prepared.case,
    last_reviewed_head: prepared.last.L,
    last_head_source: prepared.last.source,
    discovery_range: `${prepared.discoveryFrom}..${prepared.discoveryTo}`,
    discovery_restricted: prepared.plan.discoveryRestricted,
    discovery_skipped_empty_delta: prepared.discoverySkippedEmptyDelta,
    prior_findings: priorFindings,
    settled_deterministically: 0,
    verified: 0,
    verification_capped: 0,
    verification_triggers: {
      applied: 0,
      touched: 0,
      overlap: 0,
      verify_all: 0,
    },
    live: [],
  };
}
