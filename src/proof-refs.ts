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
  // What makes this a PATH claim rather than prose: a directory separator or
  // a file extension. `gotcha` and `diff-hunk#1` have neither and are left
  // alone.
  //
  // A `:<digits>` suffix is deliberately NOT a third trigger, though the
  // `path:line` form the prompts mandate has one. It was, and it made
  // `Makefile:12` checkable at the cost of also claiming `line:42`,
  // `confidence:80` and `hunk:3` — plausible things for a model to write
  // beside a real citation, each one enough to reject the whole draft. The two
  // shapes are SYNTACTICALLY INDISTINGUISHABLE, so no sharper regex separates
  // them; for a bareword, "the tree does not have it" is ambiguous between
  // "invented file" and "not a file at all", and a rule that cannot tell those
  // apart has no business accusing either. Abstaining loses the ability to
  // catch a fabricated `Makefile:12`, which is the cheaper half of the trade.
  const looksLikePath = normalized.includes("/") || normalized.includes(".");
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
    // The `diff --git` header is the ONLY line every file gets. A binary file
    // has no `---`/`+++` pair at all — git writes
    // `Binary files a/logo.png and /dev/null differ` instead — so without this
    // a deleted binary is absent from the set AND gone from disk, and citing
    // it is called fabrication. Verified against real `git diff` output, not
    // assumed.
    if (line.startsWith(DIFF_HEADER)) {
      addHeaderPaths(line.slice(DIFF_HEADER.length), named);
      continue;
    }
    let candidate: string | undefined;
    // The quote is optional because git wraps any path containing a space:
    // `--- "a/we ird.ts"`. Matching only the bare spelling left every such
    // file out of an ALLOWLIST, which is the direction that costs findings.
    for (const [prefix, strip] of SIDE_PREFIXES) {
      if (!line.startsWith(prefix)) continue;
      candidate = unwrapPath(line.slice(prefix.length), strip);
      break;
    }
    if (candidate === undefined) continue;
    if (candidate.length === 0 || candidate === "/dev/null") continue;
    named.add(candidate);
  }
  return named;
}

const DIFF_HEADER = "diff --git ";

// Prefix → whether an `a/`/`b/` side marker follows it. `rename to`/`from`
// carry the bare path; the `---`/`+++` pair carries the side marker, either
// spelling of it.
const SIDE_PREFIXES: ReadonlyArray<readonly [string, boolean]> = [
  ["+++ ", true],
  ["--- ", true],
  ["rename to ", false],
  ["rename from ", false],
];

function unwrapPath(raw: string, stripSideMarker: boolean): string {
  const trimmed = raw.trim().replace(/^"/, "").replace(/"$/, "");
  return stripSideMarker ? trimmed.replace(/^[ab]\//, "") : trimmed;
}

// `a/<old> b/<new>`, unpicked leniently ON PURPOSE. A path containing " b/"
// makes the split ambiguous and git quotes any path with spaces, so rather
// than parse git's quoting rules this adds EVERY plausible split: `named` is
// an ALLOWLIST, so an extra entry can only make the rule abstain more, while a
// missing one is what produces a false accusation. The asymmetry is the whole
// design — over-inclusion costs a citation nobody checks, under-inclusion
// costs a correct finding and its whole draft.
function addHeaderPaths(rest: string, named: Set<string>): void {
  // Both spellings of the right-hand side marker: ` b/` bare, ` "b/` quoted.
  for (const marker of [' "b/', " b/"]) {
    for (
      let i = rest.indexOf(marker);
      i !== -1;
      i = rest.indexOf(marker, i + 1)
    ) {
      for (const half of [rest.slice(0, i), rest.slice(i + 1)]) {
        const unwrapped = unwrapPath(half, true);
        if (unwrapped.length > 0 && unwrapped !== "/dev/null") {
          named.add(unwrapped);
        }
      }
    }
  }
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
