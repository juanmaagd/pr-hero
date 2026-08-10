// PR mode's I/O (ROADMAP B1): gh, the fetch, the detached worktree, the
// worktree's codegraph index, and the Greptile comparison files — every side
// effect `pr-hero review --pr <n>` needs beyond what cli.ts already owns.
// Same contract as cli.ts: this is an I/O shell, untested by construction,
// and every decision it acts on is a pure function in pr-preflight.ts (or
// preflight.ts), where the tests live.
//
// Every git and gh call here runs with the OPERATOR root as cwd — the
// worktree shares its object db — except the two read-only inspections of
// the worktree itself in ensureWorktree.

import { existsSync } from "node:fs";
import path from "node:path";
import { compareFindings, type PrHeroFindingRef } from "./compare";
import { renderComparison } from "./compare-report";
import type { RunStatus } from "./findings";
import { parseGreptileComment, pickGreptileComment } from "./greptile";
import {
  buildComparisonJson,
  decideWorktree,
  findMarkedCommentId,
  type WorktreeDecision,
  worktreeDirty,
} from "./pr-preflight";
import { CliError } from "./preflight";

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

async function gh(
  operatorRoot: string,
  args: string[],
  stdin?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // A missing gh must name itself: Bun.spawn's error for a binary that is
  // not there reads like a crash, not like "install the GitHub CLI".
  if (Bun.which("gh") === null) {
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
  const proc = Bun.spawn(["gh", ...args], {
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

// WHY this exact refspec pair (paid-for): a merged PR's branch is usually
// deleted, so nothing but `refs/pull/<n>/head` keeps headRefOid fetchable —
// and fetching the base branch by name in the same call brings the merge
// commit and the baseRefOid ancestry along, so every rev the flow
// canonicalizes afterwards resolves against a single fetch.
export async function fetchPrRefs(
  operatorRoot: string,
  pr: number,
  baseRefName: string,
): Promise<void> {
  const result = await git(operatorRoot, [
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
  operatorRoot: string,
  worktreePath: string,
  headSha: string,
): Promise<WorktreeDecision> {
  // Prune first: a worktree deleted by hand leaves a stale registration
  // behind, and a stale registration makes the add below refuse.
  const pruned = await git(operatorRoot, ["worktree", "prune"]);
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
    const removed = await git(operatorRoot, [
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
    const reprune = await git(operatorRoot, ["worktree", "prune"]);
    if (!reprune.ok) {
      throw new CliError(`git worktree prune failed: ${reprune.stderr.trim()}`);
    }
  }
  if (decision.action !== "reuse") {
    const added = await git(operatorRoot, [
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
  };
}

// Publishes the review as ONE marked PR comment: update the existing marked
// comment when there is one, create it otherwise. Idempotency lives in the
// marker contract (PR_COMMENT_MARKER as the body's first line +
// findMarkedCommentId) — a re-run refreshes the same comment instead of
// stacking a new one per run. Throws CliError on any gh failure and is NOT
// caught here: the caller asked for a public side effect, so the caller
// decides what a failed one means.
export async function postPrComment(
  operatorRoot: string,
  pr: number,
  body: string,
): Promise<{ action: "created" | "updated"; commentId: number }> {
  const comments = await fetchPrComments(operatorRoot, pr);
  const existingId = findMarkedCommentId(comments);
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
async function fetchPrComments(
  operatorRoot: string,
  pr: number,
): Promise<{ id: number; user: string; body: string }[]> {
  const result = await gh(operatorRoot, [
    "api",
    "--paginate",
    `repos/{owner}/{repo}/issues/${pr}/comments`,
    "--jq",
    ".[] | {id: .id, user: .user.login, body: .body}",
  ]);
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
