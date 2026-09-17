// PR mode's fetch + range resolution (step 4 of reviewPr(), plus the eager
// non-CI `.prheroignore` read from step 1). Relocated out of reviewPr()
// (src/pr/review-pr.ts): identifiers moved onto explicit parameters, control
// flow and WHY comments unchanged.
//
// Two roots run through this module, matching reviewPr()'s own header:
// `operatorRoot` (the eager local ignore read, O-8) and `gitDirOwner` (the
// fetch and every object-db read below it, W3).

import {
  type GitRunner,
  readBaseRefIgnoreRules,
  resolveCommit,
  resolveDiffFrom,
} from "#git/git";
import { fetchPrRefs } from "#pr/pr";
import type { PrTarget } from "#pr/preflight";
import { assertDistinctRange } from "#review/run";
import type { IgnoreFileReadResult } from "../ignore-read";

// Invariant 7 (O-8): the PR author must never be able to choose which
// `.prheroignore` governs their own review, so this read is ALWAYS
// `operatorRoot` — the operator's own checkout — never `worktreePath` (the
// PR's own tree, which does not even exist yet at the point this runs).
// `readLocal` is injectable so a test can prove which root's rules actually
// come back, rather than only asserting the call site names the right
// symbol. `undefined` under CI on purpose: the CI read instead needs the
// RESOLVED base sha (see resolveBaseRefIgnore below), which is not known
// yet here.
export async function resolveEagerLocalIgnore(params: {
  isCi: boolean;
  operatorRoot: string;
  readLocal: (root: string) => Promise<IgnoreFileReadResult>;
}): Promise<IgnoreFileReadResult | undefined> {
  return params.isCi ? undefined : await params.readLocal(params.operatorRoot);
}

// Invariant 8 (design D1): CI reads the ignore file at the RESOLVED base
// sha, never `target.baseRef`/`target.baseRefName` directly — a merged PR's
// baseRef is a `<sha>^1` EXPRESSION, and only a resolved sha is a valid
// `ls-tree` argument. Non-CI reuses the eager `localIgnore` read above
// rather than re-reading — the same value must decide the dry-run estimate
// and the real run.
export async function resolveBaseRefIgnore(params: {
  isCi: boolean;
  localIgnore: IgnoreFileReadResult | undefined;
  runGit: GitRunner;
  gitDirOwner: string;
  baseSha: string;
}): Promise<IgnoreFileReadResult> {
  return params.isCi
    ? await readBaseRefIgnoreRules(
        params.runGit,
        params.gitDirOwner,
        params.baseSha,
      )
    : // isCi is false on this branch, so `localIgnore` above is defined.
      (params.localIgnore as IgnoreFileReadResult);
}

export interface ResolvedPrFetchAndRange {
  headSha: string;
  baseSha: string;
  diffFromSha: string;
  prIgnore: IgnoreFileReadResult;
  headLabel: string;
}

// Fetch, then canonicalize, then the base-ref `.prheroignore` read. Object-db
// git runs against the git-dir OWNER, not the operator cwd: the worktree is
// registered there (W3).
//
// NOTE (recorded, not fixed — see design's Open Questions): the ignore read
// cannot precede fetchPrRefs, so a lookup failure there burns one CI
// admission attempt already reserved by the caller. A persistent misconfig
// therefore exhausts `ci_max_attempts` into manual-required — the correct
// outcome for a repo-level misconfig, not a reason to reorder a settled CI
// mechanism.
export async function resolvePrFetchAndRange(params: {
  gitDirOwner: string;
  prNumber: number;
  target: PrTarget;
  isCi: boolean;
  localIgnore: IgnoreFileReadResult | undefined;
  runGit: GitRunner;
}): Promise<ResolvedPrFetchAndRange> {
  await fetchPrRefs(
    params.gitDirOwner,
    params.prNumber,
    params.target.baseRefName,
  );
  const headSha = await resolveCommit(
    params.gitDirOwner,
    params.target.headSha,
  );
  // baseRef may be a `<sha>^1` expression (merged PR); rev-parse settles it.
  const baseSha = await resolveCommit(
    params.gitDirOwner,
    params.target.baseRef,
  );
  assertDistinctRange(baseSha, headSha);
  const prIgnore = await resolveBaseRefIgnore({
    isCi: params.isCi,
    localIgnore: params.localIgnore,
    runGit: params.runGit,
    gitDirOwner: params.gitDirOwner,
    baseSha,
  });
  const headLabel = `PR #${params.prNumber} head`;
  const diffFromSha = await resolveDiffFrom(
    params.gitDirOwner,
    false,
    params.target.baseRef,
    headLabel,
    baseSha,
    headSha,
  );
  return { headSha, baseSha, diffFromSha, prIgnore, headLabel };
}
