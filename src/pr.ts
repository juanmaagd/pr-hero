// PR mode's I/O (ROADMAP B1): gh, the fetch, the detached worktree, the
// worktree's codegraph index, and the Greptile comparison files — every side
// effect `pr-hero review --pr <n>` needs beyond what cli.ts already owns.
// Same contract as cli.ts: this is an I/O shell, and every decision it acts
// on is a pure function in pr-preflight.ts / inline.ts (or preflight.ts),
// where most of the tests live.
//
// ROADMAP B6 exception, spelled out because it changes the file's own
// header claim: the review-submission functions below (`postPrReview`,
// `postIssueComment`, `fetchPrReviewComments`, `fetchPostedFindingComments`)
// ARE offline-tested, in test/pr.test.ts, via an injectable `spawnFn` on the
// internal `gh()` helper — the 422 recovery path is exactly the kind of
// branch that must never rest on "we'll catch it live".
//
// Every git and gh call here runs with the OPERATOR root as cwd — gh talks
// to GitHub, and the operator checkout is the trust anchor — EXCEPT the
// object-db git that owns the review worktree (fetchPrRefs, ensureWorktree)
// and the two read-only inspections of the worktree itself. W3: `git
// worktree add` is bound to one git dir, the registered owner for that
// origin, which may not be the operator cwd.

import { existsSync } from "node:fs";
import path from "node:path";
import {
  type ComparisonResult,
  compareFindings,
  type PrHeroFindingRef,
} from "./compare";
import { renderComparison } from "./compare-report";
import type { Finding, RunStatus } from "./findings";
import { parseGreptileComment, pickGreptileComment } from "./greptile";
import { matchPostedFindings, type PostedFindingComment } from "./inline";
import {
  buildComparisonJson,
  decideWorktree,
  findMarkedCommentId,
  parseFindingMarker,
  type WorktreeDecision,
  worktreeDirty,
} from "./pr-preflight";
import { CliError } from "./preflight";
import { renderInlineComment, renderIssueFindingComment } from "./report";

