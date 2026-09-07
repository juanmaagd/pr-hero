// The `.prheroignore` dialect: gitignore syntax, translated to Bun.Glob and
// matched with per-RULE last-match-wins. Pure and offline-testable — this
// module never reads a file or shells out; callers hand it text.
//
// Every deviation from git's own gitignore(5) is deliberate and named at the
// point it happens, never silent: this repo matches a FINITE DIFF FILE LIST,
// not a tree walk, so some of git's own tree-walk optimizations (and their
// side effects) do not apply here and are not reproduced.

const FILE_NAME = ".prheroignore";

export interface IgnoreRule {
  // The source line, after leading `!`/negation removal and trailing
  // insignificant-whitespace stripping — but otherwise VERBATIM, escape
  // backslashes included. Provenance prints THIS, never the emitted globs:
  // a user re-negating a builtin (`!bun.lock`) then textually mirrors the
  // builtin line it negates (`bun.lock`), which is only true if neither
  // side has been further transformed.
  pattern: string;
  negated: boolean;
  // Bun.Glob-ready translations of `pattern`. The rule fires if ANY of
  // these match — that "any" is an OR WITHIN one rule's own dual emission
  // (e.g. the bare form and the directory-contents form), never the
  // last-match-wins decision ACROSS rules. See compileIgnoreRules.
  globs: string[];
  source: "builtin" | "user";
  // 1-based. Builtins have no line — there is no file for them to be a
  // line OF.
  line?: number;
}

// Thrown by parseIgnoreFile before any matching or spend happens. The file
// name is fixed to ".prheroignore" because that is the only file this
// dialect is ever asked to parse in this codebase; a caller that resolves a
// different physical path (e.g. a base-ref blob) is expected to catch and
// re-wrap with that context.
export class IgnoreFileError extends Error {
  readonly file: string;
  readonly line: number;
  readonly text: string;

  constructor(file: string, line: number, text: string, reason: string) {
    super(
      `${file}:${line}: ${reason} — offending line: ${JSON.stringify(text)}`,
    );
    this.name = "IgnoreFileError";
    this.file = file;
    this.line = line;
    this.text = text;
  }
}

// The 9 shipped exclusions, as gitignore LINES — not hand-written globs.
// Feeding these through the SAME parser a user's own file goes through
// means a user's `!bun.lock` textually mirrors the builtin line it negates,
// and it means the dual-emission behavior (see translatePattern) applies to
// the defaults too: `bun.lock` now ALSO matches a directory literally named
// `bun.lock`, a benign superset of the old hand-written `**/bun.lock`.
export const BUILTIN_IGNORE_LINES: string[] = [
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.snap",
];

export const BUILTIN_IGNORE_RULES: IgnoreRule[] = parseIgnoreFile(
  BUILTIN_IGNORE_LINES.join("\n"),
  "builtin",
);

export function parseIgnoreFile(
  text: string,
  source: IgnoreRule["source"],
): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i] ?? "";
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (raw.length === 0) continue; // blank line: no rule, not an error
    if (raw[0] === "#") continue; // unescaped comment marker: whole line skipped

    let negated = false;
    let working: string;
    if (raw[0] === "!") {
      negated = true;
      working = raw.slice(1);
    } else {
      // `\!` and `\#` (and every other backslash pair) pass through
      // UNTOUCHED here — Bun.Glob's own escape handling resolves them at
      // match time. Verified directly: Bun.Glob("\\!foo").match("!foo")
      // and Bun.Glob("\\#foo").match("#foo") are both true, so there is
      // nothing for this parser to unescape on their behalf.
      working = raw;
    }

    working = stripTrailingWhitespace(working);

    if (negated && working.length === 0) {
      throw new IgnoreFileError(
        FILE_NAME,
        lineNo,
        raw,
        "bare ! (undocumented by gitignore(5)): a negation marker needs a pattern to negate",
      );
    }
    if (working.length === 0) continue; // an all-whitespace line reduces to blank

    if (working === "/") {
      throw new IgnoreFileError(
        FILE_NAME,
        lineNo,
        raw,
        "bare / (undocumented by gitignore(5)): nothing to anchor",
      );
    }

    if (hasTrailingUnescapedBackslash(working)) {
      throw new IgnoreFileError(
        FILE_NAME,
        lineNo,
        raw,
        "trailing unescaped backslash (deliberately narrower than gitignore(5), " +
          "which leaves this case undefined; Bun.Glob itself does not throw for " +
          "one either — it silently matches nothing — so pr-hero throws instead " +
          "of letting a misconfigured rule become a silent no-op)",
      );
    }

    rules.push({
      pattern: working,
      negated,
      globs: translatePattern(working),
      source,
      line: source === "user" ? lineNo : undefined,
    });
  }
  return rules;
}

// Removes trailing spaces/tabs, UNLESS the last one is backslash-escaped —
// in which case only the ESCAPING backslash is dropped and stripping stops;
// the whitespace character itself survives as a real, literal trailing
// character (no further unescaping needed: a bare trailing space is not a
// special glob character, so Bun.Glob matches it literally either way).
function stripTrailingWhitespace(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    let backslashes = 0;
    let i = end - 2;
    while (i >= 0 && line[i] === "\\") {
      backslashes++;
      i--;
    }
    if (backslashes % 2 === 1) {
      return line.slice(0, end - 2) + line.slice(end - 1);
    }
    end--;
  }
  return line.slice(0, end);
}

