// Known-bad corpus mining I/O (GitHub #43). Walks the repository's merged
// PRs through `gh api graphql`, diffs and blames through git, and writes a
// markdown artifact of CANDIDATES. Every decision — what counts as a fix
// subject, how blame picks an introducer, the proximity window, how the
// artifact renders — is pure in corpus-preflight.ts, where the tests live.
//
// Same scope discipline as reverts: never runs a review, never scores, never
// labels what the defect was, never spends a cent. Read-only git + gh.
//
// Same git-runner rule as the other shells: args as an ARRAY, never an
// interpolated shell string.

import path from "node:path";
import {
  buildThreadBatchQuery,
  type CommitIndexEntry,
  type CommitPrRef,
  type CorpusSource,
  type CorpusWorking,
  evidenceExcerpt,
  type IntroducerInfo,
  type IssueLabels,
  isFixSubject,
  isIncidentText,
  isSelfIntroducer,
  issueRefsFromBody,
  joinProximity,
  MAX_BLAMED_FILES,
  MAX_MERGED_RANGES,
  type MergedPrNode,
  type MergedPrPage,
  matchBugLabels,
  type ProximityFix,
  type PullCommitRef,
  parentBelongsToFix,
  parseBlamePorcelain,
  parseCommitDates,
  parseCommitIndex,
  parseCommitParents,
  parseCutoffTimestamp,
  parseDiffHunks,
  parseIssueLabels,
  parseMergedPrPage,
  parsePullCommits,
  parsePullFiles,
  parseThreadBatch,
  pickIntroducer,
  qualifyThreads,
  renderCorpusArtifact,
  resolvedThreadsWithPath,
  selectCorpus,
  splitBugLabels,
  THREAD_BATCH_SIZE,
  THREAD_PAGE_SIZE,
  type ThreadCandidate,
  validateProximityDays,
  walkPageKept,
} from "./corpus-preflight";
import {
  CliError,
  type CliOptions,
  CliUsageError,
  parseRemoteHead,
  repoWebUrlFromRemote,
} from "./preflight";
import {
  type CommitPullRef,
  DEFAULT_REVERTS_SINCE,
  GIT_LOG_FIELD_SEP,
  type PullDetails,
  parseCommitPulls,
  parsePullDetails,
  pickCommitPull,
  repoSlugFromWebUrl,
} from "./reverts-preflight";
import { log } from "./ui";

// Same helper as cli.ts's, pr.ts's and reverts.ts's, duplicated rather than
// shared so no shell imports another shell. The WHY carries over verbatim:
// args as an ARRAY, never an interpolated shell string — refs and dates are
// user input that reaches git verbatim, and a shell in the middle would turn
// a --since value into an execution surface.
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

