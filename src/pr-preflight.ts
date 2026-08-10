// Everything PR mode (ROADMAP B1) must decide beyond what local mode already
// decides, expressed as pure functions so it is all testable offline — same
// contract as preflight.ts: nothing here touches the filesystem, git, gh, or
// the network. cli.ts and pr.ts are the I/O shells that act on these.
//
// PR mode splits "the repo" into two roots, and every decision below names
// the one it serves:
//   - the OPERATOR root: the --repo checkout. Runs every git and gh call,
//     owns .prhero/ resolution, anchors the run-dir default. Never reviewed.
//   - the REVIEW root: a detached worktree at the PR's head. The pipeline's
//     cwd, the tree the codegraph index describes. Never trusted for config.

import path from "node:path";
import type { Bucket, ComparisonResult, PrHeroFindingRef } from "./compare";
import type { RunStatus } from "./findings";
import type { GreptileFinding } from "./greptile";
import {
  CliError,
  CliUsageError,
  isFullCommitId,
  type NumstatDiffStat,
} from "./preflight";

export type PrState = "OPEN" | "CLOSED" | "MERGED";

// Where the base rev came from. Printed in the plan for the same reason
// BaseRefResolution.source exists: a base derived from the merge commit and
// one read off the base branch carry very different guarantees.
export type PrBaseSource = "merge-commit-parent" | "base-branch";

export interface PrTarget {
  number: number;
  title: string;
  state: PrState;
  headSha: string;
  // A rev EXPRESSION, not always a sha: for a merged PR it is
  // `<mergeCommit>^1`, canonicalized to a full sha by the shell's rev-parse
  // helper after the fetch.
  baseRef: string;
  // The branch the PR targets. The fetch needs it by name (see fetchPrRefs
  // in pr.ts), so it rides along with the resolved rev.
  baseRefName: string;
  baseSource: PrBaseSource;
  // GitHub's own counters projected into the numstat shape, so a --dry-run
  // can print a cost band before anything is fetched.
  ghDiffStat: NumstatDiffStat;
}

