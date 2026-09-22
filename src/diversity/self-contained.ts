import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+["']\.\.\/deep-review/,
  /from\s+["']deep-review/,
  /require\(["']\.\.\/deep-review/,
  /require\(["']deep-review/,
  /file:\.\.\/\.\.\/deep-review/,
];

const FORBIDDEN_ABSOLUTE_LAB =
  /(?:^|["'`])\/(?:Users\/[^"'`]+|tmp\/[^"'`]+)?deep-review\//;

export interface SelfContainedReport {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

function collectTsFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

// A lint over the diversity SOURCE TREE, not a runtime capability: it reads
// src/diversity/**/*.ts off disk and rejects sibling-lab imports. That has
// meaning only against a real checkout, so the root is a REQUIRED argument
// and the only caller (test/diversity/self-contained.test.ts) supplies it.
// It used to default to `path.join(import.meta.dir)`, which is /$bunfs/root
// in a compiled binary — a virtual path readdirSync cannot walk. That is the
// exact defect class test/packaging.test.ts pins, and the pin caught this on
// arrival; see test/architecture/import-boundaries.test.ts for the same
// source-tree lint deriving its root from the TEST's location instead.
export function assertDiversityGraphSelfContained(
  diversityRoot: string,
): SelfContainedReport {
  const violations: string[] = [];
  for (const file of collectTsFiles(diversityRoot)) {
    const content = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${path.basename(file)}: forbidden import ${pattern}`);
      }
    }
    if (FORBIDDEN_ABSOLUTE_LAB.test(content)) {
      violations.push(`${path.basename(file)}: absolute lab path reference`);
    }
    for (const match of content.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (
        specifier.startsWith("../deep-review") ||
        specifier.includes("deep-review/")
      ) {
        violations.push(`${path.basename(file)}: sibling import ${specifier}`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