// Same helper as cli.ts's git, duplicated rather than shared so neither
// shell imports the other. The WHY carries over verbatim: args as an ARRAY,
// never an interpolated shell string — refs and paths reach git verbatim,
// and a shell in the middle would turn them into an execution surface.
async function git(
  repo: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

// `spawnFn` is the ONLY seam this module adds for testability, and it is
// deliberately invisible to production callers: every existing call site
// omits it and gets `Bun.spawn` exactly as before. Only test/pr.test.ts
// passes one, to script gh's response (including a 422) without a live PR.
// The `Bun.which("gh")` guard is skipped under a fake spawn on purpose — a
// real environment missing `gh` must still fail loud, but an offline test
// must never depend on whether the machine RUNNING it happens to have `gh`
// installed, or the suite becomes non-hermetic for a reason that has
// nothing to do with the behavior under test.
async function gh(
  operatorRoot: string,
  args: string[],
  stdin?: string,
  spawnFn?: typeof Bun.spawn,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const spawn = spawnFn ?? Bun.spawn;
  // A missing gh must name itself: Bun.spawn's error for a binary that is
  // not there reads like a crash, not like "install the GitHub CLI".
  if (spawnFn === undefined && Bun.which("gh") === null) {
    throw new CliError(
      "gh not found on PATH — PR mode resolves the PR through the GitHub " +
        "CLI. Install it and authenticate (gh auth login) first.",
    );
  }
  // cwd = operator root: gh resolves owner/repo from the checkout's remote,
  // so the PR consulted always belongs to the repo passed as --repo — same
  // reasoning as scripts/compare-pr.ts.
  //
  // stdin carries a field value when the caller passes `-F key=@-` (gh reads
  // `@-` from stdin; verified against `gh api --help`, 2026-08-10): a report
  // body on stdin dodges ARG_MAX and needs no shell-quoting, because there
  // is no shell anywhere in this call.
  const proc = spawn(["gh", ...args], {
    cwd: operatorRoot,
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

// The contract between this call and the pure resolvePrTarget, which parses
// exactly these fields; change them together.
export const PR_VIEW_JSON_FIELDS =
  "number,title,state,headRefOid,baseRefName,baseRefOid,mergeCommit," +
  "additions,deletions,changedFiles";

export async function ghPrView(
  operatorRoot: string,
  pr: number,
): Promise<string> {
  const result = await gh(operatorRoot, [
    "pr",
    "view",
    String(pr),
    "--json",
    PR_VIEW_JSON_FIELDS,
  ]);
  if (!result.ok) {
    throw new CliError(`gh pr view ${pr} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// The NO-ARGUMENT `gh pr view`: gh resolves the PR belonging to the
// checkout's current branch, which is the whole feature behind bare `--pr`
// — "review the PR I am standing on". Returns raw stdout for the pure
// resolveCurrentPrNumber; a branch with no PR fails loud, with gh's own
// message appended because it names the branch.
export async function ghCurrentBranchPr(
  operatorRoot: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<string> {
  const result = await gh(
    operatorRoot,
    ["pr", "view", "--json", "number"],
    undefined,
    options?.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `no PR found for the current branch of ${operatorRoot} — open one ` +
        "first or pass --pr <n> explicitly" +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : ""),
    );
  }
  return result.stdout;
}

// The open-PR listing the watch tick (B3) candidates from. Raw stdout for
// the pure parsePrList — same contract as ghPrView/resolvePrTarget. An
// explicit --limit, because gh's default caps the list at 30 NEWEST PRs:
// the watcher picks the LOWEST eligible number (FIFO), and a busy repo's
// oldest open PRs falling off the list would be exactly the silent
// truncation the comments fetch already learned to avoid with --paginate.
// additions/deletions/changedFiles ride along FREE: gh returns them in the
// same list response, and they are the watcher's zero-extra-call first tier
// for the size gate (see gatherRepoFacts). Verified against `gh pr list
// --json` on 2026-08-11 — all three are real list fields, alongside the
// per-file `files`, which is deliberately NOT requested here: it would make
// every tick carry the full file list of every open PR.
export const PR_LIST_JSON_FIELDS =
  "number,headRefOid,isDraft,additions,deletions,changedFiles";
export const PR_LIST_LIMIT = 200;

export async function ghPrList(operatorRoot: string): Promise<string> {
  const result = await gh(operatorRoot, [
    "pr",
    "list",
    "--limit",
    String(PR_LIST_LIMIT),
    "--json",
    PR_LIST_JSON_FIELDS,
  ]);
  if (!result.ok) {
    throw new CliError(`gh pr list failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// The repository's web URL (https://github.com/org/repo), used only to turn
// the PR comment's locations into links. Cosmetic by contract: ANY failure
// returns undefined and the comment renders plain — a review must never die,
// or even warn loudly, because a nicety could not be resolved.
// The size gate's SECOND tier, and only for a PR whose aggregate already
// exceeds a limit: the per-file list, so an exclusion (a regenerated
// lockfile, a minified bundle) can still rescue it. One gh call per such PR
// — the same "pay per candidate, only when the free check did not settle
// it" shape the comments fetch already uses.
//
// Field names verified live against `gh pr view <n> -R cli/cli --json files`
// on 2026-08-11: `{"files":[{"path":…,"additions":…,"deletions":…,
// "changeType":…}]}`.
export async function ghPrFiles(
  operatorRoot: string,
  pr: number,
): Promise<string> {
  const result = await gh(operatorRoot, [
    "pr",
    "view",
    String(pr),
    "--json",
    "files",
  ]);
  if (!result.ok) {
    throw new CliError(
      `gh pr view ${pr} --json files failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

// The PR's head AS GITHUB SEES IT RIGHT NOW — the re-read behind the
// moved-head disclosure (GitHub #39, ROADMAP-DOORDASH M1). Deliberately a
// separate, narrow call rather than reusing ghPrView: this runs in the
// posting sequence, milliseconds before a mutating POST, and the one field
// it needs is the one field it asks for.
//
// NON-THROWING, same cosmetic-degradation contract as ghRepoWebUrl above,
// and the WHY is the load-bearing part: `commit_id` on the review submission
// is the CORRECTNESS mechanism — with it, GitHub anchors every comment to
// the reviewed commit whatever the branch has done since. This re-read is
// only the DISCLOSURE on top of it. A disclosure that cannot be made must
// never cost the post that the pin already protects, so a gh failure (rate
// limit, transient 5xx, a repo the token lost access to) degrades to "we do
// not know", never to a thrown run. Empty stdout is treated as failure for
// the same reason `-q` on a deleted PR prints nothing: an empty string is
// not a sha, and comparing it against the reviewed head would manufacture a
// mismatch out of a missing answer.
export async function ghPrHeadSha(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<string | undefined> {
  try {
    const result = await gh(
      operatorRoot,
      ["pr", "view", String(pr), "--json", "headRefOid", "-q", ".headRefOid"],
      undefined,
      options?.spawnFn,
    );
    if (!result.ok) return undefined;
    const sha = result.stdout.trim();
    return sha === "" ? undefined : sha;
  } catch {
    return undefined;
  }
}

export async function ghRepoWebUrl(
  operatorRoot: string,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<string | undefined> {
  try {
    const result = await gh(
      operatorRoot,
      ["repo", "view", "--json", "url", "-q", ".url"],
      undefined,
      options?.spawnFn,
    );
    if (!result.ok) return undefined;
    const url = result.stdout.trim();
    return url === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

// WHY this exact refspec pair (paid-for): a merged PR's branch is usually
// deleted, so nothing but `refs/pull/<n>/head` keeps headRefOid fetchable —
// and fetching the base branch by name in the same call brings the merge
// commit and the baseRefOid ancestry along, so every rev the flow
// canonicalizes afterwards resolves against a single fetch.
export async function fetchPrRefs(
  gitDirOwner: string,
  pr: number,
  baseRefName: string,
): Promise<void> {
  const result = await git(gitDirOwner, [
    "fetch",
    "origin",
    `refs/pull/${pr}/head`,
    baseRefName,
  ]);
  if (!result.ok) {
    throw new CliError(
      `git fetch origin refs/pull/${pr}/head ${baseRefName} failed: ` +
        result.stderr.trim(),
    );
  }
}

// Create, reuse, or recreate the detached worktree at the PR's head. The
// decision itself is pure (decideWorktree); this runs the inspections that
// feed it and the git plumbing that enacts it.
export async function ensureWorktree(
  gitDirOwner: string,
  worktreePath: string,
  headSha: string,
): Promise<WorktreeDecision> {
  // Prune first: a worktree deleted by hand leaves a stale registration
  // behind, and a stale registration makes the add below refuse.
  const pruned = await git(gitDirOwner, ["worktree", "prune"]);
  if (!pruned.ok) {
    throw new CliError(`git worktree prune failed: ${pruned.stderr.trim()}`);
  }
  const exists = existsSync(worktreePath);
  let headMatches = false;
  let dirty = false;
  if (exists) {
    const head = await git(worktreePath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    headMatches = head.ok && head.stdout.trim() === headSha;
    if (headMatches) {
      const status = await git(worktreePath, ["status", "--porcelain"]);
      if (!status.ok) {
        throw new CliError(
          `git status failed in worktree ${worktreePath}: ` +
            status.stderr.trim(),
        );
      }
      dirty = worktreeDirty(status.stdout);
    }
  }
  const decision = decideWorktree({ exists, headMatches, dirty });
  if (decision.action === "recreate") {
    // --force is REQUIRED, and never rm -rf (VERIFIED 2026-08-10): a plain
    // `worktree remove` exits 128 on the untracked .codegraph/, and rm -rf
    // would yank .codegraph/daemon.sock out from under a live codegraph
    // daemon instead of letting git detach the tree cleanly.
    const removed = await git(gitDirOwner, [
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    if (!removed.ok) {
      throw new CliError(
        `git worktree remove --force ${worktreePath} failed: ` +
          removed.stderr.trim(),
      );
    }
    const reprune = await git(gitDirOwner, ["worktree", "prune"]);
    if (!reprune.ok) {
      throw new CliError(`git worktree prune failed: ${reprune.stderr.trim()}`);
    }
  }
  if (decision.action !== "reuse") {
    const added = await git(gitDirOwner, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      headSha,
    ]);
    if (!added.ok) {
      throw new CliError(
        `git worktree add --detach ${worktreePath} ${headSha} failed: ` +
          added.stderr.trim(),
      );
    }
  }
  return decision;
}

// Builds the worktree's OWN index — never another checkout's, whose bytes
// may differ (the ROADMAP forbids riding a sibling's index). Synchronous by
// design: the initial build is ~10s/~68MB (measured 8x in the bench), and a
// pipeline started before the index exists would run its hunters with an
// inert codegraph grant. The measured elapsed feeds telemetry.index_ms,
// which local mode hardcodes to 0 because it never builds anything.
export async function initCodegraphIndex(
  worktreePath: string,
): Promise<number> {
  const started = performance.now();
  const proc = Bun.spawn(["codegraph", "init", worktreePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new CliError(
      `codegraph init ${worktreePath} failed: ${stderr.trim()}`,
    );
  }
  return Math.round(performance.now() - started);
}

export interface ComparisonOutcome {
  greptileFound: boolean;
  greptileOnly: number;
  both: number;
  prheroOnly: number;
  markdownPath: string;
  jsonPath: string;
  // The whole bucketing, not just its cardinalities. writeComparison already
  // computes this to write comparison.md; discarding it left the terminal
  // structurally unable to say anything but numbers, and `greptileOnly` is
  // THE measured number — "a recall miss with a name, a file and a line"
  // (compare.ts). IN-MEMORY ONLY: comparison.json's bytes are unchanged, and
  // must stay so — the ledger reads them back through StoredComparison.
  result: ComparisonResult;
}

// The in-process replacement for scripts/compare-pr.ts, run against the
// findings this review just produced. Throws on any gh failure — the CALLER
// decides that a comparison failure must not fail the run, because the
// review artifacts are already on disk and are the product.
export async function writeComparison(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  diffFromSha: string;
  runDir: string;
  generatedAt: string;
  runStatus: RunStatus;
  findings: PrHeroFindingRef[];
}): Promise<ComparisonOutcome> {
  const comments = await fetchPrComments(input.operatorRoot, input.pr);
  const body = pickGreptileComment(comments);
  const greptile = body === null ? [] : parseGreptileComment(body);
  const result = compareFindings(input.findings, greptile);
  const markdownPath = path.join(input.runDir, "comparison.md");
  const jsonPath = path.join(input.runDir, "comparison.json");
  await Bun.write(markdownPath, renderComparison(input.pr, result));
  await Bun.write(
    jsonPath,
    `${JSON.stringify(
      buildComparisonJson({
        pr: input.pr,
        headSha: input.headSha,
        diffFromSha: input.diffFromSha,
        runDir: input.runDir,
        generatedAt: input.generatedAt,
        runStatus: input.runStatus,
        greptileFound: body !== null,
        result,
      }),
      null,
      2,
    )}\n`,
  );
  return {
    greptileFound: body !== null,
    greptileOnly: result.greptileOnly.length,
    both: result.both.length,
    prheroOnly: result.prheroOnly.length,
    markdownPath,
    jsonPath,
    result,
  };
}

// Publishes the review as ONE marked PR comment: update the existing marked
// comment when there is one, create it otherwise. Idempotency lives in the
// marker contract (prCommentMarker as the body's first line, matched by
// findMarkedCommentId on the bare prefix) — a re-run refreshes the same
// comment instead of stacking a new one per run. Throws CliError on any gh
// failure and is NOT
// caught here: the caller asked for a public side effect, so the caller
// decides what a failed one means.
// ROADMAP B6 addition: `spawnFn`, same invisible-to-production seam as the
// other B6 functions (see gh()'s WHY). Needed so test/cli.test.ts can drive
// the WHOLE step-14 sequence — review, Outside Diff in the summary, summary
// PATCH LAST —
// through one shared fake gh, the same way test/pr.test.ts already does for
// the per-finding functions; a summary PATCH the caller-level test could not
// see would leave the "PATCHed last" ordering unpinned.
//
// `knownCommentId` (create-first rework, Juanma's PR #2 feedback item 2):
// when the caller already knows the comment id — because IT just created
// the comment moments ago in this same run, and now wants the closing
// PATCH — skip the re-fetch-and-find-by-marker lookup entirely and PATCH
// that id directly. Without this, the closing PATCH would re-discover the
// comment via `findMarkedCommentId`, which is both a wasted round-trip
// (the id is already known) and, in a NO-op fake spawn, indistinguishable
// from "no comment exists yet" — silently creating a SECOND comment instead
// of patching the first. Omitted (the ordinary re-run path, where the
// existing comment came from a PREVIOUS run, not this one), the lookup runs
// exactly as before.
export async function postPrComment(
  operatorRoot: string,
  pr: number,
  body: string,
  spawnFn?: typeof Bun.spawn,
  knownCommentId?: number,
): Promise<{ action: "created" | "updated"; commentId: number }> {
  const existingId =
    knownCommentId ??
    findMarkedCommentId(await fetchPrComments(operatorRoot, pr, { spawnFn }));
  const action = existingId === null ? "created" : "updated";
  // The body travels on stdin via `-F body=@-` (see gh()); PATCH updates the
  // found comment in place, POST creates the first one.
  const result =
    existingId === null
      ? await gh(
          operatorRoot,
          [
            "api",
            "--method",
            "POST",
            `repos/{owner}/{repo}/issues/${pr}/comments`,
            "-F",
            "body=@-",
          ],
          body,
          spawnFn,
        )
      : await gh(
          operatorRoot,
          [
            "api",
            "--method",
            "PATCH",
            `repos/{owner}/{repo}/issues/comments/${existingId}`,
            "-F",
            "body=@-",
          ],
          body,
          spawnFn,
        );
  if (!result.ok) {
    throw new CliError(
      `gh api (${action} PR comment) failed: ${result.stderr.trim()}`,
    );
  }
  // gh api prints the API's response object; its .id names the comment this
  // run touched, which the summary reports for later verification by hand.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const commentId = (parsed as { id?: unknown } | null)?.id;
  if (typeof commentId !== "number") {
    throw new CliError(
      `gh api ${action} a PR comment but returned no comment id: ` +
        result.stdout.slice(0, 120),
    );
  }
  return { action, commentId };
}

// Mirror of scripts/compare-pr.ts's fetch, kept shape-identical on purpose.
// --paginate matters: a busy PR accumulates enough comments to push
// Greptile's off page 1, and a missing comment looks identical to "Greptile
// found nothing" — the exact failure mode that would silently flatter
// pr-hero. API order is preserved verbatim (no sort, no reverse):
// pickGreptileComment reads "newest" as LAST.
//
// Exported since B3: the watch guard reads the same comments to learn which
// heads a pr-hero marker already declares (watch.ts imports this one-way;
// pr.ts never imports watch.ts, so the no-mutual-shells rule holds).
export async function fetchPrComments(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<{ id: number; user: string; body: string }[]> {
  const result = await gh(
    operatorRoot,
    [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      "--jq",
      ".[] | {id: .id, user: .user.login, body: .body}",
    ],
    undefined,
    options?.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api issues/${pr}/comments failed: ${result.stderr.trim()}`,
    );
  }
  // `--jq` streams one JSON object per line.
  const comments: { id: number; user: string; body: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      comments.push(
        JSON.parse(line) as { id: number; user: string; body: string },
      );
    } catch {
      throw new CliError(`unparseable line from gh api: ${line.slice(0, 120)}`);
    }
  }
  return comments;
}

// ---------------------------------------------------------------------------
// Inline review surface (ROADMAP B6, WU4/WU5) — the fetcher, the atomic
// review submission with its 422 recovery, and the per-finding issue
// comment. inline.ts plans WHAT to post (pure); everything below executes
// that plan and is the only place in the engine allowed to.

// Review-level (inline) comments, as opposed to fetchPrComments's top-level
// issue comments — a DIFFERENT GitHub endpoint (`pulls/<n>/comments`, not
// `issues/<n>/comments`). Shape-identical to fetchPrComments on purpose
// (same --paginate + --jq style, same loud parse failure): the two fetchers
// read two different comment streams the same way, so a bug in one parsing
// discipline is not a bug the other could hide.
//
// `in_reply_to_id` is what `pr-hero triage reply` uses to bind a triage
// response to its finding thread (W1). The finder still only needs
// `path`/`line` plus the marker; projecting the reply-to id here costs
// nothing and means the bind path does not make a second fetch shape.
export interface PrReviewComment {
  id: number;
  user: string;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  in_reply_to_id: number | null;
}

export async function fetchPrReviewComments(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<PrReviewComment[]> {
  const result = await gh(
    operatorRoot,
    [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/pulls/${pr}/comments`,
      "--jq",
      ".[] | {id: .id, user: .user.login, body: .body, path: .path, " +
        "line: .line, original_line: .original_line, " +
        "in_reply_to_id: .in_reply_to_id}",
    ],
    undefined,
    options?.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api pulls/${pr}/comments failed: ${result.stderr.trim()}`,
    );
  }
  const comments: PrReviewComment[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      comments.push(JSON.parse(line) as PrReviewComment);
    } catch {
      throw new CliError(`unparseable line from gh api: ${line.slice(0, 120)}`);
    }
  }
  return comments;
}

// Both channels pr-hero's own per-finding comments can live in, reduced to
// inline.ts's PostedFindingComment shape. A comment that does not parse as a
// finding marker is silently excluded — this is where the two marker
// prefixes' disjointness (pr-preflight.ts) actually pays for itself: the
// summary comment's `<!-- pr-hero-report ` marker never parses as a
// `<!-- pr-hero-finding ` one, so it drops out of this list without any
// special-casing, and a human's reply (any shape) drops out the same way.
export async function fetchPostedFindingComments(
  operatorRoot: string,
  pr: number,
  options?: { spawnFn?: typeof Bun.spawn },
): Promise<PostedFindingComment[]> {
  const [reviewComments, issueComments] = await Promise.all([
    fetchPrReviewComments(operatorRoot, pr, options),
    fetchPrComments(operatorRoot, pr, options),
  ]);
  const out: PostedFindingComment[] = [];
  for (const comment of reviewComments) {
    const marker = parseFindingMarker(comment.body);
    if (marker === null) continue;
    out.push({
      id: comment.id,
      channel: "review",
      marker,
      livePath: comment.path,
      liveLine: comment.line ?? undefined,
    });
  }
  for (const comment of issueComments) {
    const marker = parseFindingMarker(comment.body);
    if (marker === null) continue;
    out.push({ id: comment.id, channel: "issue", marker });
  }
  return out;
}

// gh api prints "<message> (HTTP <code>)" on stderr for any non-2xx
// response. Matching only the status code — never the message, which
// GitHub varies by cause ("Unprocessable Entity", or a specific field
// error) — is what lets the SAME recovery apply whether the rejection is
// "this comment could not anchor" or "you already have a pending review"
// (a leftover from a prior crashed run): the spec explicitly rules out
// reason-string special-casing (design D1), because GitHub's 422 body does
// not reliably name which comment failed.
function is422(stderr: string): boolean {
  return /\(HTTP 422\)/.test(stderr);
}

export interface ReviewSubmissionOutcome {
  // "posted": every finding in `findings` is now in the one review.
  // "demoted": the review was rejected (422); `findings` is the subset of
  //   the ORIGINAL submission still classified fresh after a FULL re-match —
  //   the caller puts these in the summary Outside Diff bucket (issues
  //   #16/#17) instead of posting them as issue comments.
  //
  // WHY a full re-match, not a re-match over `findings` alone (CRIT-A,
  // verify-report-pr3 #3305 — the bug the previous `consumedCommentIds`
  // design left in place): matchPostedFindings is one-to-one only across the
  // finding list it is handed. Re-running it over `findings` — a SUBSET of
  // what buildPostPlan matched in the first place — can DISSOLVE A TIE: a
  // comment the full plan adjudicated to some OTHER, already-persisting
  // finding becomes the sole remaining candidate here and silently swallows
  // a genuinely new finding, even though the plan itself resolved that exact
  // tie by posting fresh. Re-matching the FULL finding list (`allFindings`,
  // the exact set the plan matched) against the fresh fetch reproduces the
  // plan's own adjudication byte-for-byte whenever GitHub created nothing —
  // the common case, since a 422 means the review was never persisted — and
  // diverges from it only where GitHub genuinely created something between
  // the plan and this call, which is the only case the recovery should
  // differ in at all. Tie- and order-independent by construction: unlike the
  // old subset-and-exclude approach, nothing here depends on which findings
  // happened to be excluded first.
  outcome: "posted" | "demoted";
  findings: Finding[];
}

// The one atomic review submission (spec "One review submission for
// anchorable findings"), plus its 422 recovery (spec "GitHub is the anchor
// authority", design D1). `findings` is the plan's `reviewComments` — the
// set inline.ts already classified anchorable AND unmatched to a prior
// comment; an empty set never reaches gh at all (spec "Zero anchorable
// findings": an empty `comments[]` review is never sent).
//
// WHY re-fetch-and-rematch, not fail-loud, not parse-and-retry-the-offender,
// not N separate POSTs (design D1, rejected alternatives kept here because
// they will keep sounding reasonable to the next person who reads this):
// fail-loud means a review that already cost real hunter/refuter money says
// NOTHING on the PR — the worst outcome available. Parsing the 422 to retry
// only the offending comment assumes GitHub's error body names it reliably;
// it does not (verified against `gh api` 2026-08-10 — the response is a
// generic "Unprocessable Entity" with, at best, a field-level error array
// that does not carry the comments[] index). N separate
// `POST pulls/<n>/comments` calls trade the one atomicity problem for a
// worse one: N GitHub notifications instead of one review, and a partial
// failure midway leaves some findings posted and others not, with no single
// state to reconcile against. Re-fetching and re-running matchPostedFindings
// — the SAME function an ordinary second run already uses for cross-run
// identity — means the recovery is not a special code path at all: whatever
// the live PR already carries is `persist`, whatever it does not is
// `fresh`, and only `fresh` reaches the caller, this time for the summary
// Outside Diff bucket (issues #16/#17) rather than a second review attempt.
// The matcher doubles as the recovery mechanism.
export async function postPrReview(input: {
  operatorRoot: string;
  pr: number;
  headSha: string;
  findings: Finding[];
  // The FULL finding list this run is considering — the exact set
  // buildPostPlan matched against `posted` to produce the plan in the first
  // place (not just `findings`, the anchorable-fresh subset). REQUIRED, not
  // optional, so a caller cannot silently narrow it and reintroduce CRIT-A —
  // see ReviewSubmissionOutcome's WHY above for the failure this closes.
  allFindings: PrHeroFindingRef[];
  webUrl?: string;
  spawnFn?: typeof Bun.spawn;
}): Promise<ReviewSubmissionOutcome> {
  if (input.findings.length === 0) {
    return { outcome: "posted", findings: [] };
  }
  const body = {
    // GitHub #39 (ROADMAP-DOORDASH M1). WITHOUT this, `POST
    // .../pulls/<n>/reviews` resolves every `line` against the PR's LATEST
    // commit at post time — not the commit the lines were computed on. A
    // review takes minutes; an author who pushes while it runs gets one of
    // two outcomes, and the silent one is the reason this line exists: a
    // finding's line that still EXISTS in the newer diff but now means
    // something else anchors cleanly to code the finding was never about.
    // No error, no signal, nothing a reader could tell apart from a real
    // finding. Pinned, GitHub anchors to the reviewed commit and marks the
    // comment outdated ITSELF once the lines move — the reconciliation the
    // engine would otherwise have to invent.
    //
    // The pin also creates a NEW 422 class, and that is the pin working
    // rather than a regression: if `headSha` is rewritten out of the PR
    // mid-run (a force-push), GitHub rejects the whole submission because
    // the commit is no longer part of it, where the unpinned code would
    // have silently posted against whatever replaced it. The recovery below
    // is exactly right for that — re-fetch, re-match, demote the survivors
    // into the summary's Comments Outside Diff bucket. Degraded, honest,
    // and never a hard failure.
    commit_id: input.headSha,
    event: "COMMENT",
    comments: input.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: renderInlineComment(finding, input.headSha, input.webUrl),
    })),
  };
  // `--input -`, not `-F`: gh's `-F`/`-f` field composition has no way to
  // express an ARRAY of objects, and comments[] is exactly that. The whole
  // request body travels on stdin as one JSON document — same ARG_MAX/no-
  // shell reasoning as postPrComment's `-F body=@-`, just for a body gh
  // cannot compose from flags at all.
  const result = await gh(
    input.operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/pulls/${input.pr}/reviews`,
      "--input",
      "-",
    ],
    JSON.stringify(body),
    input.spawnFn,
  );
  if (result.ok) {
    return { outcome: "posted", findings: input.findings };
  }
  if (!is422(result.stderr)) {
    throw new CliError(
      `gh api (post PR review) failed: ${result.stderr.trim()}`,
    );
  }
  const posted = await fetchPostedFindingComments(
    input.operatorRoot,
    input.pr,
    { spawnFn: input.spawnFn },
  );
  const match = matchPostedFindings({
    findings: input.allFindings,
    posted,
    headSha: input.headSha,
  });
  const stillFreshIds = new Set(match.fresh.map((finding) => finding.id));
  return {
    outcome: "demoted",
    findings: input.findings.filter((finding) => stillFreshIds.has(finding.id)),
  };
}

// One un-anchorable (or 422-demoted) finding, posted as its own top-level
// issue comment (spec "One issue comment per un-anchorable finding": never
// pooled). Always a fresh POST, never a PATCH — unlike postPrComment's
// single summary comment, there is no "the" prior comment to update; a
// finding either already has one (the caller's plan already excluded it,
// via inline.ts's matcher) or it does not.
export async function postIssueComment(
  operatorRoot: string,
  pr: number,
  finding: Finding,
  headSha: string,
  webUrl?: string,
  spawnFn?: typeof Bun.spawn,
): Promise<number> {
  const body = renderIssueFindingComment(finding, headSha, webUrl);
  const result = await gh(
    operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      "-F",
      "body=@-",
    ],
    body,
    spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api (post finding issue comment) failed: ${result.stderr.trim()}`,
    );
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  const commentId = (parsed as { id?: unknown } | null)?.id;
  if (typeof commentId !== "number") {
    throw new CliError(
      "gh api posted a finding issue comment but returned no comment id: " +
        result.stdout.slice(0, 120),
    );
  }
  return commentId;
}

function parsePostedCommentId(stdout: string, what: string): number {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  const commentId = (parsed as { id?: unknown } | null)?.id;
  if (typeof commentId !== "number") {
    throw new CliError(
      `gh api posted a ${what} but returned no comment id: ` +
        stdout.slice(0, 120),
    );
  }
  return commentId;
}

// Inline triage reply: POST pulls/<n>/comments with in_reply_to set to the
// finding's own review-comment id. The parent id is resolved by the caller
// from fetchPostedFindingComments + matchPostedFindingExact — this function
// never looks at path/line. Body on stdin (ARG_MAX / no-shell, same as
// postIssueComment).
export async function postReviewCommentReply(input: {
  operatorRoot: string;
  pr: number;
  inReplyTo: number;
  body: string;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const result = await gh(
    input.operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/pulls/${input.pr}/comments`,
      "-F",
      "body=@-",
      "-F",
      `in_reply_to=${input.inReplyTo}`,
    ],
    input.body,
    input.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api (post triage review reply) failed: ${result.stderr.trim()}`,
    );
  }
  return parsePostedCommentId(result.stdout, "triage review reply");
}

// Un-anchorable finding (#17 channel): GitHub issue comments have no
// native thread, so the reply is another top-level issue comment. The
// caller puts the permalink in the body; this function does not guess one.
export async function postIssueTriageComment(input: {
  operatorRoot: string;
  pr: number;
  body: string;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const result = await gh(
    input.operatorRoot,
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${input.pr}/comments`,
      "-F",
      "body=@-",
    ],
    input.body,
    input.spawnFn,
  );
  if (!result.ok) {
    throw new CliError(
      `gh api (post triage issue comment) failed: ${result.stderr.trim()}`,
    );
  }
  return parsePostedCommentId(result.stdout, "triage issue comment");
}

export type ResolveThreadOutcome =
  | "resolved"
  | "already-resolved"
  | "not-found";

// One more `}` than the first live query: 7 opens (query / repository /
// pullRequest / reviewThreads / nodes / comments / nodes) need 7 closes.
// Live W1 triage on pr-hero #34 failed with
// `Expected NAME, actual: (none) ("") at [1, 202]` — GraphQL reaching EOF
// on the last brace, which was one short. Variable names are `repoOwner` /
// `repoName` so they cannot collide with `gh -f name=` interpolating `$name`
// inside the query document.
const REVIEW_THREADS_QUERY =
  "query($repoOwner:String!,$repoName:String!,$number:Int!){" +
  "repository(owner:$repoOwner,name:$repoName){pullRequest(number:$number){" +
  "reviewThreads(first:100){nodes{id isResolved comments(first:1){" +
  "nodes{fullDatabaseId}}}}}}}";

const RESOLVE_THREAD_MUTATION =
  "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){" +
  "thread{isResolved}}}";

// Fake-gh tests never send the document to GitHub, so they cannot catch a
// truncated query. Live W1 on #34 failed with GraphQL EOF
// (`Expected NAME, actual: (none) ("")`) because REVIEW_THREADS_QUERY was
// one `}` short. Count here, before spawn.
function assertBalancedGraphql(document: string, what: string): void {
  const opens = (document.match(/{/g) ?? []).length;
  const closes = (document.match(/}/g) ?? []).length;
  if (opens !== closes) {
    throw new CliError(
      `gh api graphql (${what}) query is unbalanced: ${opens} { vs ${closes} }`,
    );
  }
}

interface RepoOwnerName {
  owner: string;
  name: string;
}

async function ghRepoOwnerName(
  operatorRoot: string,
  spawnFn?: typeof Bun.spawn,
): Promise<RepoOwnerName> {
  const result = await gh(
    operatorRoot,
    ["repo", "view", "--json", "owner,name"],
    undefined,
    spawnFn,
  );
  if (!result.ok) {
    throw new CliError(`gh repo view failed: ${result.stderr.trim()}`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CliError(
      "gh repo view --json owner,name returned invalid JSON: " +
        result.stdout.slice(0, 120),
    );
  }
  const record = parsed as { name?: unknown; owner?: unknown };
  const name = record.name;
  const owner =
    typeof record.owner === "object" && record.owner !== null
      ? (record.owner as { login?: unknown }).login
      : undefined;
  if (typeof name !== "string" || name.length === 0) {
    throw new CliError("gh repo view returned no repository name");
  }
  if (typeof owner !== "string" || owner.length === 0) {
    throw new CliError("gh repo view returned no repository owner");
  }
  return { owner, name };
}

function graphqlDatabaseId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

interface GraphQlThread {
  id: string;
  isResolved: boolean;
  comments: { nodes: { fullDatabaseId: unknown }[] };
}

function parseReviewThreads(stdout: string): GraphQlThread[] {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      "gh api graphql (reviewThreads) returned invalid JSON: " +
        stdout.slice(0, 120),
    );
  }
  const nodes = (
    parsed as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: unknown } };
        };
      };
    } | null
  )?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) {
    throw new CliError(
      "gh api graphql (reviewThreads) returned no thread list",
    );
  }
  return nodes as GraphQlThread[];
}

// Map a REST review-comment id to its GraphQL review thread and resolve it.
// Idempotent: an already-resolved thread is a skip, not an error. A comment
// with no thread (deleted, or outside the first 100 threads) is not-found
// — the caller logs and still treats the reply post as success.
export async function resolveReviewThreadForComment(input: {
  operatorRoot: string;
  pr: number;
  commentId: number;
  spawnFn?: typeof Bun.spawn;
}): Promise<ResolveThreadOutcome> {
  assertBalancedGraphql(REVIEW_THREADS_QUERY, "reviewThreads");
  assertBalancedGraphql(RESOLVE_THREAD_MUTATION, "resolveReviewThread");
  const repo = await ghRepoOwnerName(input.operatorRoot, input.spawnFn);
  const listed = await gh(
    input.operatorRoot,
    [
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `repoOwner=${repo.owner}`,
      "-f",
      `repoName=${repo.name}`,
      "-F",
      `number=${input.pr}`,
    ],
    undefined,
    input.spawnFn,
  );
  if (!listed.ok) {
    throw new CliError(
      `gh api graphql (reviewThreads) failed: ${listed.stderr.trim()}`,
    );
  }
  const thread = parseReviewThreads(listed.stdout).find((candidate) => {
    const first = candidate.comments?.nodes?.[0]?.fullDatabaseId;
    return graphqlDatabaseId(first) === input.commentId;
  });
  if (thread === undefined) return "not-found";
  if (thread.isResolved) return "already-resolved";
  const mutated = await gh(
    input.operatorRoot,
    [
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_THREAD_MUTATION}`,
      "-f",
      `id=${thread.id}`,
    ],
    undefined,
    input.spawnFn,
  );
  if (!mutated.ok) {
    throw new CliError(
      `gh api graphql (resolveReviewThread) failed: ${mutated.stderr.trim()}`,
    );
  }
  return "resolved";
}
