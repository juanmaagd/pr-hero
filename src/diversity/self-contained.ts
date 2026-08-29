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

export function assertDiversityGraphSelfContained(
  diversityRoot = path.join(import.meta.dir),
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
