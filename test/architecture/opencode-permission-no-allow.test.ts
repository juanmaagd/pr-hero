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
// deprecated session-scoped `Permission2.respond`), so a type-level
// restriction of one reply helper cannot see a second call site introduced
// later. A source scan covers every call site in `src/` by construction.
//
// WHY the TypeScript AST and not a regex. Two regex versions of this guard
// shipped and both had blind spots a review found: the first tested each
// line alone, so `reply:` and `"once"` on separate lines passed; the second
// blanked comments with regexes that did not know about strings, so a `//`
// inside a URL string blanked the rest of its line, and the `/*` inside the
// string "src/**" opened a pseudo-comment that hid fifteen lines of real code
// in src/ci/review-risk.ts. The parser knows what is a comment, a string and
// a property; formatting, comments and string contents cannot fool it.
//
// Two rules, one per failure shape:
//   1. No `reply` / `response` property anywhere in src/ is the literal
//      "once" or "always".
//   2. Every `<...>.permission.reply(...)` / `.respond(...)` call passes an
//      object literal whose `reply` / `response` is the literal "reject" — so
//      an allow value arriving through a variable or a computed expression
//      (`reply: answer`) is flagged too, not just a literal one. The object
//      must also be FULLY verifiable: an allowlist of shapes, not a list of
//      known tricks. Only plain `key: value` / shorthand entries with plain
//      names, exactly one reply/response entry, and no spread, computed key,
//      getter, setter or method — any of which can replace the answer at
//      runtime (`{ reply: "reject", ...override }` sends override's value).
// What it still cannot see: a permission reply made through an alias of the
// client that does not spell `permission.reply`/`permission.respond` at the
// call site. Rule 3 below at least proves the scan sees the one call that
// exists today.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC_DIR = path.join(import.meta.dir, "../../src");
const ALLOW_VALUES = new Set(["once", "always"]);
const REPLY_KEYS = new Set(["reply", "response"]);
const REPLY_METHODS = new Set(["reply", "respond"]);

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

interface Offense {
  line: number;
  reason: string;
}

interface ScanResult {
  offenses: Offense[];
  // Permission reply calls whose value was verified to be "reject" — the
  // non-vacuity count: a scan that finds no such call proves nothing.
  verifiedRejectCalls: number;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function literalText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

// Rule 2's shape allowlist: the literal "reject" when the object is fully
// verifiable, otherwise why it is not. A plain `key: value` or shorthand
// entry with an identifier/string name is the only verifiable member; every
// other member kind can change what the runtime object's answer is.
function verifiedReplyAnswer(
  arg: ts.Expression | undefined,
): { answer: "reject" } | { problem: string } {
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) {
    return { problem: "its argument is not an object literal" };
  }
  const answers: ts.ObjectLiteralElementLike[] = [];
  for (const member of arg.properties) {
    const plain =
      ts.isPropertyAssignment(member) ||
      ts.isShorthandPropertyAssignment(member);
    const name = plain ? propertyName(member.name) : undefined;
    if (!plain || name === undefined) {
      return {
        problem:
          "its object has a spread, computed key, accessor or method, " +
          "which can replace the answer at runtime",
      };
    }
    if (REPLY_KEYS.has(name)) answers.push(member);
  }
  if (answers.length !== 1) {
    return {
      problem: `its object has ${answers.length} reply/response entries, not exactly one`,
    };
  }
  const [answer] = answers;
  const value =
    answer !== undefined && ts.isPropertyAssignment(answer)
      ? literalText(answer.initializer)
      : undefined;
  return value === "reject"
    ? { answer: "reject" }
    : { problem: 'its answer is not the literal "reject"' };
}

// `<anything>.permission.reply(...)` / `.respond(...)`.
function isPermissionReplyCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!REPLY_METHODS.has(callee.name.text)) return false;
  const owner = callee.expression;
  return (
    (ts.isPropertyAccessExpression(owner) &&
      owner.name.text === "permission") ||
    (ts.isIdentifier(owner) && owner.text === "permission")
  );
}