// Same shape as reverts.ts's gh. gh stays behind the same single seam
// (`spawnFn`) so an offline fake spawn never depends on the GitHub CLI being
// installed on the machine running the test.
async function gh(
  operatorRoot: string,
  args: string[],
  spawnFn?: typeof Bun.spawn,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const spawn = spawnFn ?? Bun.spawn;
  // A missing gh must name itself: Bun.spawn's error for a binary that is
  // not there reads like a crash, not like "install the GitHub CLI".
  if (spawnFn === undefined && Bun.which("gh") === null) {
    throw new CliError(
      "gh not found on PATH — corpus resolves PR and issue data through the " +
        "GitHub CLI. Install it and authenticate (gh auth login) first.",
    );
  }
  // cwd = operator root: gh resolves credentials and host from the checkout,
  // so the API consulted belongs to the repo passed as --repo.
  // Retry-by-default on failure, and the runs that taught the rule: a
  // ~25-minute musive scan died on `dial tcp: network is unreachable`, the
  // retry-fixed run died on `error connecting to api.github.com` (a different
  // transient signature the allowlist missed), and the run after THAT died on
  // gh's own `unexpected end of JSON input` (a truncated 200). Enumerating
  // transient signatures is whack-a-mole, so the list inverted: everything
  // retries EXCEPT what retrying cannot fix — a 404 is a fact about one PR
  // (callers degrade it), 401/403/bad-credentials are auth, and a rate limit
  // only burns faster when hammered.
  const NOT_TRANSIENT =
    /HTTP 40[134]|rate limit|bad credentials|HTTP 404|was previously flagged/i;
  let attempt = 0;
  for (;;) {
    const proc = spawn(["gh", ...args], {
      cwd: operatorRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0 || attempt >= 3 || NOT_TRANSIENT.test(stderr)) {
      return { ok: exitCode === 0, stdout, stderr };
    }
    attempt++;
    // 1s, 3s, 8s: exponential-ish, sized for a wifi blip that outlives the
    // first retry (observed: two resets inside ten seconds).
    const backoffMs = attempt === 1 ? 1000 : attempt === 2 ? 3000 : 8000;
    log(
      `corpus: transient gh failure (attempt ${attempt}/3), retrying in ` +
        `${backoffMs}ms: ${stderr.trim().split("\n")[0] ?? "no detail"}`,
    );
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}

// Same resolution shape review uses, carried as this shell's own copy — the
// same duplication reverts.ts and watch.ts already make.
async function resolveRepoRoot(repoOption: string): Promise<string> {
  const repoArg = path.resolve(repoOption);
  const toplevel = await git(repoArg, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    throw new CliError(`not a git repository: ${repoArg}`);
  }
  return toplevel.stdout.trim();
}

// The candidates tried, in order, when origin/HEAD is unset. Named in the
// error so a failure is one command from being fixed rather than a guess.
const FALLBACK_DEFAULT_BRANCHES = ["origin/main", "origin/master"];

// WHY this is not cosmetic: musive's default branch is `dev`, so a hardcoded
// `main` walks PRs that never shipped and misses the ones that did — a wrong
// answer with a completely plausible face. Ported from reverts.ts for the
// same reason: only the default branch's merged PRs reached users.
async function resolveDefaultBranchRef(repoRoot: string): Promise<string> {
  const symbolic = await git(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolic.ok) {
    const branch = parseRemoteHead(symbolic.stdout);
    if (branch !== undefined) return `origin/${branch}`;
  }
  for (const candidate of FALLBACK_DEFAULT_BRANCHES) {
    const verified = await git(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${candidate}^{commit}`,
    ]);
    if (verified.ok) return candidate;
  }
  throw new CliError(
    `cannot resolve the default branch of ${repoRoot}: ` +
      "refs/remotes/origin/HEAD is unset and neither " +
      `${FALLBACK_DEFAULT_BRANCHES.join(" nor ")} exists. Run \`git remote ` +
      "set-head origin --auto` (or fetch the remote) first.",
  );
}

async function resolveRepoSlug(repoRoot: string): Promise<string> {
  const remote = await git(repoRoot, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    throw new CliError(
      `cannot read origin's url in ${repoRoot}: ${remote.stderr.trim()}`,
    );
  }
  const webUrl = repoWebUrlFromRemote(remote.stdout);
  const slug = webUrl === undefined ? null : repoSlugFromWebUrl(webUrl);
  if (slug === null) {
    throw new CliError(
      `origin of ${repoRoot} does not look like a github.com repository ` +
        `(${remote.stdout.trim()}) — corpus resolves PR and issue data ` +
        "through the GitHub API, so it needs one",
    );
  }
  return slug;
}

// A 404 is a fact about ONE object, not a broken command: a deleted issue or
// a PR from a deleted fork. It degrades that one lookup and the scan
// continues. Anything else — auth, rate limit, network — is systematic, and
// continuing would produce an artifact quietly missing most of its entries.
function isNotFound(stderr: string): boolean {
  return /HTTP 404/.test(stderr);
}

// Fake-gh tests never send the document to GitHub, so they cannot catch a
// truncated query. Ported from pr.ts (its W1 failure on #34): count the
// braces before spawn.
function assertBalancedGraphql(document: string, what: string): void {
  const opens = (document.match(/{/g) ?? []).length;
  const closes = (document.match(/}/g) ?? []).length;
  if (opens !== closes) {
    throw new CliError(
      `gh api graphql (${what}) query is unbalanced: ${opens} { vs ${closes} }`,
    );
  }
}

async function ghCommitPulls(
  operatorRoot: string,
  slug: string,
  sha: string,
): Promise<CommitPullRef[]> {
  const result = await gh(operatorRoot, [
    "api",
    `repos/${slug}/commits/${sha}/pulls`,
  ]);
  if (!result.ok) {
    if (isNotFound(result.stderr)) return [];
    throw new CliError(
      `gh api repos/${slug}/commits/${sha}/pulls failed: ` +
        result.stderr.trim(),
    );
  }
  try {
    return parseCommitPulls(result.stdout);
  } catch (error) {
    // The pure reader names the field; only the shell knows the endpoint.
    if (error instanceof CliUsageError) {
      throw new CliError(
        `repos/${slug}/commits/${sha}/pulls: ${error.message}`,
      );
    }
    throw error;
  }
}

async function ghPullDetails(
  operatorRoot: string,
  slug: string,
  pr: number,
): Promise<PullDetails | null> {
  const result = await gh(operatorRoot, ["api", `repos/${slug}/pulls/${pr}`]);
  if (!result.ok) {
    if (isNotFound(result.stderr)) return null;
    throw new CliError(
      `gh api repos/${slug}/pulls/${pr} failed: ${result.stderr.trim()}`,
    );
  }
  try {
    return parsePullDetails(result.stdout);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliError(`repos/${slug}/pulls/${pr}: ${error.message}`);
    }
    throw error;
  }
}

async function ghPullCommits(
  repoRoot: string,
  slug: string,
  pr: number,
): Promise<PullCommitRef[]> {
  const result = await gh(repoRoot, [
    "api",
    "--paginate",
    `repos/${slug}/pulls/${pr}/commits?per_page=100`,
  ]);
  if (!result.ok) {
    if (isNotFound(result.stderr)) return [];
    throw new CliError(
      `gh api repos/${slug}/pulls/${pr}/commits failed: ` +
        result.stderr.trim(),
    );
  }
  try {
    return parsePullCommits(result.stdout);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliError(`repos/${slug}/pulls/${pr}/commits: ${error.message}`);
    }
    throw error;
  }
}

async function ghPullFiles(
  repoRoot: string,
  slug: string,
  pr: number,
): Promise<string[]> {
  const result = await gh(repoRoot, [
    "api",
    "--paginate",
    `repos/${slug}/pulls/${pr}/files?per_page=100`,
  ]);
  if (!result.ok) {
    if (isNotFound(result.stderr)) return [];
    throw new CliError(
      `gh api repos/${slug}/pulls/${pr}/files failed: ${result.stderr.trim()}`,
    );
  }
  try {
    return parsePullFiles(result.stdout);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliError(`repos/${slug}/pulls/${pr}/files: ${error.message}`);
    }
    throw error;
  }
}

