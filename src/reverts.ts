// Revert/hotfix mining I/O (GitHub #41). Runs `git log` over the repo's
// DEFAULT BRANCH and asks `gh api` for the PR numbers and diff sizes, then
// writes a markdown artifact of CANDIDATES. Every decision — what counts as a
// revert, which duplicates collapse, how the artifact renders — is pure in
// reverts-preflight.ts, where the tests live.
//
// What this command deliberately does NOT do, straight from the issue's
// scope: it never runs a review, never scores, never labels what the defect
// was, and never spends a cent. It is `git log` plus read-only `gh api`.
//
// Same git-runner rule as the other shells: args as an ARRAY, never an
// interpolated shell string.

import path from "node:path";
import {
  CliError,
  type CliOptions,
  CliUsageError,
  parseRemoteHead,
  repoWebUrlFromRemote,
} from "./preflight";
import {
  type CommitPullRef,
  classifyRevertCommit,
  DEFAULT_REVERTS_SINCE,
  GIT_LOG_FORMAT,
  type PullDetails,
  parseCommitPulls,
  parseGitLogRecords,
  parsePullDetails,
  pickCommitPull,
  type RevertCandidate,
  renderRevertsArtifact,
  repoSlugFromWebUrl,
  selectRevertCandidates,
} from "./reverts-preflight";
import { log } from "./ui";

// Same helper as cli.ts's and pr.ts's git, duplicated rather than shared so
// neither shell imports the other. The WHY carries over verbatim: args as an
// ARRAY, never an interpolated shell string — refs and dates are user input
// that reaches git verbatim, and a shell in the middle would turn a --since
// value into an execution surface.
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

// Same shape as pr.ts's gh, and the same single testability seam: `spawnFn`
// is invisible to production callers, and the `Bun.which("gh")` guard is
// skipped under a fake spawn so an offline test never depends on whether the
// machine running it happens to have the GitHub CLI installed.
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
      "gh not found on PATH — reverts resolves PR numbers through the " +
        "GitHub CLI. Install it and authenticate (gh auth login) first.",
    );
  }
  // cwd = operator root, same as pr.ts: gh resolves credentials and host from
  // the checkout, so the API consulted belongs to the repo passed as --repo.
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
  return { ok: exitCode === 0, stdout, stderr };
}

// Same resolution shape review uses (cli.ts's resolveRepoRoot), carried as
// this shell's own copy — the same duplication watch.ts already makes.
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

// STEP 1. WHY this is not cosmetic: musive's default branch is `dev`, so a
// hardcoded `main` mines nothing at all and reports "no candidates" — a wrong
// answer with a completely plausible face.
//
// And WHY only this ref, never `--all`: a revert reachable only from a side
// branch never shipped to anybody, so it is not ground truth about a
// regression that reached users. The default branch is the whole point.
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
        `(${remote.stdout.trim()}) — reverts resolves PR numbers through ` +
        "the GitHub API, so it needs one",
    );
  }
  return slug;
}

// A 404 is a fact about ONE pull, not a broken command: a PR from a deleted
// fork, or a commit that reached the branch outside a PR. It degrades that
// field to "unresolved" and the scan continues. Anything else — auth, rate
// limit, network — is systematic, and continuing would produce an artifact
// that is quietly missing most of its entries.
function isNotFound(stderr: string): boolean {
  return /HTTP 404/.test(stderr);
}

interface GhSeam {
  spawnFn?: typeof Bun.spawn;
}

