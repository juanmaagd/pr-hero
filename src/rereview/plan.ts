// Re-review case machine and the two-delta rule (`docs/item7-rereview-design.md`
// §3.1). Pure: git facts in, a case and a discovery plan out. The shell
// owns `merge-base --is-ancestor`, `cat-file -e`, and `diff --name-only`.
//
// Five cases over (L, H). Every failure mode falls to a full review, never
// a silently truncated delta. `--full` widens discovery for whatever case
// the PR is actually in; it never rewrites the case (R2-C5).

import { normalizePath } from "#compare/compare";
import { listPaths } from "#git/refs";
import type { RereviewCase } from "./classify";

export type LastHeadSource = "summary_marker" | "finding_markers" | "absent";

export interface MarkerHead {
  headSha: string;
  createdAt: string;
}

export interface LastReviewedHead {
  L: string | null;
  source: LastHeadSource;
  // Rereview-coverage fix: whether the run that posted L actually
  // finished. Only ever false when `source === "summary_marker"` AND that
  // marker carried the coverage=partial token — finding-marker recovery (no
  // summary comment at all) and the absent case both mean "nothing to
  // distrust", so they are always true regardless of `summaryComplete`.
  //
  // WHY this travels WITH L rather than L being nulled out on a partial
  // marker: nulling L would make this function fall through to
  // `latestMarkerHead(findingMarkers)` below — and a partial run's own
  // inline finding markers carry the SAME head, so L would simply be
  // resurrected there and the forced-full re-review this field exists to
  // trigger would be a no-op.
  lastComplete: boolean;
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
  // Ignored when summaryHead is null — required anyway so every call site
  // must make an explicit choice rather than a silent default hiding the
  // exact "leaves the fix a no-op" trap the WHY comment above names.
  summaryComplete: boolean;
  findingMarkers: readonly MarkerHead[];
}): LastReviewedHead {
  if (input.summaryHead !== null) {
    return {
      L: input.summaryHead,
      source: "summary_marker",
      lastComplete: input.summaryComplete,
    };
  }
  const latest = latestMarkerHead(input.findingMarkers);
  if (latest === null) return { L: null, source: "absent", lastComplete: true };
  return { L: latest, source: "finding_markers", lastComplete: true };
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
// `prepareDiscovery` (rereview/prepare.ts) — the only production caller of
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

// The sibling notice for the OTHER way a re-review's L cannot be trusted
// as-is: not force-pushed away (that is `unreachableLastHeadMessage`, case
// E), but never actually finished (rereview-coverage fix). Same
// "said once, in CI and out" rule, same emission site in cli.ts — right
// where the L..H delta is about to be asked for.
export function incompleteLastReviewMessage(sha: string): string {
  return (
    `The previous review of ${sha} did not complete (at least one agent ` +
    "failed). This run reviews the full PR range and re-verifies every " +
    "prior finding."
  );
}

// GitHub #166: the THIRD way a re-review's delta can be nothing to trust "as
// is" — not force-pushed away, not incomplete, just genuinely empty. Case B
// (L === H) always lands here on the happy path, and it is not rare: a
// merged PR's head can never advance, so every local re-run of a merged PR
// is case B. Discovery correctly runs zero DISCOVERY hunters — there is
// nothing new to read — but the OLD behavior said nothing about that on the
// CLI/CI log, and the PR comment (`cleanBillLine`, review/report.ts) read the
// resulting empty findings array as "reviewed and found nothing", a $0/0s run
// overwriting a real prior summary with a false clean bill. Fired for ANY
// case whose discovery came up empty (case B, or case C's restricted delta
// touching none of the PR's own files) — `resolvePrDiscovery` (pr/discovery.ts)
// sets `discovery_skipped_empty_delta` on that same broader condition, and a
// reader deserves the same disclosure regardless of which case produced it.
//
// pr-hero review #286 findings, both about this function specifically:
//
// 1. "No changes... since the last completed review" was flatly wrong for
//    the OTHER way discovery comes up empty: a real, non-empty delta whose
//    every file was excluded by the size gate / `.prheroignore`
//    (`filterDiffByIgnoreRules`'s `droppedPaths`). That case gets its own
//    sentence, naming what was excluded — never "no changes".
// 2. "No hunter ran... not re-verified now" said "hunter" for a claim only
//    true of DISCOVERY hunters, and asserted verification would NOT happen —
//    false whenever case B's `applied`/`case_b_reply` triggers or case C's
//    `touched()` (rereview/classify.ts) queued a prior for the SAME pass's
//    verifier. The caller (`pr/discovery.ts`) now computes this message only
//    after that queue is built, so `queuedForVerification` is always the
//    real count, never a guess made before the queue existed.
export function skippedDiscoveryMessage(input: {
  headSha: string;
  reason: "no_delta" | "all_excluded";
  excludedPaths: readonly string[];
  queuedForVerification: number;
  // pr-hero on #286: the Phase B queue is capped downstream at
  // max_verification_steps (capVerificationQueue, rereview/verify.ts); the
  // priors past the cap are marked unconfirmed, never re-verified. The notice
  // states the capped number, never the raw queue length.
  maxVerificationSteps: number;
}): string {
  const discoverySentence =
    input.reason === "all_excluded"
      ? `Every changed file at ${input.headSha} was excluded from review ` +
        `(${listPaths([...input.excludedPaths])}), so the effective diff is empty.`
      : `No changes to discover at ${input.headSha} since the last completed review.`;
  const hunterSentence = "No discovery hunter ran this pass.";
  const verified = Math.min(
    input.queuedForVerification,
    Math.max(0, input.maxVerificationSteps),
  );
  const capped = input.queuedForVerification - verified;
  const verifySentence =
    verified > 0
      ? `${verified} prior finding` +
        `${verified === 1 ? " is" : "s are"} re-verified this pass` +
        (capped > 0
          ? `; ${capped} more ${capped === 1 ? "stays" : "stay"} unconfirmed (max_verification_steps ${input.maxVerificationSteps}).`
          : ".")
      : capped > 0
        ? `No prior finding is re-verified this pass; ${capped} ${capped === 1 ? "stays" : "stay"} unconfirmed (max_verification_steps ${input.maxVerificationSteps}).`
        : "No prior finding is queued for re-verification this pass.";
  return `${discoverySentence} ${hunterSentence} ${verifySentence}`;
}

export function planDiscovery(input: {
  case: RereviewCase;
  full: boolean;
  // Rereview-coverage fix: false forces the SAME full-discovery
  // path `full: true` takes, PLUS verifyAll — because an incomplete prior
  // run may be exactly the refuter failing, so prior findings cannot be
  // trusted as merely "carried" the way a clean case B/C would carry them.
  // This never rewrites `case` (R2-C5's rule: widening discovery never
  // rewrites the case) — case stays whatever decideRereviewCase decided.
  lastComplete: boolean;
}): DiscoveryPlan {
  const caseVerifyAll = input.case === "D" || input.case === "E";
  const forcedByIncompleteness = !input.lastComplete;
  const emptyDeltaIsError = input.case === "A";
  if (input.full || forcedByIncompleteness) {
    return {
      case: input.case,
      discovery: "full",
      discoveryRestricted: false,
      skipDiscovery: false,
      emptyDeltaIsError,
      verifyAll: caseVerifyAll || forcedByIncompleteness,
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
