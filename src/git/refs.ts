// Pure git/ref helpers: commit-id shape, remote-HEAD parsing, the github web
// url derivation, base-ref precedence, and the small message/formatting
// helpers that read on top of them. None of this touches the filesystem, a
// subprocess, or the network — every impure git call that FEEDS these lives
// in git.ts.
//
// C1 git-layering slice: extracted out of review/preflight.ts, which
// imported these by value into git.ts — the bottom layer importing a
// review-domain module. review/preflight.ts still re-exports every symbol
// below for the ~55 existing consumers (see the re-export note there); only
// git.ts was repointed at this file in that slice.

import type { BaseRefResolution } from "#review/preflight";

// The LAST resort only. WHY it is not simply "the default": a hardcoded
// default branch silently reviews the wrong range on every repo that does not
// use `main` — musive's default branch is `dev`, so "main" there is not a
// sensible fallback, it is a wrong answer with a plausible face. See
// resolveBaseRef for the order that reaches this constant.
export const DEFAULT_BASE_REF = "main";

// `git symbolic-ref refs/remotes/origin/HEAD` answers with the full ref name
// (`refs/remotes/origin/dev`); everything downstream wants the branch. Split
// out as its own function because the shell can only hand it a string, and a
// prefix strip that is wrong by one character reviews a ref nobody named.
// Returns undefined for anything that is not that shape — including the empty
// output of a repo whose origin/HEAD was never set, which is not an error.
export function parseRemoteHead(raw: string): string | undefined {
  const trimmed = raw.trim();
  const prefix = "refs/remotes/origin/";
  if (!trimmed.startsWith(prefix)) return undefined;
  const branch = trimmed.slice(prefix.length);
  return branch.length > 0 ? branch : undefined;
}

// The repository's web URL, derived from a git remote instead of asked of
// `gh`. WHY it exists next to pr/pr.ts's ghRepoWebUrl rather than replacing it:
// ghRepoWebUrl is one `gh repo view` process per call and used to live ONLY
// inside the `--post` branch, so every run without --post had no web URL and
// the terminal could not print a single clickable link. The remote is already
// on disk — free, offline, no API — which is what makes a link affordable on
// EVERY run. Posting keeps ghRepoWebUrl: it is the authority GitHub itself
// answers with (renames, transfers, forks), and the comment bodies it feeds
// are published artifacts, not a terminal nicety.
//
// The three shapes a github remote actually takes, all normalised to the same
// canonical https form: SCP-style `git@github.com:owner/repo(.git)`,
// `https://github.com/owner/repo(.git)(/)`, and `ssh://git@github.com/owner/
// repo(.git)`. ANYTHING else — a non-github host, an enterprise host, a
// missing remote, an owner/repo that does not parse — returns undefined, and
// the caller degrades to a plain `path:line`. A GUESSED url is strictly worse
// than no url: a 404 teaches the reader to stop trusting every link in the
// block (the same honesty rule as cli.ts's "repo web url unavailable:
// posting plain locations").
const GITHUB_HOST = "github.com";

export function repoWebUrlFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return undefined;
  // SCP syntax first: it is NOT a URL (no scheme), so `new URL` rejects it —
  // and it is the shape a cloned-over-ssh checkout carries by default.
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  let host: string;
  let repoPath: string;
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  }
  if (host.toLowerCase() !== GITHUB_HOST) return undefined;
  const slug = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  // Exactly owner/repo. A deeper path is not a repository root, and building
  // a blob url on top of one produces a link that resolves to nothing.
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) return undefined;
  return `https://${GITHUB_HOST}/${slug}`;
}

// WHY this order, and WHY it is a function rather than a default: the base ref
// decides WHICH range gets reviewed, and a hardcoded "main" is silently wrong
// on any repo that does not use it (musive is on `dev`). So the explicit flag
// wins, then the repo's own recorded choice, then what the remote actually
// says its default branch is, and only then the historical literal. The git
// call that produces `remoteHead` lives in the shell; this stays pure so every
// branch of the precedence is tested without a repo.
export function resolveBaseRef(input: {
  flag?: string | undefined;
  configDefaultBase?: string | undefined;
  remoteHead?: string | undefined;
}): BaseRefResolution {
  if (input.flag) return { ref: input.flag, source: "flag" };
  if (input.configDefaultBase) {
    return { ref: input.configDefaultBase, source: "config" };
  }
  if (input.remoteHead) return { ref: input.remoteHead, source: "remote" };
  return { ref: DEFAULT_BASE_REF, source: "fallback" };
}

// The already-merged branch, spelled out. This is not a rare edge: reviewing a
// branch that has already landed is exactly what someone does when they want
// to see what the reviewer would have said, and "empty diff" alone reads as a
// bug in the tool rather than as the true answer.
export function headContainedInBaseMessage(
  baseRef: string,
  headRef: string,
): string {
  return (
    `the merge base of ${baseRef} and ${headRef} IS ${headRef}: head is ` +
    "already contained in base; there is nothing this branch adds. If the " +
    "branch has already been merged, review it against its own parent (" +
    "--base <the-commit-before-it>) or pass --two-dot to diff the literal " +
    "two-point range."
  );
}

// Enough paths to recognise the diff, never a wall of them: a lockfile-only
// PR is the common case and a hundred-line list helps nobody.
export function listPaths(paths: string[], limit = 5): string {
  if (paths.length <= limit) return paths.join(", ");
  return `${paths.slice(0, limit).join(", ")}, +${paths.length - limit} more`;
}

// A full 40-hex commit id and nothing else. WHY it is enforced this hard: an
// abbreviated head sha once made a COMPLETED three-replicate arm — $29.15
// already spent — unscoreable, because nothing downstream could match the
// recorded run to the tree it reviewed. Refs are canonicalized before they
// are written anywhere.
export function isFullCommitId(candidate: string): boolean {
  return /^[0-9a-f]{40}$/.test(candidate.trim());
}
