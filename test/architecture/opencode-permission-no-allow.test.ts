// Free-tier gateway fix (2026-09-26). The auto-reject handler
// (opencode-client.ts's "permission.asked" case) exists so pr-hero never
// leaves an OpenCode permission prompt unanswered — see the #157 WHY in
// src/transports/opencode-server.ts. It is load-bearing for a `provider_free`
// route's isolation (FREE_TIER_GATEWAY_TOOLS): a granted "ask" that pr-hero
// ever answered with anything but a refusal would let a denied tool actually
// execute.
//
// The SDK types the reply value as "once" | "always" | "reject"
// (@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts, `Permission.reply` and the
// deprecated session-scoped `Permission2.respond`'s "once" | "always" |
// "reject"), so a type-level restriction of the reply helper can only narrow
// ONE call site — it cannot see a second helper introduced later, or a call
// against the deprecated `respond` shape. A source scan is the enforceable
// form here: it covers every call site in `src/` by construction, the same
// way this directory's other architecture tests already enforce
// call-shape invariants tools/tsc cannot (review-shell-invariants.test.ts).
//
// The pattern's `\s*` already spans newlines (JS `\s` includes `\n`), so it
// is applied to each file's FULL content rather than line-by-line — a
// reformat (biome, or a wrapped argument list) that splits `reply:` from
// its value across lines still trips it. Comments are blanked out first
// (see `blankComments`) so a literal mentioned inside one is not flagged.
//
// What this guard does NOT catch: an allow value that reaches `reply`/
// `response` through a variable or computed expression (`reply: answer`,
// `respond({ response: getVerdict() })`) rather than a literal `"once"` /
// `"always"` token. It is a lexical net over literals, not a proof that no
// call site can ever allow — a pass means "no literal allow found", not
// "provably safe".

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(import.meta.dir, "../../src");

function getAllTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// Matches `reply: "once"` / `response: 'always'` etc. across any
// whitespace, INCLUDING a line break between the field name, the colon, and
// the literal — `\s` already includes `\n`. Global so a single scan can
// report every offender in a file, not just the first.
const ALLOW_LIKE_REPLY = /\b(reply|response)\s*:\s*["'](once|always)["']/g;

// Blanks `//` line comments and `/* */` block comments to spaces, keeping
// every newline in place so (a) a literal mentioned inside a comment never
// matches and (b) a line number recovered from a later match index in the
// blanked text is identical to the line number in the original file.
function blankComments(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return withoutBlockComments.replace(/\/\/.*$/gm, blank);
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function findAllowLikeReplies(
  content: string,
): Array<{ line: number; text: string }> {
  const scanned = blankComments(content);
  const offenders: Array<{ line: number; text: string }> = [];
  for (const match of scanned.matchAll(ALLOW_LIKE_REPLY)) {
    offenders.push({
      line: lineNumberAt(scanned, match.index ?? 0),
      // Collapsed to one line for a readable failure message — the
      // OFFENSE (which line it starts on) is what `line` is for.
      text: match[0].replace(/\s+/g, " ").trim(),
    });
  }
  return offenders;
}

describe("no src/ code ever answers an OpenCode permission request with allow (#157, provider_free)", () => {
  test("no reply/response literal in src/ is 'once' or 'always'", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of getAllTsFiles(SRC_DIR)) {
      const content = fs.readFileSync(file, "utf8");
      for (const offender of findAllowLikeReplies(content)) {
        offenders.push({ file, ...offender });
      }
    }
    expect(offenders).toEqual([]);
  });

  // A pure absence check proves nothing about whether the scan CAN match at
  // all — these pin the scan itself against both allow-like literals (on
  // one line and split across two), so a typo in the pattern above cannot
  // silently turn the test above into a vacuous pass.
  test("matches both allow-like literals on a single line", () => {
    expect(findAllowLikeReplies('reply: "once"')).toHaveLength(1);
    expect(findAllowLikeReplies("reply: 'always'")).toHaveLength(1);
    expect(findAllowLikeReplies('response: "always"')).toHaveLength(1);
  });

  test("matches an allow-like literal split across a line break", () => {
    expect(findAllowLikeReplies('reply:\n    "once"')).toHaveLength(1);
    expect(findAllowLikeReplies("response:\n'always'")).toHaveLength(1);
  });

  test("does not match a reject literal", () => {
    expect(findAllowLikeReplies('reply: "reject"')).toHaveLength(0);
  });

  test("does not match an allow literal hidden in a // comment", () => {
    expect(findAllowLikeReplies('// reply: "once"')).toHaveLength(0);
    expect(findAllowLikeReplies('doStuff(); // reply: "always"')).toHaveLength(
      0,
    );
  });

  test("does not match an allow literal hidden in a /* */ comment, including across lines", () => {
    expect(findAllowLikeReplies('/* reply: "once" */')).toHaveLength(0);
    expect(findAllowLikeReplies('/*\n  reply:\n    "once"\n*/')).toHaveLength(
      0,
    );
  });

  // Discrimination. This is the exact defect this file used to carry: the
  // OLD approach split file content on "\n" and tested the (non-global)
  // pattern against each line in isolation, so a literal split across two
  // lines never appeared whole on any single line and was never caught. A
  // future regression back to per-line scanning is caught here immediately,
  // without needing to plant anything in src/.
  test("a per-line scan misses the multi-line split that the full-text scan catches", () => {
    const splitAcrossLines = 'reply:\n    "once"';
    const perLinePattern = /\b(reply|response)\s*:\s*["'](once|always)["']/;
    const perLineHit = splitAcrossLines
      .split("\n")
      .some((line) => perLinePattern.test(line));

    expect(perLineHit).toBe(false);
    expect(findAllowLikeReplies(splitAcrossLines)).toHaveLength(1);
  });
});