// The merged-PR walk (STEP A). Everything travels as graphql VARIABLES —
// owner, name and cursor — so no user- or API-derived string is ever
// interpolated into the document. Ordered by UPDATED_AT, not mergedAt:
// IssueOrderField has no MERGED_AT value (the first live run failed closed on
// exactly that), and updatedAt >= mergedAt keeps the walk complete — the
// completeness argument lives with walkPageKept.
const WALK_QUERY =
  "query($repoOwner:String!,$repoName:String!,$cursor:String){" +
  "repository(owner:$repoOwner,name:$repoName){" +
  "pullRequests(first:100,states:MERGED," +
  "orderBy:{field:UPDATED_AT,direction:DESC},after:$cursor){" +
  "pageInfo{endCursor hasNextPage}" +
  "nodes{number title body mergedAt updatedAt mergeCommit{oid} baseRefName}}}}";

interface WalkResult {
  kept: MergedPrNode[];
  pagesSeen: number;
}

async function walkMergedPrs(input: {
  repoRoot: string;
  slug: string;
  cutoffMs: number | null;
  defaultBranch: string;
}): Promise<WalkResult> {
  assertBalancedGraphql(WALK_QUERY, "merged PR walk");
  const slash = input.slug.indexOf("/");
  const owner = input.slug.slice(0, slash);
  const name = input.slug.slice(slash + 1);
  const kept: MergedPrNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let pagesSeen = 0;
  // Pages are walked SEQUENTIALLY: each page's cursor comes from the last,
  // and a parallel walk would destroy the DESC ordering the stop rule (a
  // fully-older page means every later page is older still) depends on.
  while (hasNextPage) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${WALK_QUERY}`,
      "-f",
      `repoOwner=${owner}`,
      "-f",
      `repoName=${name}`,
    ];
    if (cursor !== null) {
      args.push("-f", `cursor=${cursor}`);
    }
    const result = await gh(input.repoRoot, args);
    if (!result.ok) {
      throw new CliError(
        `gh api graphql (merged PR walk) failed: ${result.stderr.trim()}`,
      );
    }
    let page: MergedPrPage;
    try {
      page = parseMergedPrPage(result.stdout);
    } catch (error) {
      if (error instanceof CliUsageError) {
        throw new CliError(`gh api graphql: ${error.message}`);
      }
      throw error;
    }
    pagesSeen++;
    const filtered = walkPageKept({
      nodes: page.nodes,
      cutoffMs: input.cutoffMs,
      defaultBranch: input.defaultBranch,
    });
    kept.push(...filtered.kept);
    if (filtered.olderExhausted) break;
    cursor = page.endCursor;
    hasNextPage = page.hasNextPage;
  }
  return { kept, pagesSeen };
}

// The cutoff instant, resolved INSIDE git (STEP A's agreement rule): a
// relative --since ("24 months ago") is relative to a clock this command
// refuses to read, so git resolves it — `rev-list` names the newest commit
// at/before the boundary and we take its committer seconds. Empty output
// means the whole history fits the window: no cutoff, walk everything.
async function resolveCutoffSec(
  repoRoot: string,
  ref: string,
  since: string,
): Promise<number | null> {
  const listed = await git(repoRoot, [
    "rev-list",
    "--max-count=1",
    "--format=%ct",
    `--before=${since}`,
    "--end-of-options",
    ref,
  ]);
  if (!listed.ok) {
    throw new CliError(
      `git rev-list --before=${since} ${ref} failed: ${listed.stderr.trim()}`,
    );
  }
  try {
    return parseCutoffTimestamp(listed.stdout);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliError(`git rev-list ${ref}: ${error.message}`);
    }
    throw error;
  }
}

// STEP C's blame pass for one classified PR. The ranges come from the fix's
// own diff pre-image (the lines the fix changed are where the bug lived);
// each range is one `git blame --porcelain` against the merge's PARENT —
// the last tree in which the bug was still alive.
async function blameResolve(input: {
  repoRoot: string;
  slug: string;
  pr: MergedPrNode;
  entry: CorpusWorking;
}): Promise<string[]> {
  const mergeSha = input.pr.mergeCommitSha;
  if (mergeSha === null) return [];
  const parent = await git(input.repoRoot, ["rev-parse", `${mergeSha}^`]);
  if (!parent.ok) {
    // GitHub keeps merge commits that this clone no longer (or never) had —
    // observed live on musive PR #423: dev's history was rewritten after the
    // merge, the old merge commit survives on GitHub only through the PR
    // ref, and the local object store pruned it. That is clone-vs-GitHub
    // divergence, not corruption: this PR keeps its detector evidence with
    // no introducer (the tier falls accordingly), said so on stderr, and the
    // scan continues.
    log(
      `corpus: PR #${input.pr.number} — merge commit ${mergeSha.slice(0, 12)} ` +
        "is not present in this clone (stale clone or rewritten history); " +
        "no blame evidence, continuing",
    );
    return [];
  }
  const parentSha = parent.stdout.trim();
  const listed = await git(input.repoRoot, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    "--end-of-options",
    mergeSha,
  ]);
  if (!listed.ok) {
    throw new CliError(
      `git rev-list --parents ${mergeSha} failed: ${listed.stderr.trim()}`,
    );
  }
  let parents: string[];
  try {
    parents = parseCommitParents(listed.stdout);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliError(
        `git rev-list --parents ${mergeSha}: ${error.message}`,
      );
    }
    throw error;
  }
  // One parent: squash OR rebase. Squash's parent is the previous
  // default-branch tip (another PR, or a direct push). Rebase-and-merge
  // of 2+ commits: the parent is still THIS PR, so mergeSha^..mergeSha
  // is one commit of the PR instead of the whole thing — skip, same as
  // a missing merge commit. A 1-commit rebase looks like squash and the
  // one-commit diff IS the whole PR, so blame proceeds.
  const soleParent = parents[0];
  if (parents.length === 1 && soleParent !== undefined) {
    const parentPulls = await ghCommitPulls(
      input.repoRoot,
      input.slug,
      soleParent,
    );
    if (parentBelongsToFix(input.pr.number, parentPulls)) {
      log(
        `corpus: PR #${input.pr.number} — merge commit ${mergeSha.slice(0, 12)} ` +
          "is a rebase (its parent still belongs to this PR); blame would " +
          "cover one commit instead of the whole PR, skipping",
      );
      return [];
    }
  }
  const diff = await git(input.repoRoot, [
    "diff",
    "--no-color",
    "--unified=0",
    "--end-of-options",
    parentSha,
    mergeSha,
  ]);
  if (!diff.ok) {
    throw new CliError(
      `git diff ${parentSha} ${mergeSha} failed: ${diff.stderr.trim()}`,
    );
  }
  const plan = parseDiffHunks(diff.stdout);
  input.entry.blameSkippedRenames = plan.renamedPaths.length;
  if (plan.droppedFiles > 0 || plan.droppedRanges > 0) {
    log(
      `corpus: PR #${input.pr.number} — blame plan capped at ` +
        `${MAX_BLAMED_FILES} files / ${MAX_MERGED_RANGES} ranges per file ` +
        `(${plan.droppedFiles} file(s), ${plan.droppedRanges} range(s) dropped)`,
    );
  }
  const files = plan.files.map((file) => file.path);
  const blamed: { sha: string; file: string; range: string }[] = [];
  for (const file of plan.files) {
    for (const range of file.ranges) {
      const blame = await git(input.repoRoot, [
        "blame",
        "--porcelain",
        "-L",
        `${range.start},${range.end}`,
        parentSha,
        "--",
        file.path,
      ]);
      if (!blame.ok) {
        // One undatable file must not kill a whole-repo scan: the range is
        // skipped, said so on stderr, and the candidate keeps its other
        // evidence. The blame evidence is simply missing from the entry, so
        // the artifact's counts stay honest.
        log(
          `corpus: PR #${input.pr.number} — blame failed on ${file.path} ` +
            `(${blame.stderr.trim().split("\n")[0] ?? "no detail"}); skipped`,
        );
        continue;
      }
      for (const sha of parseBlamePorcelain(blame.stdout)) {
        blamed.push({
          sha,
          file: file.path,
          range: `${range.start},${range.end}`,
        });
      }
    }
  }
  if (blamed.length > 0) {
    // One batch per PR: the dates exist to pick ONE introducer, and a spawn
    // per sha would bill the latency this command is trying not to have.
    const distinctShas = [...new Set(blamed.map((entry) => entry.sha))];
    const shown = await git(input.repoRoot, [
      "show",
      "-s",
      `--format=%H${GIT_LOG_FIELD_SEP}%ct`,
      ...distinctShas,
    ]);
    if (!shown.ok) {
      throw new CliError(
        `git show -s (${distinctShas.length} sha(s)) failed: ` +
          shown.stderr.trim(),
      );
    }
    const dates = parseCommitDates(shown.stdout);
    const withDates = blamed.flatMap((entry) => {
      const committedAtSec = dates.get(entry.sha);
      return committedAtSec === undefined ? [] : [{ ...entry, committedAtSec }];
    });
    if (withDates.length < blamed.length) {
      log(
        `corpus: PR #${input.pr.number} — ` +
          `${blamed.length - withDates.length} blamed sha(s) had no date row; ` +
          "dropped",
      );
    }
    const pick = pickIntroducer(withDates);
    if (pick !== null) {
      const pulls = await ghCommitPulls(input.repoRoot, input.slug, pick.sha);
      const primary = pickCommitPull(pulls);
      if (
        primary !== null &&
        isSelfIntroducer(input.pr.number, primary.number)
      ) {
        log(
          `corpus: PR #${input.pr.number} — blame resolved to the fix itself; ` +
            "introducer dropped (a PR cannot introduce what it fixed)",
        );
      } else {
        const introducer: IntroducerInfo = {
          pr: primary?.number ?? null,
          title: primary?.title ?? null,
          mergedAt: primary?.mergedAt ?? null,
          blamedSha: pick.sha,
          blamedFile: pick.file,
          blamedRange: pick.range,
        };
        input.entry.introducer = introducer;
        input.entry.alsoBlamedCount = pick.alsoBlamedCount;
        log(
          `corpus: PR #${input.pr.number} — introducer ` +
            (primary === null
              ? `direct push ${pick.sha.slice(0, 12)}`
              : `PR #${primary.number}`),
        );
      }
    }
  }
  return files;
}

