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

// What the re-review's Phase B gate may ask git for, given the case the
// machine landed in. `unreachable` is the force-push case, and it is the whole
// reason this decision is a function instead of an inline condition.
//
// A rebase of a stacked PR orphans the previously-reviewed head L recorded in
// the `<!-- pr-hero-state head=... -->` marker on the PR. A CI runner's fresh
// clone never fetched that object, so `git diff --name-status L..H` dies with
// "Invalid revision range" and takes the entire review down with it. Case E
// already plans a FULL review for exactly this situation — but the gate that
// guarded the L..H delta asked only "is this a first review?", a question case
// E answers "no", so it ran the diff anyway. Found by pr-hero's own Action on
// PR #68 (2026-08-25): red in 8 seconds, and rebasing is routine.
//
// Reachability is read off the case rather than re-probed: inside
// `prepareDiscovery` (rereview-prepare.ts) — the only production caller of
// `decideRereviewCase`, and one that always runs `git cat-file -e L^{commit}`
// when L is non-null — case "E" means exactly "L is non-null and that probe
// said no".
export type LastHeadDelta =
  | { kind: "none" }
  | { kind: "diff"; from: string }
  | { kind: "unreachable"; sha: string };

export function decideLastHeadDelta(input: {
  case: RereviewCase;
  L: string | null;
}): LastHeadDelta {
  if (input.case === "A" || input.L === null) return { kind: "none" };
  if (input.case === "E") return { kind: "unreachable", sha: input.L };
  return { kind: "diff", from: input.L };
}

// Degrading silently would be indistinguishable from a review that was always
// full, which is how a truncated re-review hides. Said once, in CI and out.
export function unreachableLastHeadMessage(sha: string): string {
  return (
    `The previously-reviewed commit ${sha} is not present in this clone ` +
    "(very likely a force-push or rebase). This run is a full review of the " +
    "PR range rather than a delta, and every prior finding is re-verified."
  );
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