async function ghCommitPulls(
  operatorRoot: string,
  slug: string,
  sha: string,
  options?: GhSeam,
): Promise<CommitPullRef[]> {
  const result = await gh(
    operatorRoot,
    ["api", `repos/${slug}/commits/${sha}/pulls`],
    options?.spawnFn,
  );
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
  options?: GhSeam,
): Promise<PullDetails | null> {
  const result = await gh(
    operatorRoot,
    ["api", `repos/${slug}/pulls/${pr}`],
    options?.spawnFn,
  );
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

interface MineResult {
  scannedCommits: number;
  candidates: RevertCandidate[];
}

async function mineReverts(input: {
  repoRoot: string;
  slug: string;
  ref: string;
  since: string;
  gh?: GhSeam;
}): Promise<MineResult> {
  // STEP 2. `--no-merges` is deliberately NOT passed: a merge commit's own
  // subject (`Merge pull request #<n> from …/hotfix/…`) is one of the two
  // pattern-only signals, so dropping merges would drop half the classes.
  const logged = await git(input.repoRoot, [
    "log",
    input.ref,
    `--since=${input.since}`,
    GIT_LOG_FORMAT,
  ]);
  if (!logged.ok) {
    throw new CliError(
      `git log ${input.ref} --since=${input.since} failed: ` +
        logged.stderr.trim(),
    );
  }
  let records: ReturnType<typeof parseGitLogRecords>;
  try {
    records = parseGitLogRecords(logged.stdout);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliError(`git log ${input.ref}: ${error.message}`);
    }
    throw error;
  }

  // STEP 3 + 4: classify, then resolve PR numbers only for what classified.
  const raw: RevertCandidate[] = [];
  for (const record of records) {
    const classified = classifyRevertCommit(record);
    if (classified === null) continue;

    let revertingPr = classified.mergePr;
    let revertingPrMergedAt: string | null = null;
    if (revertingPr === null) {
      const pulls = await ghCommitPulls(
        input.repoRoot,
        input.slug,
        classified.sha,
        input.gh,
      );
      const picked = pickCommitPull(pulls);
      revertingPr = picked?.number ?? null;
      revertingPrMergedAt = picked?.mergedAt ?? null;
    }

    let revertedPr = classified.branchPr;
    if (revertedPr === null && classified.revertedSha !== null) {
      const pulls = await ghCommitPulls(
        input.repoRoot,
        input.slug,
        classified.revertedSha,
        input.gh,
      );
      revertedPr = pickCommitPull(pulls)?.number ?? null;
    }

    raw.push({
      revertCommitSha: classified.sha,
      revertCommittedAtSec: classified.committedAtSec,
      revertSubject: classified.subject,
      revertBody: classified.body,
      confidence: classified.confidence,
      revertingPr,
      revertingPrMergedAt,
      revertedPr,
      revertedPrTitle: null,
      revertedPrMergedAt: null,
      revertedBaseSha: null,
      revertedHeadSha: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      collapsedCommits: 1,
    });
  }

  // STEP 5: the two filters plus the deterministic order, all pure. Run
  // BEFORE enrichment so the collapsed duplicates cost no gh calls.
  const selected = selectRevertCandidates(raw);

  // STEP 6: enrich. The commit-pulls endpoint returns additions, deletions
  // and changed_files as NULL (verified), so the size and the replay range
  // can only come from this second call. Cached by PR number because one PR
  // is frequently both sides of neighbouring entries.
  const cache = new Map<number, PullDetails | null>();
  const details = async (pr: number): Promise<PullDetails | null> => {
    const hit = cache.get(pr);
    if (hit !== undefined) return hit;
    const fetched = await ghPullDetails(
      input.repoRoot,
      input.slug,
      pr,
      input.gh,
    );
    cache.set(pr, fetched);
    return fetched;
  };
  const enriched: RevertCandidate[] = [];
  for (const candidate of selected) {
    const next = { ...candidate };
    if (next.revertedPr !== null) {
      const pull = await details(next.revertedPr);
      if (pull !== null) {
        next.revertedPrTitle = pull.title;
        next.revertedPrMergedAt = pull.mergedAt;
        next.revertedBaseSha = pull.baseSha;
        next.revertedHeadSha = pull.headSha;
        next.additions = pull.additions;
        next.deletions = pull.deletions;
        next.changedFiles = pull.changedFiles;
      }
    }
    // The reverting side needs only its merge stamp, and body-linked entries
    // already carry it from the commit-pulls response — so this call is made
    // ONLY for the pattern-only entries whose number came from a merge
    // subject and therefore never touched the API.
    if (next.revertingPr !== null && next.revertingPrMergedAt === null) {
      next.revertingPrMergedAt =
        (await details(next.revertingPr))?.mergedAt ?? null;
    }
    enriched.push(next);
  }
  return { scannedCommits: records.length, candidates: enriched };
}

export async function revertsCommand(options: CliOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(options.repo);
  const slug = await resolveRepoSlug(repoRoot);
  const ref = await resolveDefaultBranchRef(repoRoot);
  const since = options.since ?? DEFAULT_REVERTS_SINCE;
  log(`reverts: scanning ${slug} ${ref} since "${since}" (read-only, $0)`);

  const mined = await mineReverts({ repoRoot, slug, ref, since });

  // An empty result is a valid state of the world (this repo reverted
  // nothing in the window), not an error: note it on stderr, leave stdout
  // clean, exit 0.
  if (mined.candidates.length === 0) {
    log(
      `no revert or hotfix candidates on ${ref} since "${since}" ` +
        `(${mined.scannedCommits} commit(s) scanned) — widen the window with ` +
        "--since",
    );
    return 0;
  }

  const markdown = renderRevertsArtifact({
    repoSlug: slug,
    ref,
    since,
    scannedCommits: mined.scannedCommits,
    candidates: mined.candidates,
  });
  if (options.out) {
    const outPath = path.resolve(options.out);
    await Bun.write(outPath, markdown);
    log(
      `reverts: wrote ${outPath} (${mined.candidates.length} candidate(s) ` +
        `from ${mined.scannedCommits} commit(s))`,
    );
    return 0;
  }
  // The markdown IS this command's product, and stdout is the one clean
  // channel (everything human-facing goes to stderr), so it can be piped or
  // redirected without the notes riding along.
  process.stdout.write(markdown);
  return 0;
}
