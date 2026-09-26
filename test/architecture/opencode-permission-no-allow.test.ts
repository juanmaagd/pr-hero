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
// Call-SHAPE tokens, not whitespace-sensitive multi-line literals: a reformat
// (biome, or a wrapped argument list) must never flip this guard, so the
// pattern matches across the field name and its literal value regardless of
// intervening whitespace or line breaks.

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

// Matches `reply: "once"` / `response: 'always'` etc. — the two SDK field
// names that carry this vocabulary — across any whitespace/newline, so a
// reformatted call site still trips it.
const ALLOW_LIKE_REPLY = /\b(reply|response)\s*:\s*["'](once|always)["']/;

describe("no src/ code ever answers an OpenCode permission request with allow (#157, provider_free)", () => {
  test("no reply/response literal in src/ is 'once' or 'always'", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of getAllTsFiles(SRC_DIR)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim().startsWith("//")) continue;
        if (ALLOW_LIKE_REPLY.test(line)) {
          offenders.push({ file, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // A pure absence check proves nothing about whether the pattern CAN match
  // at all — this pins the regex itself against both SDK literals, so a
  // typo in ALLOW_LIKE_REPLY above cannot silently turn the test above into
  // a vacuous pass.
  test("the guard's own pattern actually matches both allow-like literals", () => {
    expect(ALLOW_LIKE_REPLY.test('reply: "once"')).toBe(true);
    expect(ALLOW_LIKE_REPLY.test("reply: 'always'")).toBe(true);
    expect(ALLOW_LIKE_REPLY.test('response: "always"')).toBe(true);
    expect(ALLOW_LIKE_REPLY.test('reply: "reject"')).toBe(false);
  });
});
