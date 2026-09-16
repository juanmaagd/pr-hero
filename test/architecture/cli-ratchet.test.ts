// CLI Decomposition S6 (odd/tasks/cli-decomposition.md): the cli.ts size ratchet.
//
// Phase 1 reduced `src/cli.ts` from 7820 lines (122 functions) to 2853 lines (5 functions).
// This ratchet prevents regression:
// 1. Line count ceiling: pinned at current count (2853). It can only ratchet DOWN in Phase 2.
// 2. Function census: cli.ts must ONLY declare the 5 canonical functions (main, runCli,
//    menuCommand, review, reviewPr). All new functions must live in their domain modules.
// 3. Per-function size limit on extracted domain modules: no function exceeds 300 lines.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.join(import.meta.dir, "../..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");

const CANONICAL_CLI_FUNCTIONS = [
  "main",
  "menuCommand",
  "review",
  "reviewPr",
  "runCli",
].sort();

// Line count ceiling as of Phase 1 completion (S5 merged): 2853.
// Phase 2 P2.1 (odd/tasks/cli-decomposition.md) extracted the shared pure
// stages (assertDistinctRange, resolveGotchasPath, selectActiveHunters,
// reviewingLine, buildTelemetry) into src/review/run.ts, ratcheting this
// down to 2799. Later Phase 2 slices ratchet it further.
const CLI_LINE_CEILING = 2799;

const MAX_FUNCTION_LINES = 300;

function topLevelFunctionsInFile(
  filePath: string,
): { name: string; lines: number; start: number; end: number }[] {
  const content = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const functions: {
    name: string;
    lines: number;
    start: number;
    end: number;
  }[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const start = sf.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
      const end = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1;
      functions.push({
        name: stmt.name.text,
        lines: end - start + 1,
        start,
        end,
      });
    }
  }

  return functions;
}

describe("cli.ts size ratchet", () => {
  test(`src/cli.ts does not exceed line ceiling of ${CLI_LINE_CEILING} lines`, () => {
    const content = readFileSync(CLI_PATH, "utf8");
    const lines = content.split("\n");
    // Trailing newline check: lines.length can include an empty trailing line
    const actualLines =
      lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

    expect(
      actualLines,
      `src/cli.ts grew beyond ceiling! Expected <= ${CLI_LINE_CEILING}, got ${actualLines}. New code belongs in domain modules.`,
    ).toBeLessThanOrEqual(CLI_LINE_CEILING);
  });

  test("src/cli.ts declares ONLY the 5 canonical functions", () => {
    const fns = topLevelFunctionsInFile(CLI_PATH);
    const fnNames = fns.map((f) => f.name).sort();

    expect(
      fnNames,
      "src/cli.ts top-level functions must only be main, menuCommand, review, reviewPr, runCli",
    ).toEqual(CANONICAL_CLI_FUNCTIONS);
  });
});

describe("per-function size guard on extracted modules", () => {
  // Extracted modules from Phase 1 slices (S1-S5)
  const EXTRACTED_MODULES = [
    "src/git/git.ts",
    "src/git/identity.ts",
    "src/ui/plan.ts",
    "src/ui/progress.ts",
    "src/pr/status.ts",
    "src/pr/admission.ts",
    "src/review/route-preflight.ts",
  ];

  // Commands extracted in S3
  const commandsDir = path.join(REPO_ROOT, "src/commands");
  const commandFiles = readdirSync(commandsDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/commands/${f}`);

  const allMonitoredModules = [...EXTRACTED_MODULES, ...commandFiles];

  test("no function in extracted modules exceeds 300 lines", () => {
    const oversized: { file: string; name: string; lines: number }[] = [];

    for (const relPath of allMonitoredModules) {
      const fullPath = path.join(REPO_ROOT, relPath);
      const fns = topLevelFunctionsInFile(fullPath);
      for (const fn of fns) {
        if (fn.lines > MAX_FUNCTION_LINES) {
          oversized.push({ file: relPath, name: fn.name, lines: fn.lines });
        }
      }
    }

    expect(
      oversized,
      `Extracted functions must not exceed ${MAX_FUNCTION_LINES} lines: ${JSON.stringify(oversized)}`,
    ).toEqual([]);
  });
});
