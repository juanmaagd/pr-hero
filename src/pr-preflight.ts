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

// Parses the stdout of the NO-ARGUMENT `gh pr view --json number`, which gh
// resolves against the checkout's current branch — the call behind bare
// `--pr`. Same loud register as resolvePrTarget: a mis-read number would
// review a PR nobody is standing on.
export function resolveCurrentPrNumber(raw: string): number {
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
  const number = (parsed as Record<string, unknown>).number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new CliUsageError(
      `gh pr view "number" must be a positive integer, got: ` +
        JSON.stringify(number),
    );
  }
  return number;
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
//
// B3 added the head declaration: the emitted marker carries the FULL head
// sha the posted review describes, so the watch guard (watch-preflight.ts)
// can tell from the comment alone whether THIS head was already reviewed on
// another machine. Matching, though, stays on the bare prefix — comments
// already in the wild carry the old headless `<!-- pr-hero-report -->`, and
// a matcher that required the head (or the closing `-->` right after the
// name) would orphan every one of them, so --post would stack a second
// comment instead of updating. The trailing space in the prefix is
// deliberate: both formats continue with a space (` -->` / ` head=`), while
// a foreign lookalike marker such as `<!-- pr-hero-reporter -->` does not.
export const PR_COMMENT_MARKER_PREFIX = "<!-- pr-hero-report ";

export function prCommentMarker(headSha: string): string {
  return `<!-- pr-hero-report head=${headSha} -->`;
}

// Finds the comment a --post run should update. A comment matches only when
// its body STARTS WITH the marker prefix: a marker quoted mid-body (someone
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
    if (!comment.body.startsWith(PR_COMMENT_MARKER_PREFIX)) continue;
    found = comment.id;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Per-finding identity marker (ROADMAP B6) — the FIRST line of every inline
// review comment and un-anchorable issue comment pr-hero posts. It exists so
// a second run on the same PR can tell "I already posted this finding" from
// "this is new", without trusting `dedupe_key` or `root_cause_id`: both are
// derived by the hunter/dedupe pipeline fresh each run and are NOT stable
// across runs (a re-run can renumber or re-merge findings that describe the
// exact same defect). Identity here is LOCATION + OWNERSHIP — the marker
// prefix names the comment as ours, and path+line is what inline.ts's
// matcher keys on.
//
// WHY the path is percent-encoded, stated exactly: c717fe4 (size-gate.ts)
// fixed a bug from the SAME failure family — git C-quotes any path with a
// space or non-ASCII byte (`core.quotepath`), and one code path unquoted
// while a sibling did not, so a file silently vanished from one side of a
// count that was supposed to agree with the other. A raw path pasted into an
// HTML comment attribute has the identical exposure: it can contain spaces,
// `=`, `--`, or bytes that break naive re-parsing of the marker's own fields.
// Percent-encoding removes the ambiguity at the source — the SAME reason
// resolveNumstatPath/diffRecordPath route every path through unquotePath —
// rather than adding another ad-hoc unescaper that could drift from the
// encoder the way the two unquote call sites once did.
//
// `c` (first 12 hex of sha256 over the normalized claim) is a TIE-BREAKER
// only, never a requirement: claim text is regenerated by an LLM every run
// and is not expected to be byte-stable, so parseFindingMarker must still
// treat a marker with a mismatched or absent `c` as parseable — matching on
// it is inline.ts's business, not this parser's.
//
// Disjoint from PR_COMMENT_MARKER_PREFIX on purpose: both markers now live
// in the same issue-comment stream (the summary comment and per-finding
// issue comments post to the same PR), and a matcher that could mistake one
// marker family for the other would either orphan the summary comment or
// treat a per-finding comment as the summary. See the prefix-disjointness
// test in test/pr-preflight.test.ts.
export const PR_FINDING_MARKER_PREFIX = "<!-- pr-hero-finding ";

export interface FindingMarkerFields {
  path: string;
  line: number;
  headSha: string;
  // Normalized claim text this marker's `c` was derived from. Optional on
  // the encode side's caller convenience is not needed — findingMarker
  // always requires it, since `c` has no meaning without the claim it was
  // computed over.
  claim: string;
}

// First 12 hex chars of sha256(claim.trim()) — enough entropy to break a tie
// between two candidates at the same distance, nowhere near enough (nor
// intended) to be a content-addressed identity on its own.
function claimFingerprint(claim: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(claim.trim())
    .digest("hex")
    .slice(0, 12);
}

export function findingMarker(fields: FindingMarkerFields): string {
  const path = encodeURIComponent(fields.path);
  const c = claimFingerprint(fields.claim);
  return (
    `${PR_FINDING_MARKER_PREFIX}path=${path} line=${fields.line} ` +
    `head=${fields.headSha} c=${c} -->`
  );
}

export interface ParsedFindingMarker {
  path: string;
  line: number;
  headSha: string;
  // The `c` tie-breaker as stored in the marker, verbatim (not re-derived —
  // this parser has no access to the finding it once matched).
  c: string;
}

// Parses ONLY the first line of a comment body, mirroring
// findMarkedCommentId's exact-prefix contract: a marker quoted mid-body
// (someone replying with the comment pasted in) must never parse as ours.
// Returns null for anything that is not a well-formed marker rather than
// throwing — a malformed or foreign marker-shaped line is a match failure,
// not a fatal error, and the caller (the matcher) treats "unparseable" the
// same as "no prior comment": it posts fresh rather than guess.
export function parseFindingMarker(body: string): ParsedFindingMarker | null {
  if (!body.startsWith(PR_FINDING_MARKER_PREFIX)) return null;
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (!firstLine.endsWith(" -->")) return null;
  const fields = firstLine.slice(
    PR_FINDING_MARKER_PREFIX.length,
    firstLine.length - " -->".length,
  );
  const parts = new Map<string, string>();
  for (const token of fields.split(" ")) {
    if (token.length === 0) continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    parts.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const rawPath = parts.get("path");
  const rawLine = parts.get("line");
  const headSha = parts.get("head");
  const c = parts.get("c");
  if (
    rawPath === undefined ||
    rawLine === undefined ||
    headSha === undefined ||
    c === undefined
  ) {
    return null;
  }
  const line = Number.parseInt(rawLine, 10);
  if (!Number.isInteger(line)) return null;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return { path, line, headSha, c };
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
