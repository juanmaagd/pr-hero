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
// THE RULE, and the reason it is narrower than "every ref must resolve":
//
//   Only accuse what can be checked. A ref is judged ONLY when it asserts a
//   repo path; anything else is unverifiable, and unverifiable is not the same
//   as false.
//
// That distinction was bought with a failed fixture eval, not reasoned into
// existence. On the first live run under the strict rule a hunter found the
// planted defect perfectly, cited four real `path:line` refs — and added a
// fifth quoting the gotcha it had been handed:
//
//   "gotcha: Volume values are 0-1 gain fractions everywhere in this codebase"
//
// The strict rule called that fabrication, rejected the draft, burned the
// retry and lost BOTH hunters: a correct finding destroyed over a citation
// style the prompts never forbade. Prose, gotcha quotes and hunk labels are
// now out of scope; `src/index.ts:7-20` — #152's own case — still is not.
//
// This module is the pure half on purpose: it never touches the filesystem.
// The reviewed tree arrives as an injected predicate, which keeps drafts.ts
// pure, keeps the offline suite offline, and makes every rule below testable
// without a repo.

const ESCAPING_SEGMENT = "..";

// A `:<digits>` line suffix — the `path:line` form the prompts mandate. It is
// what makes `Makefile:12` a path claim despite having neither slash nor dot.
const LINE_SUFFIX = /:\d/;

// The path spellings a ref could mean, or `undefined` when the ref asserts no
// checkable repo path at all. `undefined` is the ABSTENTION, and it is load
// bearing: it is what separates "the tree says this is false" from "there is
// nothing here to check", and only the former may fail a step.
export function proofRefPathClaim(ref: string): string[] | undefined {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return undefined;
  // Everything before the FIRST colon. `src/a.ts:12-20` and
  // `src/a.ts:12 (the guard)` both reduce to the same path, and a line range
  // is deliberately not checked here — path existence is the cheap,
  // high-value first cut (#152); a range past EOF is the harder half.
  const colon = trimmed.indexOf(":");
  const raw = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
  const normalized = raw.replace(/^\.\//, "");
  if (normalized.length === 0) return undefined;
  // Whitespace inside the path part means the ref is a sentence, not a
  // citation — "the guard in src/player.ts is missing" names a file without
  // claiming to BE one, and a reviewer accusing it of fabrication is wrong.
  if (/\s/.test(normalized)) return undefined;
  // Absolute, home-relative and escaping refs are abstentions rather than
  // failures: "does the reviewed tree contain this" has no answer for a path
  // outside it, and the resolver must never be handed one. An absolute path
  // to a file that really does exist is a spelling problem, not a lie, and
  // burning a whole draft over spelling is what the fixture eval punished.
  if (normalized.startsWith("/") || normalized.startsWith("~"))
    return undefined;
  if (normalized.split("/").includes(ESCAPING_SEGMENT)) return undefined;
  // What makes this a PATH claim rather than prose: a directory separator, a
  // file extension, or an explicit line number. `gotcha` and `diff-hunk#1`
  // have none of the three and are left alone.
  const looksLikePath =
    normalized.includes("/") ||
    normalized.includes(".") ||
    LINE_SUFFIX.test(trimmed.slice(colon === -1 ? trimmed.length : colon));
  if (!looksLikePath) return undefined;
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

// The refs that assert a repo path the tree does not have, returned as the
// model's ORIGINAL text — a reader has to see which citation was the invented
// one, and the parsed path is not what the model wrote. A ref that asserts no
// path is absent from this list: it was never judged.
export function unresolvedProofRefs(
  refs: readonly string[],
  resolves: (path: string) => boolean,
): string[] {
  const unresolved: string[] = [];
  for (const ref of refs) {
    const claim = proofRefPathClaim(ref);
    if (claim === undefined) continue;
    if (!claim.some((candidate) => resolves(candidate))) unresolved.push(ref);
  }
  return unresolved;
}