function scanSource(fileName: string, content: string): ScanResult {
  const sf = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const offenses: Offense[] = [];
  let verifiedRejectCalls = 0;
  const lineOf = (node: ts.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    // Rule 1.
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node.name);
      const value = literalText(node.initializer);
      if (key && REPLY_KEYS.has(key) && value && ALLOW_VALUES.has(value)) {
        offenses.push({
          line: lineOf(node),
          reason: `${key}: "${value}" is an allow-like permission answer`,
        });
      }
    }
    // Rule 2.
    if (ts.isCallExpression(node) && isPermissionReplyCall(node)) {
      const verdict = verifiedReplyAnswer(node.arguments[0]);
      if ("answer" in verdict) {
        verifiedRejectCalls += 1;
      } else {
        offenses.push({
          line: lineOf(node),
          reason: `a permission reply/respond call cannot be verified: ${verdict.problem}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { offenses, verifiedRejectCalls };
}

describe("no src/ code ever answers an OpenCode permission request with allow (#157, provider_free)", () => {
  test("src/ holds no allow-like answer, and every permission reply call is a literal reject", () => {
    const offenses: Array<Offense & { file: string }> = [];
    let verifiedRejectCalls = 0;
    for (const file of getAllTsFiles(SRC_DIR)) {
      const result = scanSource(file, fs.readFileSync(file, "utf8"));
      verifiedRejectCalls += result.verifiedRejectCalls;
      for (const offense of result.offenses)
        offenses.push({ file, ...offense });
    }
    expect(offenses).toEqual([]);
    // Rule 3, non-vacuity: the auto-reject handler's own call must be seen.
    // If a refactor renames it out of the `permission.reply` shape, this
    // fails instead of the scan silently checking nothing.
    expect(verifiedRejectCalls).toBeGreaterThanOrEqual(1);
  });

  const offensesIn = (source: string) =>
    scanSource("fixture.ts", source).offenses.length;

  test("flags allow-like literals, on one line or split across lines", () => {
    expect(offensesIn('const a = { reply: "once" };')).toBe(1);
    expect(offensesIn("const a = { response: 'always' };")).toBe(1);
    expect(offensesIn('const a = {\n  reply:\n    "once",\n};')).toBe(1);
    expect(offensesIn("const a = { reply: `always` };")).toBe(1);
  });

  test("ignores allow-like text in comments and inside other strings", () => {
    expect(offensesIn('// reply: "once"\nconst a = 1;')).toBe(0);
    expect(offensesIn('/* reply: "once" */ const a = 1;')).toBe(0);
    expect(offensesIn("const a = 'reply: \"once\"';")).toBe(0);
  });

  // The two blind spots the regex version had, each planted in front of a
  // real offense: the parser must still see the offense behind them.
  test("a // inside a URL string does not hide an allow on the same line", () => {
    expect(offensesIn('respond({ url: "http://x", reply: "once" });')).toBe(1);
  });

  test("a /* inside a string does not open a comment that hides later code", () => {
    const source = [
      'const globs = ["src/**", "docs/**"];',
      'const a = { reply: "always" };',
      'const more = ["**/auth/**"];',
    ].join("\n");
    expect(offensesIn(source)).toBe(1);
  });

  test("a permission reply call must answer with a literal reject", () => {
    expect(
      scanSource(
        "fixture.ts",
        'api.permission.reply({ requestID, reply: "reject" });',
      ),
    ).toEqual({ offenses: [], verifiedRejectCalls: 1 });
    expect(
      offensesIn("api.permission.reply({ requestID, reply: answer });"),
    ).toBe(1);
    expect(offensesIn("api.permission.respond(payload);")).toBe(1);
    expect(offensesIn('api.permission.reply({ reply: "once" });')).toBe(2);
  });

  // Each of these carries a literal "reject" that a first-match check would
  // accept, while the object the runtime actually sends can answer allow.
  test("a reject that a later member can override is not verified", () => {
    const unverifiable = [
      'api.permission.reply({ requestID, reply: "reject", ...override });',
      'api.permission.reply({ reply: "reject", reply: answer });',
      'api.permission.reply({ reply: "reject", [key]: answer });',
      'api.permission.reply({ reply: "reject", get response() { return answer; } });',
      'api.permission.reply({ reply: "reject", response: answer });',
      "api.permission.reply({ reply });",
    ];
    for (const source of unverifiable) {
      expect(scanSource("fixture.ts", source)).toMatchObject({
        verifiedRejectCalls: 0,
      });
      expect(offensesIn(source)).toBeGreaterThanOrEqual(1);
    }
  });
});