// Parses the raw stdout of `gh pr view <n> --json number,title,state,
// headRefOid,baseRefName,baseRefOid,mergeCommit,additions,deletions,
// changedFiles`. Every field is validated loudly and names itself when it is
// missing or mistyped: a PR record read wrong reviews a range nobody asked
// for, and gh's output is still input from outside this process.
export function resolvePrTarget(raw: string): PrTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(
      `gh pr view returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("gh pr view must return a single JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const number = readCount(record, "number");
  if (number < 1) {
    throw new CliUsageError(
      `gh pr view "number" must be positive, got: ${number}`,
    );
  }
  const title = readString(record, "title");
  const state = readString(record, "state");
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    throw new CliUsageError(
      `gh pr view "state" must be OPEN, CLOSED or MERGED, got: ` +
        JSON.stringify(state),
    );
  }
  const headSha = readSha(record, "headRefOid");
  const baseRefName = readString(record, "baseRefName");
  const ghDiffStat: NumstatDiffStat = {
    files: readCount(record, "changedFiles"),
    insertions: readCount(record, "additions"),
    deletions: readCount(record, "deletions"),
  };

  if (state === "MERGED") {
    // WHY the merge commit's FIRST PARENT and never baseRefOid: for a merged
    // PR, baseRefOid is the base branch tip as it stands TODAY — it has
    // moved past the merge, and diffing from it reproduces exactly the
    // reversed-range bug the merge-base default fixed (see resolveDiffFrom
    // in cli.ts). `mergeCommit^1` is base as it was when the PR landed, for
    // merge, squash, and rebase merges alike.
    const mergeOid = readMergeCommitOid(record);
    if (mergeOid === null) {
      // Should not happen. Guessing a base here would silently review a
      // range GitHub never showed anyone, so refuse instead.
      throw new CliError(
        `PR ${number} is MERGED but gh reports no mergeCommit — cannot ` +
          "derive the base it was merged into; refusing to guess",
      );
    }
    return {
      number,
      title,
      state,
      headSha,
      baseRef: `${mergeOid}^1`,
      baseRefName,
      baseSource: "merge-commit-parent",
      ghDiffStat,
    };
  }
  // OPEN, or CLOSED without merging: the base tip recorded on the PR is the
  // honest endpoint, and the merge-base step downstream trims it to the
  // branch point exactly as local mode does.
  return {
    number,
    title,
    state,
    headSha,
    baseRef: readSha(record, "baseRefOid"),
    baseRefName,
    baseSource: "base-branch",
    ghDiffStat,
  };
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(
      `gh pr view "${field}" must be a non-empty string, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function readSha(record: Record<string, unknown>, field: string): string {
  const value = readString(record, field);
  if (!isFullCommitId(value)) {
    throw new CliUsageError(
      `gh pr view "${field}" must be a full 40-hex commit id, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function readCount(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliUsageError(
      `gh pr view "${field}" must be a non-negative integer, got: ` +
        JSON.stringify(value),
    );
  }
  return value;
}

function readMergeCommitOid(record: Record<string, unknown>): string | null {
  const value = record.mergeCommit;
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(
      'gh pr view "mergeCommit" must be null or an object with "oid"',
    );
  }
  const oid = (value as Record<string, unknown>).oid;
  if (typeof oid !== "string" || !isFullCommitId(oid)) {
    throw new CliUsageError(
      `gh pr view "mergeCommit.oid" must be a full 40-hex commit id, got: ` +
        JSON.stringify(oid),
    );
  }
  return oid;
}

// The worktree is a SIBLING of the operator checkout, mirroring
// defaultRunRoot's naming: review trees, like run artifacts, live next to
// the repo and never inside it. One directory per PR, reused across
// re-reviews (the ensure step in pr.ts recreates it when the head moved).
export function prWorktreePath(operatorRoot: string, pr: number): string {
  const parent = path.dirname(operatorRoot);
  return path.join(
    parent,
    `${path.basename(operatorRoot)}-worktrees`,
    `pr-${pr}`,
  );
}

// PR-mode variant of runDirCandidate: the PR number leads so runs of the
// same PR sort together, and the head sha still pins WHICH bytes the run
// reviewed — a re-review after a force-push gets a new name, never a
// collision with the old evidence.
export function prRunDirCandidate(
  root: string,
  pr: number,
  headSha: string,
  n: number,
): string {
  return path.join(root, `pr-${pr}-${headSha.slice(0, 8)}-${n}`);
}

// `git status --porcelain` over the REVIEW worktree, reduced to one bit.
// `.codegraph/` entries are ignored: the index is built INTO the worktree by
// design and is always untracked there, so without this filter every
// reusable worktree would read dirty and reuse would never happen. Anything
// else — a tracked file edited during finding-verification, a stray
// untracked file — makes the tree dirty and forces a recreate: B0's
// dirty-tree lesson applied to the reuse path (uncommitted bytes would be
// reviewed but never reported).
export function worktreeDirty(porcelain: string): boolean {
  for (const line of porcelain.split("\n")) {
    if (line.trim().length === 0) continue;
    // Porcelain v1: two status characters, a space, then the path.
    const entry = line.slice(3);
    if (entry === ".codegraph" || entry.startsWith(".codegraph/")) continue;
    return true;
  }
  return false;
}

export type WorktreeAction = "create" | "reuse" | "recreate";

export interface WorktreeDecision {
  action: WorktreeAction;
  // Printed next to the action: a "recreate" without its cause reads as
  // churn, and the two causes call for different reactions from a human.
  reason: string;
}

// The reuse gate, stated once as a table so it is arguable. Recreate over
// repair on every mismatch: a worktree is disposable by construction, and
// checkout/clean surgery inside one saves nothing worth the risk of
// reviewing bytes nobody fetched.
export function decideWorktree(input: {
  exists: boolean;
  headMatches: boolean;
  dirty: boolean;
}): WorktreeDecision {
  if (!input.exists) {
    return { action: "create", reason: "no worktree for this PR yet" };
  }
  if (!input.headMatches) {
    return {
      action: "recreate",
      reason:
        "its HEAD is not the PR's head (the PR was updated or force-pushed " +
        "since the last review)",
    };
  }
  if (input.dirty) {
    return {
      action: "recreate",
      reason:
        "it has uncommitted changes beyond .codegraph/ (edits made while " +
        "verifying findings must not leak into a review)",
    };
  }
  return {
    action: "reuse",
    reason: "HEAD matches the PR head and the tree is clean",
  };
}

// The tag that makes posting idempotent (ROADMAP B2): the FIRST line of
// every comment pr-hero publishes. An HTML comment renders invisibly on
// GitHub, so readers see the report and the machine sees the tag.
// renderPrComment (report.ts) writes it; findMarkedCommentId reads it.
export const PR_COMMENT_MARKER = "<!-- pr-hero-report -->";

// Finds the comment a --post run should update. A comment matches only when
// its body STARTS WITH the marker: a marker quoted mid-body (someone
// replying with the report pasted in) must never be treated as ours. The
// LAST match wins — the API returns oldest→newest, so last is newest — and
// idempotency is find-and-update, never stack: if legacy duplicates exist we
// update the newest and leave history alone. None → null (the caller
// creates).
export function findMarkedCommentId(
  comments: { id: number; body: string }[],
): number | null {
  let found: number | null = null;
  for (const comment of comments) {
    if (typeof comment?.body !== "string") continue;
    if (!comment.body.startsWith(PR_COMMENT_MARKER)) continue;
    found = comment.id;
  }
  return found;
}

// ---------------------------------------------------------------------------
// comparison.json — the machine-readable half of the head-to-head artifact.

export interface ComparisonGreptileClaim {
  index: number;
  path: string;
  start_line: number;
  end_line: number;
  title: string;
  description: string;
}

export interface ComparisonPrHeroClaim {
  id: string;
  path: string;
  line: number;
  claim: string;
  tier: string;
}

export interface ComparisonRow {
  bucket: Bucket;
  greptile: ComparisonGreptileClaim | null;
  prhero: ComparisonPrHeroClaim | null;
  // Always null here, and present ON PURPOSE — the A3 lesson: a verdict
  // recorded without its reasoning cannot be re-examined when new evidence
  // arrives. These two columns exist to be filled by the human triage, and
  // the ledger (B4) will accumulate them across PRs.
  verdict: null;
  reasoning: null;
}

export interface ComparisonJson {
  pr: number;
  head_sha: string;
  diff_from_sha: string;
  run_dir: string;
  // ISO 8601, stamped by the I/O caller (this module owns no clock): the
  // ledger (B4) orders a PR's runs by it so the LATEST run is the one that
  // votes. Files written before this field existed are ordered by mtime.
  generated_at: string;
  // "complete" or "partial" — stamped so B4's ledger can weigh a comparison
  // by how much of the engine actually ran. (A run where EVERY hunter died
  // never reaches this file: the caller skips the comparison outright,
  // because "pr-hero 0" from a review that never happened would be recorded
  // as a measured miss.)
  run_status: RunStatus;
  // found: false is "Greptile left no comment", which must stay
  // distinguishable from "Greptile commented and reported nothing" —
  // renderComparison keeps them apart in prose, and the JSON must not
  // collapse them either.
  greptile: { found: boolean };
  rows: ComparisonRow[];
}

// A mechanical projection of the SAME ComparisonResult renderComparison
// consumes — never a second comparison pass, or the .md and the .json could
// disagree about what matched. Row order mirrors the rendering: the measured
// miss (greptile_only) leads.
export function buildComparisonJson(input: {
  pr: number;
  headSha: string;
  diffFromSha: string;
  runDir: string;
  generatedAt: string;
  runStatus: RunStatus;
  greptileFound: boolean;
  result: ComparisonResult;
}): ComparisonJson {
  const rows: ComparisonRow[] = [];
  for (const finding of input.result.greptileOnly) {
    rows.push(row("greptile_only", greptileClaim(finding), null));
  }
  for (const pair of input.result.both) {
    rows.push(
      row("both", greptileClaim(pair.greptile), prheroClaim(pair.prhero)),
    );
  }
  for (const finding of input.result.prheroOnly) {
    rows.push(row("prhero_only", null, prheroClaim(finding)));
  }
  return {
    pr: input.pr,
    head_sha: input.headSha,
    diff_from_sha: input.diffFromSha,
    run_dir: input.runDir,
    generated_at: input.generatedAt,
    run_status: input.runStatus,
    greptile: { found: input.greptileFound },
    rows,
  };
}

function row(
  bucket: Bucket,
  greptile: ComparisonGreptileClaim | null,
  prhero: ComparisonPrHeroClaim | null,
): ComparisonRow {
  return { bucket, greptile, prhero, verdict: null, reasoning: null };
}

function greptileClaim(finding: GreptileFinding): ComparisonGreptileClaim {
  return {
    index: finding.index,
    path: finding.path,
    start_line: finding.startLine,
    end_line: finding.endLine,
    title: finding.title,
    description: finding.description,
  };
}

function prheroClaim(finding: PrHeroFindingRef): ComparisonPrHeroClaim {
  return {
    id: finding.id,
    path: finding.path,
    line: finding.line,
    claim: finding.claim,
    tier: finding.tier,
  };
}
