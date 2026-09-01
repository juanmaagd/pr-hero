// Resolvability of a finding's evidence, as a pure decision.
//
// `proof_refs` is what makes a verdict auditable, and until #152 nothing
// checked that the paths it names exist. A refuter returned
// `["src/index.ts:7-20", "package.json:15-20"]` against a three-file repo
// containing neither — with `read/grep/glob` all available, so not a tool
// failure — and that citation sailed through schema validation, dedupe, tier
// derivation and the renderer to reach a human looking exactly like a verified
// one. Evidence that cannot be resolved is not weaker evidence; it is NO
// evidence wearing the shape of some.
//
// This module is the pure half on purpose: it never touches the filesystem.
// The reviewed tree arrives as an injected predicate, which keeps drafts.ts
// pure, keeps the offline suite offline, and makes every rule below testable
// without a repo.

// The shape the prompts mandate — `path:line`, stated in
// `prompts/default/review-refuter.md` and in every hunter's output contract.
// Everything here parses AROUND that contract rather than enforcing its
// spelling: the question is only ever "which path does this ref name".

const ESCAPING_SEGMENT = "..";

// The path spellings a ref could legitimately mean, in the order to try them.
// Empty means the ref names nothing that could live inside the reviewed tree,
// which is itself an unresolved verdict — never a reason to skip the ref.
export function proofRefCandidates(ref: string): string[] {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return [];
  // Everything before the FIRST colon. `src/a.ts:12-20` and
  // `src/a.ts:12 (the guard)` both reduce to the same path, and a line range
  // is deliberately not checked here — path existence is the cheap,
  // high-value first cut (#152); a range past EOF is the harder half.
  const colon = trimmed.indexOf(":");
  const raw = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
  const normalized = raw.replace(/^\.\//, "");
  if (normalized.length === 0) return [];
  // Absolute, home-relative and escaping refs cannot be answered by "does the
  // reviewed tree contain this", so they resolve to nothing rather than being
  // probed outside the worktree — the resolver must never be handed a path
  // that leaves the tree it was built for.
  if (normalized.startsWith("/") || normalized.startsWith("~")) return [];
  if (normalized.split("/").includes(ESCAPING_SEGMENT)) return [];
  const candidates = [normalized];
  // `a/` and `b/` are git diff notation a model copies out of the patch — and
  // `a/` is also a perfectly legal directory name. Offering BOTH spellings
  // lets the tree decide instead of this parser guessing, so a repo with a
  // real top-level `a/` is never rejected for a spelling it owns.
  const stripped = normalized.replace(/^[ab]\//, "");
  if (stripped !== normalized && stripped.length > 0) candidates.push(stripped);
  return candidates;
}

// Every path the patch names, both sides. A file the PR deletes is gone from
// the worktree yet fully readable in the diff, so a hunter can cite it
// honestly; the same holds for the `rename from` side. Treating those as
// fabrication would be a false accusation, so the reviewed target is the
// worktree AND the patch.
//
// Deliberately NOT `changedPathsFromDiff` (pipeline.ts), which skips
// deletions on purpose: that function answers "what changed, for trigger
// evaluation", and a deleted file cannot trigger a parity hunter. This one
// answers "what was citable", which is a different question with a different
// right answer.
export function pathsNamedInDiff(patch: string): Set<string> {
  const named = new Set<string>();
  for (const line of patch.split("\n")) {
    let candidate: string | undefined;
    if (line.startsWith("+++ b/")) candidate = line.slice("+++ b/".length);
    else if (line.startsWith("--- a/")) candidate = line.slice("--- a/".length);
    else if (line.startsWith("rename to "))
      candidate = line.slice("rename to ".length);
    else if (line.startsWith("rename from "))
      candidate = line.slice("rename from ".length);
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || trimmed === "/dev/null") continue;
    named.add(trimmed);
  }
  return named;
}

// The refs whose evidence cannot be found, returned as the model's ORIGINAL
// text — a reader has to see which citation was the invented one, and the
// parsed path is not what the model wrote.
export function unresolvedProofRefs(
  refs: readonly string[],
  resolves: (path: string) => boolean,
): string[] {
  const unresolved: string[] = [];
  for (const ref of refs) {
    const candidates = proofRefCandidates(ref);
    if (candidates.length === 0 || !candidates.some((c) => resolves(c))) {
      unresolved.push(ref);
    }
  }
  return unresolved;
}