// STEP F — review threads. One graphql document per THREAD_BATCH_SIZE PRs
// (aliases p0..pN over validated integers — the only text interpolation in
// any query here), then per survivor the two REST reads the pure join needs.
// A gh failure names the rate-limit exit: a narrower --since is the one knob
// that shrinks this walk.
async function mineThreads(input: {
  repoRoot: string;
  slug: string;
  mergedPrs: MergedPrNode[];
}): Promise<ThreadCandidate[]> {
  const slash = input.slug.indexOf("/");
  const owner = input.slug.slice(0, slash);
  const name = input.slug.slice(slash + 1);
  const out: ThreadCandidate[] = [];
  for (
    let offset = 0;
    offset < input.mergedPrs.length;
    offset += THREAD_BATCH_SIZE
  ) {
    const batch = input.mergedPrs.slice(offset, offset + THREAD_BATCH_SIZE);
    const numbers = batch.map((pr) => pr.number);
    const query = buildThreadBatchQuery(numbers);
    assertBalancedGraphql(query, "reviewThreads batch");
    const result = await gh(input.repoRoot, [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `repoOwner=${owner}`,
      "-f",
      `repoName=${name}`,
    ]);
    if (!result.ok) {
      throw new CliError(
        `gh api graphql (reviewThreads batch) failed: ${result.stderr.trim()}` +
          " — if this is a rate limit, re-run with a narrower --since",
      );
    }
    let parsed: ReturnType<typeof parseThreadBatch>;
    try {
      parsed = parseThreadBatch(result.stdout, numbers);
    } catch (error) {
      if (error instanceof CliUsageError) {
        throw new CliError(`gh api graphql: ${error.message}`);
      }
      throw error;
    }
    if (parsed.nullAliases > 0) {
      // Visible, not fatal: a null alias is one PR's threads unread (partial
      // GraphQL execution under load, or a PR invisible to this token). A
      // systemic outbreak shows as a count worth re-running, a single null
      // must not kill the scan.
      log(
        `corpus: reviewThreads batch returned ${parsed.nullAliases} null ` +
          `alias(es) (batch ${Math.floor(offset / THREAD_BATCH_SIZE) + 1}) — ` +
          "those PRs contribute no threads",
      );
    }
    for (const [i, pr] of batch.entries()) {
      const entry = parsed.entries[i];
      if (entry === undefined) continue;
      const resolved = resolvedThreadsWithPath(entry.threads);
      if (resolved.length === 0) continue;
      const commits = await ghPullCommits(
        input.repoRoot,
        input.slug,
        pr.number,
      );
      const files = await ghPullFiles(input.repoRoot, input.slug, pr.number);
      const qualified = qualifyThreads(
        resolved.map((thread) => ({
          path: thread.path ?? "",
          line: thread.line,
          firstCommentAt: thread.firstCommentAt ?? "",
          excerpt: thread.excerpt ?? "",
        })),
        commits,
        files,
      );
      // A PR with zero QUALIFYING threads is not a candidate: a resolved
      // thread no push ever addressed is a conversation, not a caught defect.
      if (qualified.length === 0) continue;
      out.push({
        pr: pr.number,
        title: pr.title,
        mergedAt: pr.mergedAt,
        threads: qualified,
        threadsTruncated: entry.truncated,
        baseSha: null,
        headSha: null,
        additions: null,
        deletions: null,
        changedFiles: null,
      });
      log(
        `corpus: PR #${pr.number} — ${qualified.length} qualifying resolved ` +
          "thread(s) (caught in review)",
      );
    }
  }
  return out;
}

