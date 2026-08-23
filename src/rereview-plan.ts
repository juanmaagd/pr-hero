// Re-review case machine and the two-delta rule (`docs/item7-rereview-design.md`
// §3.1). Pure: git facts in, a case and a discovery plan out. The shell
// owns `merge-base --is-ancestor`, `cat-file -e`, and `diff --name-only`.
//
// Five cases over (L, H). Every failure mode falls to a full review, never
// a silently truncated delta. `--full` widens discovery for whatever case
// the PR is actually in; it never rewrites the case (R2-C5).

import { normalizePath } from "./compare";
import type { RereviewCase } from "./rereview-classify";

export type LastHeadSource = "summary_marker" | "finding_markers" | "absent";

export interface MarkerHead {
  headSha: string;
  createdAt: string;
}

export interface LastReviewedHead {
  L: string | null;
  source: LastHeadSource;
}

export interface DiscoveryPlan {
  case: RereviewCase;
  // What the hunters read as their attention anchor.
  discovery: "full" | "restricted" | "none";
  discoveryRestricted: boolean;
  skipDiscovery: boolean;
  // Empty diff is a CliError only for a first review (case A). A re-review
  // with an empty restricted delta still classifies and verifies (C6).
  emptyDeltaIsError: boolean;
  verifyAll: boolean;
}

export function resolveLastReviewedHead(input: {
  summaryHead: string | null;
  findingMarkers: readonly MarkerHead[];
}): LastReviewedHead {
  if (input.summaryHead !== null) {
    return { L: input.summaryHead, source: "summary_marker" };
  }
  const latest = latestMarkerHead(input.findingMarkers);
  if (latest === null) return { L: null, source: "absent" };
  return { L: latest, source: "finding_markers" };
}

export function decideRereviewCase(input: {
  L: string | null;
  H: string;
  // `git cat-file -e L`. Null when L is null or the probe did not run.
  objectExists: boolean | null;
  // `git merge-base --is-ancestor L H`. Null when not applicable.
  isAncestor: boolean | null;
}): RereviewCase {
  if (input.L === null) return "A";
  if (input.L === input.H) return "B";
  if (input.objectExists !== true) return "E";
  if (input.isAncestor === true) return "C";
  return "D";
}

export function planDiscovery(input: {
  case: RereviewCase;
  full: boolean;
}): DiscoveryPlan {
  const verifyAll = input.case === "D" || input.case === "E";
  const emptyDeltaIsError = input.case === "A";
  if (input.full) {
    return {
      case: input.case,
      discovery: "full",
      discoveryRestricted: false,
      skipDiscovery: false,
      emptyDeltaIsError,
      verifyAll,
    };
  }
  switch (input.case) {
    case "A":
      return {
        case: "A",
        discovery: "full",
        discoveryRestricted: false,
        skipDiscovery: false,
        emptyDeltaIsError: true,
        verifyAll: false,
      };
    case "B":
      return {
        case: "B",
        discovery: "none",
        discoveryRestricted: true,
        skipDiscovery: true,
        emptyDeltaIsError: false,
        verifyAll: false,
      };
    case "C":
      return {
        case: "C",
        discovery: "restricted",
        discoveryRestricted: true,
        skipDiscovery: false,
        emptyDeltaIsError: false,
        verifyAll: false,
      };
    case "D":
    case "E":
      return {
        case: input.case,
        discovery: "full",
        discoveryRestricted: false,
        skipDiscovery: false,
        emptyDeltaIsError: false,
        verifyAll: true,
      };
  }
}

// Discovery files: files(B..H) ∩ files(L..H). Upstream-only churn from a
// merge of main is in L..H but not B..H, so it drops out. A revert-to-base
// drops out of B..H and therefore out of discovery — touched() still sees
// it on the unrestricted L..H set (D9).
export function restrictedDiscoveryFiles(
  prFiles: readonly string[],
  deltaFiles: readonly string[],
): string[] {
  const pr = new Set(prFiles.map(normalizePath));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of deltaFiles) {
    const path = normalizePath(file);
    if (!pr.has(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  out.sort();
  return out;
}

function latestMarkerHead(markers: readonly MarkerHead[]): string | null {
  if (markers.length === 0) return null;
  let best = markers[0];
  if (best === undefined) return null;
  for (let i = 1; i < markers.length; i++) {
    const candidate = markers[i];
    if (candidate === undefined) continue;
    if (candidate.createdAt > best.createdAt) {
      best = candidate;
      continue;
    }
    if (
      candidate.createdAt === best.createdAt &&
      candidate.headSha < best.headSha
    ) {
      best = candidate;
    }
  }
  return best.headSha;
}