function hasTrailingUnescapedBackslash(line: string): boolean {
  if (!line.endsWith("\\")) return false;
  let count = 0;
  let i = line.length - 1;
  while (i >= 0 && line[i] === "\\") {
    count++;
    i--;
  }
  return count % 2 === 1;
}

// The anchoring/trailing-slash matrix. A pattern is anchored IFF a leading
// OR interior slash remains once the TRAILING slash — a directory-only
// marker, not an anchor — has been set aside. This is git's own distinction
// (gitignore(5)): `frotz/` matches a directory named `frotz` anywhere,
// while `doc/frotz/` matches only `doc/frotz`, because the interior slash
// in the second pattern anchors it to the repo root and the trailing slash
// in NEITHER pattern does that job.
//
// The "ONLY" rows are load-bearing, not a stylistic choice: a trailing
// slash means directory-only, so ALSO emitting the bare form would wrongly
// match a same-named FILE (verified: `build/` must not match the file
// `src/build`). Conversely the no-trailing-slash rows dual-emit on purpose:
// `foo/bar` alone does NOT cover the directory's own contents (verified:
// Bun.Glob("foo/bar").match("foo/bar/x.ts") is false), so the `/**` form is
// a real gap, not redundant.
function translatePattern(pattern: string): string[] {
  const trailingSlash = pattern.endsWith("/");
  const body = trailingSlash ? pattern.slice(0, -1) : pattern;
  const anchored = body.includes("/");
  const leadingSlash = body.startsWith("/");
  const core = escapeBraces(leadingSlash ? body.slice(1) : body);
  if (anchored) {
    return trailingSlash ? [`${core}/**`] : [core, `${core}/**`];
  }
  return trailingSlash ? [`**/${core}/**`] : [`**/${core}`, `**/${core}/**`];
}

// gitignore has no brace syntax — `{`/`}` are ordinary literal characters
// there. Bun.Glob, however, reads `{a,b}` as ALTERNATION (verified directly:
// Bun.Glob("{a,b}.md").match("{a,b}.md") is false and
// Bun.Glob("{a,b}.md").match("a.md") is true — the opposite of a faithful
// gitignore translation). Any brace not already preceded by the user's own
// backslash gets one inserted here, or a `.prheroignore` line containing a
// real brace would silently change which files are ignored the moment it
// reached Bun.Glob.
function escapeBraces(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      out += c + pattern[i + 1];
      i++;
      continue;
    }
    out += c === "{" || c === "}" ? `\\${c}` : c;
  }
  return out;
}

export interface IgnoreMatcher {
  // undefined means KEEP (nothing matched, or the last match was negated).
  match(path: string): IgnoreRule | undefined;
}

// Compiles rules into a matcher that decides per PATH by walking every rule
// IN ORDER and remembering only the LAST one that fired. This is the reason
// the three duplicated `map(new Bun.Glob) -> .some()` loops this module's
// consumer used to run had to be consolidated rather than merely renamed:
// `.some()` over a flat glob list has no notion of order or polarity, so it
// cannot express "the last matching RULE wins" — it can only express "did
// ANY glob match", which gives the same answer regardless of rule order and
// therefore cannot support negation correctly (see the order-swap test in
// test/ignore-file.test.ts, which is the only test that actually
// distinguishes this from a `.some()`-based implementation).
//
// A rule's OWN glob list is still matched with an inner "any" — that is a
// different axis (one rule's dual emission, e.g. bare-form OR
// contents-form), not the cross-rule ordering this function exists to get
// right.
export function compileIgnoreRules(
  rules: readonly IgnoreRule[],
): IgnoreMatcher {
  const compiled = rules.map((rule) => ({
    rule,
    globs: rule.globs.map((pattern) => new Bun.Glob(pattern)),
  }));
  return {
    match(path: string): IgnoreRule | undefined {
      let winner: IgnoreRule | undefined;
      for (const { rule, globs } of compiled) {
        if (globs.some((glob) => glob.match(path))) {
          winner = rule.negated ? undefined : rule;
        }
      }
      return winner;
    },
  };
}

// `git ls-tree --full-tree <sha> -- .prheroignore`, parsed. Callers use this
// to discriminate "absent at this ref" (normal, defaults apply) from
// "present but not a plain file" (a hazard: a root SYMLINK commits as mode
// `120000 blob <sha>`, and `cat-file blob` on it returns the link TARGET —
// e.g. `/etc/passwd` — which would then be parsed as ignore patterns if the
// mode were not checked). Only `100644`/`100755` are accepted; `120000`
// (symlink), `040000` (tree/submodule-as-directory) and `160000` (gitlink)
// are all rejected.
export function parseIgnoreLsTree(
  stdout: string,
):
  | { kind: "absent" }
  | { kind: "blob"; sha: string }
  | { kind: "reject"; mode: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { kind: "absent" };
  const tabIndex = trimmed.indexOf("\t");
  const meta = tabIndex === -1 ? trimmed : trimmed.slice(0, tabIndex);
  const [mode = "", , sha = ""] = meta.split(/\s+/);
  if (mode === "100644" || mode === "100755") return { kind: "blob", sha };
  return { kind: "reject", mode };
}