export async function corpusCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const slug = await resolveRepoSlug(repoRoot);
  const ref = await resolveDefaultBranchRef(repoRoot);
  const since = options.since ?? DEFAULT_REVERTS_SINCE;
  const proximityDays = validateProximityDays(options.proximityDays);
  const bugLabels = options.issues
    ? new Set(splitBugLabels(options.bugLabels))
    : new Set<string>();
  // baseRefName is the SHORT branch name; ref is the remote-tracking path.
  const defaultBranch = ref.replace(/^origin\//, "");
  const sourcesRun = [
    ...(options.fixes ? ["--fixes"] : []),
    ...(options.incidents ? ["--incidents"] : []),
    ...(options.issues ? ["--issues"] : []),
    ...(options.proximity ? ["--proximity"] : []),
    ...(options.threads ? ["--threads"] : []),
  ];
  log(
    `corpus: scanning ${slug} ${ref} since "${since}" (sources: ${sourcesRun.join(", ")}; ` +
      "read-only, $0)",
  );

  const cutoffSec = await resolveCutoffSec(repoRoot, ref, since);
  const cutoffMs = cutoffSec === null ? null : cutoffSec * 1000;
  log(
    cutoffMs === null
      ? "corpus: whole history is inside the window — walking all merged PRs"
      : `corpus: window cutoff ${new Date(cutoffMs).toISOString()} (resolved by git)`,
  );

  // STEP A — the walk. Every source consumes this list.
  const walked = await walkMergedPrs({
    repoRoot,
    slug,
    cutoffMs,
    defaultBranch,
  });
  const mergedPrs = walked.kept;
  log(
    `corpus: ${mergedPrs.length} merged PR(s) on ${defaultBranch} in the ` +
      `window (${walked.pagesSeen} page(s))`,
  );

  // STEP C — classify (fix subjects / incident keywords) + blame-resolve.
  // Issue refs alone do NOT enter the set: they only upgrade confidence in
  // STEP D's label check.
  const working = new Map<number, CorpusWorking>();
  const blameFilesByPr = new Map<number, string[]>();
  if (options.fixes || options.incidents) {
    for (const pr of mergedPrs) {
      const body = pr.body ?? "";
      const fixMatch = options.fixes && isFixSubject(pr.title);
      const incidentMatch = options.incidents
        ? isIncidentText(pr.title, body)
        : null;
      if (!fixMatch && incidentMatch === null) continue;
      const matchedSources: CorpusSource[] = [];
      if (fixMatch) matchedSources.push("fix-subject");
      if (incidentMatch !== null) matchedSources.push("incident-keyword");
      const entry: CorpusWorking = {
        fixPr: pr.number,
        fixTitle: pr.title,
        fixMergedAt: pr.mergedAt,
        matchedSources,
        // The title IS the fix evidence when the subject matched — the
        // position-0 anchor is the whole point; otherwise the incident's
        // matched line.
        matchedText: fixMatch
          ? evidenceExcerpt(pr.title)
          : (incidentMatch ?? ""),
        issueRefs: [],
        fixBaseSha: null,
        fixHeadSha: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        introducer: null,
        alsoBlamedCount: 0,
        blameSkippedRenames: 0,
        proximitySuspects: [],
      };
      working.set(pr.number, entry);
      log(`corpus: PR #${pr.number} classified (${matchedSources.join(", ")})`);
      blameFilesByPr.set(
        pr.number,
        await blameResolve({ repoRoot, slug, pr, entry }),
      );
    }
  }

  // STEP D — bug-issue labels, over the classified set's refs. Cached per
  // issue number: one fix frequently references the same tracking issue.
  // Gated on --issues: the other four sources each have a flag, and running
  // this whenever --fixes/--incidents classified anything billed a source
  // the operator did not request (and made `sources run:` never list it).
  if (options.issues && working.size > 0) {
    const uniqueRefs: number[] = [];
    for (const pr of mergedPrs) {
      const entry = working.get(pr.number);
      if (entry === undefined) continue;
      const refs = issueRefsFromBody(pr.body ?? "");
      entry.issueRefs = refs.map((number) => ({ number, matchedLabels: [] }));
      for (const number of refs) {
        if (!uniqueRefs.includes(number)) uniqueRefs.push(number);
      }
    }
    const issueCache = new Map<number, IssueLabels | null>();
    for (const number of uniqueRefs) {
      const result = await gh(repoRoot, [
        "api",
        `repos/${slug}/issues/${number}`,
      ]);
      if (!result.ok) {
        // A 404 ref degrades to "unresolved": listed without labels, confers
        // nothing. It is a fact about one issue (deleted, or another repo's
        // number pasted in), not a broken scan.
        if (isNotFound(result.stderr)) {
          issueCache.set(number, null);
          log(`corpus: issue #${number} is unresolved (404)`);
          continue;
        }
        throw new CliError(
          `gh api repos/${slug}/issues/${number} failed: ` +
            result.stderr.trim(),
        );
      }
      try {
        issueCache.set(number, parseIssueLabels(result.stdout));
      } catch (error) {
        if (error instanceof CliUsageError) {
          throw new CliError(
            `repos/${slug}/issues/${number}: ${error.message}`,
          );
        }
        throw error;
      }
    }
    for (const entry of working.values()) {
      const { byRef, anyMatch } = matchBugLabels(
        entry.issueRefs.map((ref) => ref.number),
        issueCache,
        bugLabels,
      );
      for (const ref of entry.issueRefs) {
        ref.matchedLabels = byRef.get(ref.number) ?? [];
      }
      if (anyMatch && !entry.matchedSources.includes("bug-issue")) {
        entry.matchedSources.push("bug-issue");
      }
    }
  }

  // STEP B — the commit/file index, only when --proximity asked for it.
  if (options.proximity && mergedPrs.length > 0) {
    const stamps = mergedPrs
      .map((pr) =>
        pr.mergedAt === null ? Number.NaN : Date.parse(pr.mergedAt),
      )
      .filter((ms) => !Number.isNaN(ms));
    const earliestMs = stamps.length === 0 ? Number.NaN : Math.min(...stamps);
    if (!Number.isNaN(earliestMs)) {
      // window-start derives from RECORDED stamps only (earliest kept merge
      // minus the window), rendered as ISO for git — no clock read anywhere.
      const windowStartIso = new Date(
        earliestMs - proximityDays * 86_400_000,
      ).toISOString();
      // `-m --first-parent` or the index comes back EMPTY on any merge-based
      // repo. Without them git emits no numstat at all for a merge commit
      // (measured: the merge itself yields only the format header, zero file
      // lines) — and since `prBySha` below keys on `mergeCommitSha`, those
      // fileless merges are the ONLY commits the join can resolve to a PR, so
      // every candidate silently scored zero suspects. musive, the target
      // repo, merges every PR this way. `--first-parent` also narrows the walk
      // to one commit per PR plus the direct pushes, which is exactly the set
      // `prBySha` can answer for — the side-branch commits it drops were
      // unresolvable anyway. Both flags are no-ops on squash-merge history
      // (verified: byte-identical output on a single-parent commit), so a
      // linear repo sees no behaviour change.
      const logged = await git(repoRoot, [
        "log",
        ref,
        `--since=${windowStartIso}`,
        "-m",
        "--first-parent",
        `--format=%H${GIT_LOG_FIELD_SEP}%ct`,
        "--no-renames",
        "--numstat",
      ]);
      if (!logged.ok) {
        throw new CliError(
          `git log ${ref} --since=${windowStartIso} failed: ` +
            logged.stderr.trim(),
        );
      }
      let commitIndex: CommitIndexEntry[];
      try {
        commitIndex = parseCommitIndex(logged.stdout);
      } catch (error) {
        if (error instanceof CliUsageError) {
          throw new CliError(`git log ${ref}: ${error.message}`);
        }
        throw error;
      }
      log(
        `corpus: proximity index — ${commitIndex.length} commit(s) since ` +
          windowStartIso,
      );
      // Commit→PR via mergeCommitSha, over the walk's kept PRs: a commit
      // whose merge the walk never saw cannot be a suspect, which bounds
      // suspects to the window the artifact claims to have scanned.
      const prBySha = new Map<string, CommitPrRef>();
      for (const pr of mergedPrs) {
        if (pr.mergeCommitSha === null) continue;
        prBySha.set(pr.mergeCommitSha, {
          pr: pr.number,
          title: pr.title,
          mergedAt: pr.mergedAt,
        });
      }
      // ONLY entries whose introducer did not resolve (the pure join's
      // caller-side rule): a resolved introducer needs no heuristic.
      const unresolved: ProximityFix[] = [];
      for (const entry of working.values()) {
        if (entry.introducer !== null && entry.introducer.pr !== null) continue;
        unresolved.push({
          fixPr: entry.fixPr,
          fixMergedAt: entry.fixMergedAt,
          files: blameFilesByPr.get(entry.fixPr) ?? [],
        });
      }
      const suspects = joinProximity(
        unresolved,
        commitIndex,
        proximityDays,
        prBySha,
      );
      for (const entry of working.values()) {
        entry.proximitySuspects = suspects.get(entry.fixPr) ?? [];
      }
    }
  }

  // STEP E — tier resolution + dedupe + order, all pure.
  const selected = selectCorpus([...working.values()]);
  // The same-PR introducer filter ran inside selectCorpus; the shell only
  // NOTES the drops it can still see in its own working set.
  for (const entry of working.values()) {
    if (entry.introducer?.pr === entry.fixPr) {
      log(
        `corpus: PR #${entry.fixPr} — blame resolved to the fix itself; ` +
          "introducer dropped (a PR cannot introduce what it fixed)",
      );
    }
  }
  log(
    `corpus: ${selected.length} fix-shaped candidate(s) across the ` +
      "issue-linked/blame-linked/keyword-only/proximity tiers",
  );

  // STEP F — review threads.
  const threadCandidates: ThreadCandidate[] = options.threads
    ? await mineThreads({ repoRoot, slug, mergedPrs })
    : [];
  if (options.threads) {
    log(
      `corpus: ${threadCandidates.length} caught-in-review PR(s) from ` +
        `resolved threads (capped at ${THREAD_PAGE_SIZE} threads per PR, ` +
        `${THREAD_BATCH_SIZE} PRs per batch)`,
    );
  }

  // An empty result is a valid state of the world, not an error: note it on
  // stderr naming the sources that ran, leave stdout clean, exit 0.
  if (selected.length === 0 && threadCandidates.length === 0) {
    log(
      `no corpus candidates from ${sourcesRun} over ${mergedPrs.length} ` +
        `scanned PR(s) on ${ref} since "${since}" — widen the window with ` +
        "--since or enable another source",
    );
    return 0;
  }

  // STEP G — enrichment. One shared cache: a PR can appear in both sets, and
  // the walk's nodes never carried the size/range fields.
  const detailsCache = new Map<number, PullDetails | null>();
  const details = async (pr: number): Promise<PullDetails | null> => {
    const hit = detailsCache.get(pr);
    if (hit !== undefined) return hit;
    const fetched = await ghPullDetails(repoRoot, slug, pr);
    detailsCache.set(pr, fetched);
    return fetched;
  };
  for (const candidate of selected) {
    const pull = await details(candidate.fixPr);
    if (pull !== null) {
      candidate.fixBaseSha = pull.baseSha;
      candidate.fixHeadSha = pull.headSha;
      candidate.additions = pull.additions;
      candidate.deletions = pull.deletions;
      candidate.changedFiles = pull.changedFiles;
    }
  }
  for (const thread of threadCandidates) {
    const pull = await details(thread.pr);
    thread.baseSha = pull?.baseSha ?? null;
    thread.headSha = pull?.headSha ?? null;
    thread.additions = pull?.additions ?? null;
    thread.deletions = pull?.deletions ?? null;
    thread.changedFiles = pull?.changedFiles ?? null;
  }

  const markdown = renderCorpusArtifact({
    repoSlug: slug,
    ref,
    since,
    scannedPrs: mergedPrs.length,
    sourcesRun,
    candidates: selected,
    threadCandidates,
  });
  if (options.out) {
    const outPath = path.resolve(options.out);
    await Bun.write(outPath, markdown);
    log(
      `corpus: wrote ${outPath} (${selected.length} fix-shaped + ` +
        `${threadCandidates.length} caught-in-review candidate(s) from ` +
        `${mergedPrs.length} scanned PR(s))`,
    );
    return 0;
  }
  // The markdown IS this command's product, and stdout is the one clean
  // channel (everything human-facing goes to stderr), so it can be piped or
  // redirected without the notes riding along.
  process.stdout.write(markdown);
  return 0;
}
